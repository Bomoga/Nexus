import { redact } from "../shared/redact";
import { inScope, templateIdFor, toOpenAiMessages, type PruneConfig } from "./prune-adapter";
import { baseOf, cancelled, checkServedModel, postToPrune } from "./prune-native-anthropic";
import type { PruneMetadata } from "./prune-receipt";
import type { Provider, StopReason, TurnEvent, TurnRequest } from "./provider";

// Gemini through Prune (L1-S4b). Live tests on 2026-11-07: POST {base}/chat/completions with an OpenAI-style request
// (tools as function declarations, tool results as `tool` messages) is answered with a Gemini-NATIVE body
// (candidates[].content.parts[], finishReason, usageMetadata, modelVersion) plus prune_metadata. This wrapper sends
// the OpenAI-style request exactly as prune-adapter.ts does and maps the Gemini-native response, the way gemini.ts
// does. Same safety rules as prune-adapter.ts. Not wired into the registry or optimizer; the lead decides.

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
  prune_metadata?: PruneMetadata;
}

/** Finish reasons that mean the response must not be treated as a normal answer. */
const STOPPED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY", "MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "OTHER"]);

export function wrapGeminiNative(direct: Provider, cfg: PruneConfig): Provider {
  const url = `${baseOf(cfg)}/chat/completions`;
  let callSeq = 0;                                          // Gemini does not always give function calls an id
  return {
    id: direct.id,
    listModels: key => direct.listModels(key),

    async *turn(req: TurnRequest, providerKey: string): AsyncIterable<TurnEvent> {
      if (!inScope(cfg.scope, req.role)) { yield* direct.turn(req, providerKey); return; }

      const payload = {
        model: req.modelId, messages: toOpenAiMessages(req.system, req.messages), stream: false,
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
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
      const checked = checkServedModel(cfg, req, body.prune_metadata);
      if (checked.error) { yield { type: "error", message: checked.error }; return; }

      if (body.promptFeedback?.blockReason) { yield { type: "error", message: `Gemini blocked the prompt (${redact(body.promptFeedback.blockReason)})` }; return; }
      const cand = body.candidates?.[0];
      if (!cand) { yield { type: "error", message: "Prune returned no candidates in the Gemini response." }; return; }
      const finish = cand.finishReason;
      if (finish && STOPPED.has(finish)) { yield { type: "error", message: `Gemini stopped the response (${finish})` }; return; }

      let sawTool = false;
      for (const part of cand.content?.parts ?? []) {
        if (part.functionCall?.name) {
          sawTool = true;
          yield { type: "tool_call", id: part.functionCall.id ?? `prune_gemini_call_${++callSeq}`, name: part.functionCall.name, args: part.functionCall.args ?? {}, ...(part.thoughtSignature ? { providerMeta: { thoughtSignature: part.thoughtSignature } } : {}) };
        } else if (part.text && !part.thought) {
          yield { type: "text_delta", text: part.text };
        }
      }
      const stopReason: StopReason = sawTool ? "tool_use" : finish === "MAX_TOKENS" ? "max_tokens" : "end_turn";
      yield { type: "done", usage: { inputTokens: body.usageMetadata?.promptTokenCount ?? 0, outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0 }, stopReason };
    },
  };
}
