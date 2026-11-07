import { redact } from "../shared/redact";
import { DEFAULT_MAX_TOKENS, toApiMessages } from "./anthropic";
import { inScope, templateIdFor, type PruneConfig } from "./prune-adapter";
import { baseOf, cancelled, checkServedModel, postToPrune, redactDeep } from "./prune-native-shared";
import type { PruneMetadata } from "./prune-receipt";
import type { Provider, StopReason, TurnEvent, TurnRequest } from "./provider";

// Anthropic-native Prune route (L1-S4b). Live tests on 2026-11-07 showed Prune's OpenAI-style /chat/completions cannot
// carry tool calls for Anthropic models, while POST {base}/proxy/anthropic/messages (header x-prune-key, Anthropic
// body, response = a normal Anthropic message plus a top-level `prune_metadata`) does. Same safety rules as
// prune-adapter.ts: model pinned for the agent role (checked on EVERY call, on routed_model and on the response's own
// model field), a Prune-blocked request is an error and is never resent elsewhere, an outage is retried ONCE directly
// against the provider with a note, everything sent is redacted, abort and timeouts honoured. Not wired into the
// registry or optimizer; the lead decides.

export const PRUNE_NATIVE_ANTHROPIC_PATH = "/proxy/anthropic/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

interface MessagesResponse {
  model?: string;
  content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number | null; output_tokens?: number | null };
  prune_metadata?: PruneMetadata;
}

const STOP: Record<string, StopReason | undefined> = { end_turn: "end_turn", stop_sequence: "end_turn", pause_turn: "end_turn", tool_use: "tool_use", max_tokens: "max_tokens" };

/** Wraps an Anthropic provider so in-scope calls go through Prune's Anthropic-native route (tool calls included). */
export function wrapAnthropicNative(direct: Provider, cfg: PruneConfig): Provider {
  const url = `${baseOf(cfg)}${PRUNE_NATIVE_ANTHROPIC_PATH}`;
  return {
    id: direct.id,
    listModels: key => direct.listModels(key),

    async *turn(req: TurnRequest, providerKey: string): AsyncIterable<TurnEvent> {
      if (!inScope(cfg.scope, req.role)) { yield* direct.turn(req, providerKey); return; }

      // Replayed assistant turns carry only {type,id,name,input}: extra keys echoed by the route cause a 400.
      const payload = {
        model: req.modelId, max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS, system: redact(req.system),
        messages: redactDeep(toApiMessages(req.messages)),
        ...(req.tools.length > 0 ? { tools: req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
        stream: false,
      };
      const out = await postToPrune<MessagesResponse>(cfg, url, {
        "x-prune-key": cfg.apiKey, "anthropic-version": ANTHROPIC_VERSION, "x-prune-template-id": templateIdFor(req.role),
      }, payload, req.signal);

      if (out.kind === "cancelled") { yield cancelled(); return; }
      if (out.kind === "blocked") { yield { type: "error", message: out.message }; return; }
      if (out.kind === "unreachable") {
        cfg.onNote?.(`${out.reason}; this call went directly to the provider.`);
        yield* direct.turn(req, providerKey);
        return;
      }

      const body = out.body;
      const checked = checkServedModel(cfg, req, body.prune_metadata, { value: body.model, strict: true });
      if (checked.error) { yield { type: "error", message: checked.error }; return; }

      const stop = body.stop_reason;
      if (!stop) { yield { type: "error", message: "The Anthropic response (via Prune) was not complete." }; return; }
      if (stop === "refusal") { yield { type: "error", message: "the model refused the request" }; return; }
      if (stop === "model_context_window_exceeded") { yield { type: "error", message: "the conversation no longer fits the model's context window" }; return; }
      const stopReason = STOP[stop];
      if (!stopReason) { yield { type: "error", message: `The Anthropic response (via Prune) ended with an unexpected stop_reason (${redact(String(stop)).slice(0, 60)}).` }; return; }

      // Build every event first so a malformed block never leaves a half-emitted turn.
      const events: TurnEvent[] = [];
      let sawTool = false;
      let sawText = false;
      for (const b of body.content ?? []) {
        if (b.type === "text" && b.text) { sawText = true; events.push({ type: "text_delta", text: b.text }); }
        else if (b.type === "tool_use") {
          if (!b.id || !b.name) { yield { type: "error", message: "The Anthropic response (via Prune) had a tool_use block without an id or name." }; return; }
          sawTool = true;
          events.push({ type: "tool_call", id: b.id, name: b.name, args: b.input ?? {} });
        }
      }
      if (!sawText && !sawTool) { yield { type: "error", message: "The Anthropic response (via Prune) had no text and no tool call." }; return; }
      if (stopReason === "tool_use" && !sawTool) { yield { type: "error", message: "The Anthropic response (via Prune) stopped for tool use but contained no tool call." }; return; }

      yield* events;
      yield { type: "done", usage: { inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 }, stopReason };
    },
  };
}
