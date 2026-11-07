// The package is typed as ESM but ships a CommonJS build: take types through an ESM-resolution import and require() lazily.
import type * as GenAI from "@google/genai" with { "resolution-mode": "import" };
import type { ModelInfo } from "../contracts";
import { redact } from "../shared/redact";
import { ProviderAuthError, type Provider, type StopReason, type TurnEvent, type TurnMessage, type TurnRequest } from "./provider";

// Gemini provider on @google/genai (PLAN L1-05). API path: models.generateContentStream with plain function
// declarations. The Interactions API is not used: it needs a live key to confirm (smoke L1-S3) and this path is the
// plan's stated fallback. Server-side tools (Google Search grounding, code execution) are NEVER sent (CLAUDE.md §14):
// the only tools in a request are Nexus's own function declarations.

export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

// Structural slice of the SDK we use, so tests inject a fake without the network.
export interface GeminiModelEntry {
  name?: string;
  displayName?: string;
  inputTokenLimit?: number;
  supportedActions?: string[];
}
export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: unknown };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}
export interface GeminiChunk {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}
export interface GeminiLike {
  models: {
    list(): Promise<AsyncIterable<GeminiModelEntry>>;
    generateContentStream(params: Record<string, unknown>): Promise<AsyncIterable<GeminiChunk>>;
  };
}
export type GeminiClientFactory = (apiKey: string) => GeminiLike;

const defaultFactory: GeminiClientFactory = apiKey => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GoogleGenAI } = require("@google/genai") as typeof GenAI;
  return new GoogleGenAI({ apiKey }) as unknown as GeminiLike;
};

interface Content { role: "user" | "model"; parts: GeminiPart[] }

/** Maps Nexus turn messages to Gemini contents; consecutive tool results become one user turn of functionResponse parts. */
export function toContents(messages: readonly TurnMessage[]): Content[] {
  const out: Content[] = [];
  const nameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", parts: [{ text: m.content }] });
    else if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (m.content.length > 0) parts.push({ text: m.content });
      for (const c of m.toolCalls ?? []) {
        nameById.set(c.id, c.name);
        const sig = (c.providerMeta as { thoughtSignature?: string } | undefined)?.thoughtSignature;
        parts.push({ functionCall: { id: c.id, name: c.name, args: c.args ?? {} }, ...(sig ? { thoughtSignature: sig } : {}) });
      }
      out.push({ role: "model", parts: parts.length > 0 ? parts : [{ text: "(no output)" }] });
    } else {
      const part: GeminiPart = { functionResponse: { id: m.toolCallId, name: nameById.get(m.toolCallId) ?? "unknown_tool", response: m.isError ? { error: m.content } : { output: m.content } } };
      const last = out[out.length - 1];
      if (last && last.role === "user" && last.parts.every(p => p.functionResponse)) last.parts.push(part);
      else out.push({ role: "user", parts: [part] });
    }
  }
  return out;
}

const BLOCKED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY", "MALFORMED_FUNCTION_CALL"]);

function isAuthError(e: unknown): boolean {
  const err = e as { status?: number; message?: string } | null;
  return err?.status === 401 || err?.status === 403 || (err?.status === 400 && /api key/i.test(err.message ?? ""));
}

export function createGeminiProvider(factory: GeminiClientFactory = defaultFactory): Provider {
  // Gemini does not always give function calls an id; ours must stay unique across every turn of a session.
  let callSeq = 0;
  return {
    id: "google",

    async listModels(apiKey: string): Promise<ModelInfo[]> {
      const models: ModelInfo[] = [];
      try {
        for await (const m of await factory(apiKey).models.list()) {
          const id = (m.name ?? "").replace(/^models\//, "");
          // Only Gemini models that can generate content; embeddings, Imagen and Gemma have no function calling.
          if (!id.startsWith("gemini") || !(m.supportedActions ?? []).includes("generateContent")) continue;
          models.push({ provider: "google", modelId: id, displayName: m.displayName ?? id, supportsTools: true, ...(m.inputTokenLimit ? { contextWindow: m.inputTokenLimit } : {}) });
        }
      } catch (e) {
        if (isAuthError(e)) throw new ProviderAuthError();
        // No `cause`: the original SDK error can carry request details; only the redacted message travels on.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(redact(e instanceof Error ? e.message : "could not list Gemini models"));
      }
      return models;
    },

    async *turn(req: TurnRequest, apiKey: string): AsyncIterable<TurnEvent> {
      const usage = { inputTokens: 0, outputTokens: 0 };
      let sawToolCall = false;
      let finish: string | undefined;
      try {
        const stream = await factory(apiKey).models.generateContentStream({
          model: req.modelId,
          contents: toContents(req.messages),
          config: {
            systemInstruction: req.system,
            maxOutputTokens: req.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            tools: req.tools.length > 0 ? [{ functionDeclarations: req.tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema })) }] : undefined,
            automaticFunctionCalling: { disable: true },
            abortSignal: req.signal,
          },
        });
        for await (const chunk of stream) {
          if (chunk.promptFeedback?.blockReason) { yield { type: "error", message: `Gemini blocked the prompt (${chunk.promptFeedback.blockReason})` }; return; }
          if (chunk.usageMetadata) {
            usage.inputTokens = chunk.usageMetadata.promptTokenCount ?? usage.inputTokens;
            usage.outputTokens = chunk.usageMetadata.candidatesTokenCount ?? usage.outputTokens;
          }
          const cand = chunk.candidates?.[0];
          for (const part of cand?.content?.parts ?? []) {
            if (part.functionCall?.name) {
              sawToolCall = true;
              yield { type: "tool_call", id: part.functionCall.id ?? `gemini_call_${++callSeq}`, name: part.functionCall.name, args: part.functionCall.args ?? {}, ...(part.thoughtSignature ? { providerMeta: { thoughtSignature: part.thoughtSignature } } : {}) };
            } else if (part.text && !part.thought) {
              yield { type: "text_delta", text: part.text };
            }
          }
          if (cand?.finishReason) finish = cand.finishReason;
        }
      } catch (e) {
        if (req.signal?.aborted) { yield { type: "done", usage, stopReason: "cancelled" }; return; }
        yield { type: "error", message: redact(e instanceof Error ? e.message : "Gemini request failed") };
        return;
      }
      if (finish && BLOCKED.has(finish)) { yield { type: "error", message: `Gemini stopped the response (${finish})` }; return; }
      const stopReason: StopReason = sawToolCall ? "tool_use" : finish === "MAX_TOKENS" ? "max_tokens" : "end_turn";
      yield { type: "done", usage, stopReason };
    },
  };
}
