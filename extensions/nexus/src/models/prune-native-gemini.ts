import { redact } from "../shared/redact";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "./gemini";
import { inScope, templateIdFor, type PruneConfig } from "./prune-adapter";
import { baseOf, cancelled, checkServedModel, postToPrune, redactDeep } from "./prune-native-shared";
import type { PruneMetadata } from "./prune-receipt";
import type { Provider, StopReason, TurnEvent, TurnMessage, TurnRequest } from "./provider";

// Gemini through Prune (L1-S4b). Live tests on 2026-11-07: POST {base}/chat/completions with an OpenAI-style request
// (tools as function declarations, tool results as `tool` messages) is answered with a Gemini-NATIVE body
// (candidates[].content.parts[], finishReason, usageMetadata, modelVersion) plus prune_metadata. This wrapper sends
// an OpenAI-style request and maps the Gemini-native response, the way gemini.ts does. Same safety rules as
// prune-adapter.ts. Not wired into the registry or optimizer; the lead decides.
//
// Thought signatures: a replayed function call carries its saved signature in the tool_call's
// `extra_content.google.thought_signature`, the place Google's OpenAI-compatibility docs define. That Prune forwards
// the field to Gemini is NOT verified live.

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: unknown };
}
interface GeminiBody {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  promptFeedback?: { blockReason?: string };
  modelVersion?: string;
  prune_metadata?: PruneMetadata;
}

interface OaiToolCall { id: string; type: "function"; function: { name: string; arguments: string }; extra_content?: { google: { thought_signature: string } } }
type OaiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OaiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** OpenAI-style messages with EVERY string redacted: system, user, assistant text, tool arguments and tool results. */
export function toRouteMessages(system: string, messages: readonly TurnMessage[]): OaiMessage[] {
  const out: OaiMessage[] = [];
  if (system.length > 0) out.push({ role: "system", content: redact(system) });
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: redact(m.content) });
    else if (m.role === "assistant") {
      const calls = (m.toolCalls ?? []).map((c): OaiToolCall => {
        const sig = (c.providerMeta as { thoughtSignature?: string } | undefined)?.thoughtSignature;
        return {
          id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(redactDeep(c.args ?? {})) },
          ...(sig ? { extra_content: { google: { thought_signature: sig } } } : {}),
        };
      });
      out.push({ role: "assistant", content: m.content.length > 0 ? redact(m.content) : null, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
    } else out.push({ role: "tool", tool_call_id: m.toolCallId, content: redact(m.content) });
  }
  return out;
}

export function wrapGeminiNative(direct: Provider, cfg: PruneConfig): Provider {
  const url = `${baseOf(cfg)}/chat/completions`;
  let callSeq = 0;                                          // Gemini does not always give function calls an id
  return {
    id: direct.id,
    listModels: key => direct.listModels(key),

    async *turn(req: TurnRequest, providerKey: string): AsyncIterable<TurnEvent> {
      if (!inScope(cfg.scope, req.role)) { yield* direct.turn(req, providerKey); return; }

      const payload = {
        model: req.modelId, messages: toRouteMessages(req.system, req.messages), stream: false,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        ...(req.tools.length > 0 ? { tools: req.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}),
      };
      const out = await postToPrune<GeminiBody>(cfg, url, { authorization: `Bearer ${cfg.apiKey}`, "x-prune-template-id": templateIdFor(req.role) }, payload, req.signal);

      if (out.kind === "cancelled") { yield cancelled(); return; }
      if (out.kind === "blocked") { yield { type: "error", message: out.message }; return; }
      if (out.kind === "unreachable") {
        cfg.onNote?.(`${out.reason}; this call went directly to the provider.`);
        yield* direct.turn(req, providerKey);
        return;
      }

      const body = out.body;
      // modelVersion can differ from the requested id while routed_model is null, so it is only noted, never pinned on.
      const checked = checkServedModel(cfg, req, body.prune_metadata, { value: body.modelVersion, strict: false });
      if (checked.error) { yield { type: "error", message: checked.error }; return; }

      if (body.promptFeedback?.blockReason) { yield { type: "error", message: `Gemini blocked the prompt (${redact(body.promptFeedback.blockReason)})` }; return; }
      const cand = body.candidates?.[0];
      if (!cand) { yield { type: "error", message: "Prune returned no candidates in the Gemini response." }; return; }
      const finish = cand.finishReason;
      if (finish !== "STOP" && finish !== "MAX_TOKENS") { yield { type: "error", message: `Gemini stopped the response (${redact(finish ?? "no finishReason")})` }; return; }

      // Build every event first so a malformed part never leaves a half-emitted turn.
      const events: TurnEvent[] = [];
      let sawTool = false;
      let sawText = false;
      for (const part of cand.content?.parts ?? []) {
        if (part.functionCall) {
          if (!part.functionCall.name) { yield { type: "error", message: "Gemini sent a function call without a name." }; return; }
          sawTool = true;
          events.push({ type: "tool_call", id: part.functionCall.id ?? `prune_gemini_call_${++callSeq}`, name: part.functionCall.name, args: part.functionCall.args ?? {}, ...(part.thoughtSignature ? { providerMeta: { thoughtSignature: part.thoughtSignature } } : {}) });
        } else if (part.text && !part.thought) {
          sawText = true;
          events.push({ type: "text_delta", text: part.text });
        }
      }
      if (!sawText && !sawTool) { yield { type: "error", message: "Gemini returned no text and no tool call." }; return; }

      yield* events;
      const stopReason: StopReason = sawTool ? "tool_use" : finish === "MAX_TOKENS" ? "max_tokens" : "end_turn";
      yield { type: "done", usage: { inputTokens: body.usageMetadata?.promptTokenCount ?? 0, outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0 }, stopReason };
    },
  };
}
