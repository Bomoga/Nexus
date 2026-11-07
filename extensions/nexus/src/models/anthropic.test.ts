import { describe, expect, it } from "vitest";
import { createAnthropicProvider, toApiMessages, type AnthropicLike, type AnthropicModelEntry, type AnthropicStreamEvent } from "./anthropic";
import { dataUseFor } from "./data-use";
import { ProviderAuthError, collectTurn, type TurnRequest } from "./provider";

const SECRET = "sk-ant-api03-SECRETSECRETSECRET1234567890";

async function* gen<T>(items: T[], failWith?: Error): AsyncIterable<T> {
  for (const i of items) yield i;
  if (failWith) throw failWith;
}

function fakeClient(opts: { models?: AnthropicModelEntry[]; stream?: AnthropicStreamEvent[]; failWith?: Error; listError?: unknown } = {}) {
  const created: Array<{ params: Record<string, unknown>; signal?: AbortSignal }> = [];
  const keys: string[] = [];
  const factory = (key: string): AnthropicLike => {
    keys.push(key);
    return {
      models: { list: () => { if (opts.listError) throw opts.listError; return gen(opts.models ?? []); } },
      messages: { create: async (params, options) => { created.push({ params, signal: options?.signal }); return gen(opts.stream ?? [], opts.failWith); } },
    };
  };
  return { factory, created, keys };
}

const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({
  modelId: "claude-x", role: "agent", system: "sys", messages: [{ role: "user", content: "go" }],
  tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" } }], ...over,
});

const toolStream = (json: string[], stop = "tool_use"): AnthropicStreamEvent[] => [
  { type: "message_start", message: { usage: { input_tokens: 120 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading " } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "the file" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read_file" } },
  ...json.map((j): AnthropicStreamEvent => ({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: j } })),
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 33 } },
  { type: "message_stop" },
];

describe("anthropic provider: listModels", () => {
  it("maps the SDK listing to ModelInfo, drops retired models, and passes the key per call", async () => {
    const c = fakeClient({ models: [
      { id: "claude-a", display_name: "Claude A", max_input_tokens: 200000, lifecycle: "active" },
      { id: "claude-old", display_name: "Old", max_input_tokens: 100, lifecycle: "retired" },
      { id: "claude-b", display_name: "Claude B", max_input_tokens: null, lifecycle: "deprecated" },
    ] });
    const p = createAnthropicProvider(c.factory);
    expect(await p.listModels("k1")).toEqual([
      { provider: "anthropic", modelId: "claude-a", displayName: "Claude A", supportsTools: true, contextWindow: 200000 },
      { provider: "anthropic", modelId: "claude-b", displayName: "Claude B", supportsTools: true },
    ]);
    expect(c.keys).toEqual(["k1"]);
  });

  it("maps 401 and 403 to ProviderAuthError and redacts other failures", async () => {
    for (const status of [401, 403]) {
      const p = createAnthropicProvider(fakeClient({ listError: Object.assign(new Error("nope"), { status }) }).factory);
      await expect(p.listModels("k")).rejects.toBeInstanceOf(ProviderAuthError);
    }
    const p = createAnthropicProvider(fakeClient({ listError: new Error(`boom ${SECRET}`) }).factory);
    const err = await p.listModels("k").catch((e: Error) => e);
    expect(err).not.toBeInstanceOf(ProviderAuthError);
    expect((err as Error).message).not.toContain("SECRETSECRET");
  });
});

describe("anthropic provider: turn", () => {
  it("turns a tool_use block into one tool_call with parsed args, joined from partial JSON", async () => {
    const c = fakeClient({ stream: toolStream(['{"pa', 'th": "src/ca', 'rt.ts"}']) });
    const r = await collectTurn(createAnthropicProvider(c.factory).turn(req(), "key-2"));
    expect(r.text).toBe("Reading the file");
    expect(r.toolCalls).toEqual([{ id: "toolu_1", name: "read_file", args: { path: "src/cart.ts" } }]);
    expect(r.done).toEqual({ type: "done", usage: { inputTokens: 120, outputTokens: 33 }, stopReason: "tool_use" });
    expect(c.keys).toEqual(["key-2"]);
  });

  it("sends model, system, mapped messages, tools and stream:true, and forwards the abort signal", async () => {
    const ac = new AbortController();
    const c = fakeClient({ stream: toolStream(["{}"]) });
    await collectTurn(createAnthropicProvider(c.factory).turn(req({ maxTokens: 100, signal: ac.signal }), "k"));
    const { params, signal } = c.created[0];
    expect(params).toMatchObject({ model: "claude-x", max_tokens: 100, system: "sys", stream: true, messages: [{ role: "user", content: "go" }], tools: [{ name: "read_file", description: "read", input_schema: { type: "object" } }] });
    expect(signal).toBe(ac.signal);
  });

  it("treats empty tool input as {} and maps stop reasons", async () => {
    const empty = await collectTurn(createAnthropicProvider(fakeClient({ stream: toolStream([]) }).factory).turn(req(), "k"));
    expect(empty.toolCalls[0].args).toEqual({});
    const end = await collectTurn(createAnthropicProvider(fakeClient({ stream: [{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }] }).factory).turn(req(), "k"));
    expect(end.done?.stopReason).toBe("end_turn");
    const max = await collectTurn(createAnthropicProvider(fakeClient({ stream: [{ type: "message_delta", delta: { stop_reason: "max_tokens" } }] }).factory).turn(req(), "k"));
    expect(max.done?.stopReason).toBe("max_tokens");
  });

  it("reports malformed tool arguments, refusals and context overflow as errors, not tool calls", async () => {
    const bad = await collectTurn(createAnthropicProvider(fakeClient({ stream: toolStream(['{"path": ']) }).factory).turn(req(), "k"));
    expect(bad.error).toMatch(/malformed arguments for tool read_file/);
    expect(bad.toolCalls).toEqual([]);
    expect(bad.done).toBeUndefined();
    for (const [reason, text] of [["refusal", /refused/], ["model_context_window_exceeded", /context window/]] as const) {
      const r = await collectTurn(createAnthropicProvider(fakeClient({ stream: [{ type: "message_delta", delta: { stop_reason: reason } }] }).factory).turn(req(), "k"));
      expect(r.error).toMatch(text);
    }
  });

  it("turns a mid-stream failure into a redacted error event, and an abort into a cancelled done", async () => {
    const failing = fakeClient({ stream: [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }], failWith: new Error(`overloaded ${SECRET}`) });
    const r = await collectTurn(createAnthropicProvider(failing.factory).turn(req(), "k"));
    expect(r.text).toBe("hi");
    expect(r.error).toContain("overloaded");
    expect(r.error).not.toContain("SECRETSECRET");

    const ac = new AbortController();
    ac.abort();
    const aborted = await collectTurn(createAnthropicProvider(fakeClient({ failWith: new Error("aborted") }).factory).turn(req({ signal: ac.signal }), "k"));
    expect(aborted.done?.stopReason).toBe("cancelled");
    expect(aborted.error).toBeUndefined();
  });

  it("does not hold on to the key", () => {
    const p = createAnthropicProvider(fakeClient().factory);
    expect(JSON.stringify(p)).not.toMatch(/key/i);
    expect(Object.keys(p).sort()).toEqual(["id", "listModels", "turn"]);
  });
});

describe("toApiMessages", () => {
  it("maps assistant tool calls to tool_use blocks and merges consecutive tool results into one user message", () => {
    const out = toApiMessages([
      { role: "user", content: "go" },
      { role: "assistant", content: "ok", toolCalls: [{ id: "a", name: "read_file", args: { path: "x" } }, { id: "b", name: "list_files", args: {} }] },
      { role: "tool", toolCallId: "a", content: "A" },
      { role: "tool", toolCallId: "b", content: "B", isError: true },
      { role: "assistant", content: "" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "a", name: "read_file", input: { path: "x" } }, { type: "tool_use", id: "b", name: "list_files", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "A" }, { type: "tool_result", tool_use_id: "b", content: "B", is_error: true }] },
      { role: "assistant", content: "" },
    ]);
  });
});

describe("dataUseFor", () => {
  it("never claims more than the sources say", () => {
    expect(dataUseFor("anthropic")).toMatchObject({ dataUse: "not_used_for_training", dataLeavesMachine: true });
    expect(dataUseFor("google", { billingEnabled: true }).dataUse).toBe("not_used_for_training");
    expect(dataUseFor("google").dataUse).toBe("may_be_used_for_training");
    expect(dataUseFor("google", { billingEnabled: false }).dataUse).toBe("may_be_used_for_training");
    expect(dataUseFor("swarms").dataUse).toBe("unknown");
    expect(dataUseFor("some-new-provider")).toMatchObject({ dataUse: "unknown", dataLeavesMachine: true });
    expect(dataUseFor("ollama").dataLeavesMachine).toBe(false);
  });
});
