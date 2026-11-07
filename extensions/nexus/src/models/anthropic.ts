import Anthropic from "@anthropic-ai/sdk";
import type { ModelInfo } from "../contracts";
import { redact } from "../shared/redact";
import { ProviderAuthError, type Provider, type StopReason, type TurnEvent, type TurnMessage, type TurnRequest } from "./provider";

// Anthropic provider on the official TypeScript SDK (PLAN L1-04). The key is a parameter of every call and is
// never stored. Retries are off: a resent 4xx or a replayed half-finished agent turn would double-bill and double-act.

export const DEFAULT_MAX_TOKENS = 8192;

// Structural slice of the SDK we use, so tests inject a fake without the network.
export interface AnthropicModelEntry {
  id: string;
  display_name: string;
  max_input_tokens: number | null;
  lifecycle?: string;
}
export interface AnthropicStreamEvent {
  type: string;
  index?: number;
  message?: { usage?: { input_tokens?: number | null } };
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null };
  usage?: { output_tokens?: number | null; input_tokens?: number | null };
}
export interface AnthropicLike {
  models: { list(): AsyncIterable<AnthropicModelEntry> };
  messages: { create(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AsyncIterable<AnthropicStreamEvent>> };
}
export type ClientFactory = (apiKey: string) => AnthropicLike;

const defaultFactory: ClientFactory = apiKey => new Anthropic({ apiKey, maxRetries: 0 }) as unknown as AnthropicLike;

type ApiContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
interface ApiMessage { role: "user" | "assistant"; content: string | ApiContentBlock[] }

/** Maps Nexus turn messages to the Messages API; consecutive tool results become one user message. */
export function toApiMessages(messages: readonly TurnMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const blocks: ApiContentBlock[] = [];
      if (m.content.length > 0) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      // The API rejects an assistant turn with no content, so an empty one is sent as a placeholder.
      out.push({ role: "assistant", content: blocks.length > 0 ? blocks : [{ type: "text", text: "(no output)" }] });
    } else {
      const block: ApiContentBlock = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every(b => b.type === "tool_result")) last.content.push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

const STOP: Record<string, StopReason | undefined> = { end_turn: "end_turn", stop_sequence: "end_turn", pause_turn: "end_turn", tool_use: "tool_use", max_tokens: "max_tokens" };

function isAuthStatus(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
}

export function createAnthropicProvider(factory: ClientFactory = defaultFactory): Provider {
  return {
    id: "anthropic",

    async listModels(apiKey: string): Promise<ModelInfo[]> {
      const models: ModelInfo[] = [];
      try {
        for await (const m of factory(apiKey).models.list()) {
          if (m.lifecycle === "retired") continue;
          // Every current Claude model supports tool use; the models endpoint has no tool flag to read.
          models.push({ provider: "anthropic", modelId: m.id, displayName: m.display_name, supportsTools: true, ...(m.max_input_tokens ? { contextWindow: m.max_input_tokens } : {}) });
        }
      } catch (e) {
        if (isAuthStatus(e)) throw new ProviderAuthError();
        // No `cause`: the original SDK error can carry request details; only the redacted message travels on.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(redact(e instanceof Error ? e.message : "could not list Anthropic models"));
      }
      return models;
    },

    async *turn(req: TurnRequest, apiKey: string): AsyncIterable<TurnEvent> {
      const usage = { inputTokens: 0, outputTokens: 0 };
      let stopReason: string | null | undefined;
      let sawStop = false;                                      // a stream that ends without a stop signal was cut off
      const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
      try {
        const stream = await factory(apiKey).messages.create({
          model: req.modelId,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: req.system,
          messages: toApiMessages(req.messages),
          tools: req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
          stream: true,
        }, { signal: req.signal });

        for await (const e of stream) {
          if (e.type === "message_start") usage.inputTokens = e.message?.usage?.input_tokens ?? 0;
          else if (e.type === "content_block_start" && e.content_block?.type === "tool_use") {
            toolBlocks.set(e.index ?? 0, { id: e.content_block.id ?? "", name: e.content_block.name ?? "", json: "" });
          } else if (e.type === "content_block_delta") {
            if (e.delta?.type === "text_delta" && e.delta.text) yield { type: "text_delta", text: e.delta.text };
            else if (e.delta?.type === "input_json_delta") {
              const b = toolBlocks.get(e.index ?? 0);
              if (b) b.json += e.delta.partial_json ?? "";
            }
          } else if (e.type === "content_block_stop") {
            const b = toolBlocks.get(e.index ?? 0);
            if (b) {
              toolBlocks.delete(e.index ?? 0);
              let args: unknown;
              try { args = b.json.trim() === "" ? {} : JSON.parse(b.json); } catch {
                yield { type: "error", message: `the model sent malformed arguments for tool ${b.name}` };
                return;
              }
              yield { type: "tool_call", id: b.id, name: b.name, args };
            }
          } else if (e.type === "message_delta") {
            stopReason = e.delta?.stop_reason ?? stopReason;
            if (e.delta?.stop_reason) sawStop = true;
            usage.outputTokens = e.usage?.output_tokens ?? usage.outputTokens;
          } else if (e.type === "message_stop") {
            sawStop = true;
          }
        }
      } catch (e) {
        if (req.signal?.aborted) {
          yield { type: "done", usage, stopReason: "cancelled" };
          return;
        }
        yield { type: "error", message: redact(e instanceof Error ? e.message : "Anthropic request failed") };
        return;
      }

      if (!sawStop || toolBlocks.size > 0) {
        yield { type: "error", message: "The Anthropic response ended before it was complete." };
        return;
      }
      if (stopReason === "refusal") { yield { type: "error", message: "the model refused the request" }; return; }
      if (stopReason === "model_context_window_exceeded") { yield { type: "error", message: "the conversation no longer fits the model's context window" }; return; }
      yield { type: "done", usage, stopReason: STOP[stopReason ?? ""] ?? "end_turn" };
    },
  };
}
