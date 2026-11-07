import { describe, expect, it } from "vitest";
import { createGeminiProvider, toContents, type GeminiChunk, type GeminiLike, type GeminiModelEntry } from "./gemini";
import { ProviderAuthError, collectTurn, type TurnRequest } from "./provider";

const SECRET = "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6x";

async function* gen<T>(items: T[], failWith?: Error): AsyncIterable<T> {
  for (const i of items) yield i;
  if (failWith) throw failWith;
}

function fakeClient(opts: { models?: GeminiModelEntry[]; chunks?: GeminiChunk[]; failWith?: Error; listError?: unknown } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const keys: string[] = [];
  const factory = (key: string): GeminiLike => {
    keys.push(key);
    return {
      models: {
        list: async () => { if (opts.listError) throw opts.listError; return gen(opts.models ?? []); },
        generateContentStream: async params => { calls.push(params); return gen(opts.chunks ?? [], opts.failWith); },
      },
    };
  };
  return { factory, calls, keys };
}

const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({
  modelId: "gemini-x", role: "agent", system: "sys", messages: [{ role: "user", content: "go" }],
  tools: [{ name: "read_file", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }], ...over,
});

const callChunk = (extra: Record<string, unknown> = {}): GeminiChunk => ({
  candidates: [{ content: { parts: [{ text: "Reading. " }, { functionCall: { name: "read_file", args: { path: "src/cart.ts" } }, ...extra }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 12 },
});

describe("gemini provider: listModels", () => {
  it("keeps Gemini models that generate content, strips models/, and maps the context window", async () => {
    const c = fakeClient({ models: [
      { name: "models/gemini-a", displayName: "Gemini A", inputTokenLimit: 1000000, supportedActions: ["generateContent", "countTokens"] },
      { name: "models/gemini-embedding", displayName: "Embed", supportedActions: ["embedContent"] },
      { name: "models/gemma-3", displayName: "Gemma", supportedActions: ["generateContent"] },
      { name: "models/gemini-b", supportedActions: ["generateContent"] },
    ] });
    expect(await createGeminiProvider(c.factory).listModels("k1")).toEqual([
      { provider: "google", modelId: "gemini-a", displayName: "Gemini A", supportsTools: true, contextWindow: 1000000 },
      { provider: "google", modelId: "gemini-b", displayName: "gemini-b", supportsTools: true },
    ]);
    expect(c.keys).toEqual(["k1"]);
  });

  it("maps 401, 403 and a 400 'API key not valid' to ProviderAuthError; other failures are redacted", async () => {
    for (const err of [{ status: 401 }, { status: 403 }, { status: 400, message: "API key not valid. Please pass a valid API key." }]) {
      const p = createGeminiProvider(fakeClient({ listError: Object.assign(new Error(err.message ?? "x"), err) }).factory);
      await expect(p.listModels("k")).rejects.toBeInstanceOf(ProviderAuthError);
    }
    const other = await createGeminiProvider(fakeClient({ listError: Object.assign(new Error(`bad request ${SECRET}`), { status: 400 }) }).factory).listModels("k").catch((e: Error) => e);
    expect(other).not.toBeInstanceOf(ProviderAuthError);
    expect((other as Error).message).not.toContain("AIzaSy");
  });
});

describe("gemini provider: turn", () => {
  it("yields text and a tool call with a generated id, then done(tool_use) with usage", async () => {
    const c = fakeClient({ chunks: [callChunk()] });
    const r = await collectTurn(createGeminiProvider(c.factory).turn(req(), "key-2"));
    expect(r.text).toBe("Reading. ");
    expect(r.toolCalls).toEqual([{ id: "gemini_call_1", name: "read_file", args: { path: "src/cart.ts" } }]);
    expect(r.done).toEqual({ type: "done", usage: { inputTokens: 50, outputTokens: 12 }, stopReason: "tool_use" });
    expect(c.keys).toEqual(["key-2"]);
  });

  it("keeps the provider's call id and carries the thought signature as providerMeta", async () => {
    const chunk: GeminiChunk = { candidates: [{ content: { parts: [{ functionCall: { id: "fc_9", name: "list_files", args: {} }, thoughtSignature: "sig-abc" }] } }] };
    const r = await collectTurn(createGeminiProvider(fakeClient({ chunks: [chunk] }).factory).turn(req(), "k"));
    expect(r.toolCalls).toEqual([{ id: "fc_9", name: "list_files", args: {}, providerMeta: { thoughtSignature: "sig-abc" } }]);
  });

  it("sends only plain function declarations: no search, no code execution, no auto function calling", async () => {
    const ac = new AbortController();
    const c = fakeClient({ chunks: [callChunk()] });
    await collectTurn(createGeminiProvider(c.factory).turn(req({ maxTokens: 77, signal: ac.signal }), "k"));
    const params = c.calls[0] as { model: string; contents: unknown; config: Record<string, unknown> };
    expect(params.model).toBe("gemini-x");
    expect(params.contents).toEqual([{ role: "user", parts: [{ text: "go" }] }]);
    expect(params.config).toMatchObject({ systemInstruction: "sys", maxOutputTokens: 77, automaticFunctionCalling: { disable: true }, abortSignal: ac.signal });
    const tools = params.config.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(Object.keys(tools[0])).toEqual(["functionDeclarations"]);
    expect(tools[0].functionDeclarations).toEqual([{ name: "read_file", description: "read", parametersJsonSchema: { type: "object", properties: { path: { type: "string" } } } }]);
    expect(JSON.stringify(params)).not.toMatch(/googleSearch|codeExecution|urlContext/i);
  });

  it("omits tools entirely when there are none", async () => {
    const c = fakeClient({ chunks: [{ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] }] });
    await collectTurn(createGeminiProvider(c.factory).turn(req({ tools: [] }), "k"));
    expect((c.calls[0].config as { tools?: unknown }).tools).toBeUndefined();
  });

  it("skips thought parts and maps stop reasons", async () => {
    const thinking: GeminiChunk = { candidates: [{ content: { parts: [{ text: "internal reasoning", thought: true }, { text: "answer" }] }, finishReason: "STOP" }] };
    const r = await collectTurn(createGeminiProvider(fakeClient({ chunks: [thinking] }).factory).turn(req(), "k"));
    expect(r.text).toBe("answer");
    expect(r.done?.stopReason).toBe("end_turn");
    const max = await collectTurn(createGeminiProvider(fakeClient({ chunks: [{ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "MAX_TOKENS" }] }] }).factory).turn(req(), "k"));
    expect(max.done?.stopReason).toBe("max_tokens");
  });

  it("reports blocked prompts and blocked responses as errors", async () => {
    const blockedPrompt = await collectTurn(createGeminiProvider(fakeClient({ chunks: [{ promptFeedback: { blockReason: "SAFETY" } }] }).factory).turn(req(), "k"));
    expect(blockedPrompt.error).toMatch(/blocked the prompt \(SAFETY\)/);
    for (const reason of ["SAFETY", "PROHIBITED_CONTENT", "MALFORMED_FUNCTION_CALL"]) {
      const r = await collectTurn(createGeminiProvider(fakeClient({ chunks: [{ candidates: [{ finishReason: reason }] }] }).factory).turn(req(), "k"));
      expect(r.error).toContain(reason);
      expect(r.done).toBeUndefined();
    }
  });

  it("turns a mid-stream failure into a redacted error and an abort into a cancelled done", async () => {
    const failing = fakeClient({ chunks: [{ candidates: [{ content: { parts: [{ text: "hi" }] } }] }], failWith: new Error(`quota ${SECRET}`) });
    const r = await collectTurn(createGeminiProvider(failing.factory).turn(req(), "k"));
    expect(r.text).toBe("hi");
    expect(r.error).toContain("quota");
    expect(r.error).not.toContain("AIzaSy");

    const ac = new AbortController();
    ac.abort();
    const aborted = await collectTurn(createGeminiProvider(fakeClient({ failWith: new Error("aborted") }).factory).turn(req({ signal: ac.signal }), "k"));
    expect(aborted.done?.stopReason).toBe("cancelled");
  });

  it("does not hold on to the key", () => {
    const p = createGeminiProvider(fakeClient().factory);
    expect(Object.keys(p).sort()).toEqual(["id", "listModels", "turn"]);
  });
});

describe("toContents", () => {
  it("maps calls to functionCall parts (echoing signatures) and merges results into one user turn with the right names", () => {
    const out = toContents([
      { role: "user", content: "go" },
      { role: "assistant", content: "ok", toolCalls: [{ id: "a", name: "read_file", args: { path: "x" }, providerMeta: { thoughtSignature: "sig" } }, { id: "b", name: "list_files", args: {} }] },
      { role: "tool", toolCallId: "a", content: "A" },
      { role: "tool", toolCallId: "b", content: "denied", isError: true },
      { role: "assistant", content: "" },
    ]);
    expect(out).toEqual([
      { role: "user", parts: [{ text: "go" }] },
      { role: "model", parts: [{ text: "ok" }, { functionCall: { id: "a", name: "read_file", args: { path: "x" } }, thoughtSignature: "sig" }, { functionCall: { id: "b", name: "list_files", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "a", name: "read_file", response: { output: "A" } } }, { functionResponse: { id: "b", name: "list_files", response: { error: "denied" } } }] },
      { role: "model", parts: [{ text: "" }] },
    ]);
  });
});
