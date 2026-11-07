import { describe, expect, it } from "vitest";
import type { ModelCallReceipt } from "../contracts";
import { FakeProvider } from "./fake-provider";
import type { PruneConfig } from "./prune-adapter";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "./gemini";
import { toRouteMessages, wrapGeminiNative } from "./prune-native-gemini";
import type { PruneMetadata } from "./prune-receipt";
import { collectTurn, type TurnRequest } from "./provider";

const PRUNE_KEY = "prune-test-key";
const PROVIDER_KEY = "provider-test-key";
const SECRET = "sk-ant-api03-SECRETSECRETSECRET1234567890";
const MODEL = "gemini-3.8-flash";
const usage = { inputTokens: 1, outputTokens: 1 };

const metadata = (over: Partial<PruneMetadata> = {}): PruneMetadata => ({
  original_model: MODEL, routed_model: MODEL, route_applied: false, optimizations_applied: ["output_cap:400"],
  cost_with_prune_usd: 0.001, cost_without_prune_usd: 0.002, receipt_signature: "c2ln", ...over,
});
// Shape per live test 2026-11-07 (hand-written, not a captured response): Gemini-native body returned on /v1/chat/completions, plus prune_metadata.
const gemini = (parts: unknown[], finishReason = "STOP", over: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: "model", parts }, finishReason }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 }, modelVersion: MODEL, prune_metadata: metadata(), ...over,
});
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({ modelId: MODEL, role: "agent", system: "sys", messages: [{ role: "user", content: "hi" }], tools: [], ...over });
const hang = ((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;

function setup(respond: () => Response | Promise<Response>, over: Partial<PruneConfig> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  const receipts: ModelCallReceipt[] = [];
  const notes: string[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return respond();
  }) as typeof fetch;
  let n = 0;
  const direct = new FakeProvider({ id: "google", script: [[{ type: "text_delta", text: "direct answer" }, { type: "done", usage, stopReason: "end_turn" }]] });
  const provider = wrapGeminiNative(direct, {
    apiKey: PRUNE_KEY, scope: "all_roles", allowModelRouting: false, sessionId: "ses_01", fetch: f,
    newCallId: () => `call_${++n}`, now: () => "2026-11-07T03:15:00Z",
    onReceipt: r => receipts.push(r), onNote: x => notes.push(x), ...over,
  });
  return { provider, sent, receipts, notes };
}

describe("request", () => {
  it("posts OpenAI-style messages and tools to /chat/completions with a Bearer Prune key, redacted, no provider key", async () => {
    const s = setup(() => json(200, gemini([{ text: "Done." }])));
    await collectTurn(s.provider.turn(req({
      system: `sys ${SECRET}`, maxTokens: 300,
      tools: [{ name: "fs_read", description: "read", inputSchema: { type: "object" } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "reading" },
        { role: "tool", toolCallId: "c1", content: `out ${SECRET}` },
      ],
    }), PROVIDER_KEY));
    const c = s.sent[0]!;
    expect(c.url).toBe("https://api.withprune.com/v1/chat/completions");
    expect(c.headers.authorization).toBe(`Bearer ${PRUNE_KEY}`);
    expect(c.headers["x-prune-template-id"]).toBe("nexus-agent");
    expect(JSON.stringify(c)).not.toContain(PROVIDER_KEY);
    expect(JSON.stringify(c.body)).not.toContain(SECRET);
    expect(c.body.model).toBe(MODEL);
    expect(c.body.tools[0]).toEqual({ type: "function", function: { name: "fs_read", description: "read", parameters: { type: "object" } } });
    expect(c.body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });
});

describe("response mapping", () => {
  it("maps text and functionCall parts, keeps thoughtSignature as providerMeta, skips thought parts", async () => {
    const s = setup(() => json(200, gemini([
      { text: "", thoughtSignature: "sig-0" },
      { text: "thinking...", thought: true },
      { text: "Reading." },
      { functionCall: { id: "fc1", name: "fs_read", args: { path: "a.ts" } }, thoughtSignature: "sig-1" },
      { functionCall: { name: "fs_list", args: { path: "." } } },
    ])));
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.text).toBe("Reading.");
    expect(r.toolCalls).toHaveLength(2);
    expect(r.toolCalls[0]).toEqual({ id: "fc1", name: "fs_read", args: { path: "a.ts" }, providerMeta: { thoughtSignature: "sig-1" } });
    expect(r.toolCalls[1]!.name).toBe("fs_list");
    expect(r.toolCalls[1]!.id).toMatch(/\S/);
    expect(r.toolCalls[1]!.id).not.toBe("fc1");
    expect(r.done).toEqual({ type: "done", usage: { inputTokens: 12, outputTokens: 5 }, stopReason: "tool_use" });
    expect(s.receipts[0]).toMatchObject({ requestedModel: MODEL, servedModel: MODEL, costUsd: 0.001, pruneReceiptId: "c2ln" });
  });

  it("maps STOP to end_turn and MAX_TOKENS to max_tokens", async () => {
    const a = setup(() => json(200, gemini([{ text: "ok" }])));
    expect((await collectTurn(a.provider.turn(req(), PROVIDER_KEY))).done?.stopReason).toBe("end_turn");
    const b = setup(() => json(200, gemini([{ text: "ok" }], "MAX_TOKENS")));
    expect((await collectTurn(b.provider.turn(req(), PROVIDER_KEY))).done?.stopReason).toBe("max_tokens");
  });

  it("never treats MALFORMED_FUNCTION_CALL as an empty success", async () => {
    const s = setup(() => json(200, gemini([], "MALFORMED_FUNCTION_CALL")));
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.error).toMatch(/MALFORMED_FUNCTION_CALL/);
    expect(r.done).toBeUndefined();
    expect(s.receipts).toHaveLength(1);
  });

  it("errors on safety stops, prompt blocks and bodies with no candidates", async () => {
    const a = setup(() => json(200, gemini([], "SAFETY")));
    expect((await collectTurn(a.provider.turn(req(), PROVIDER_KEY))).error).toMatch(/SAFETY/);
    const b = setup(() => json(200, { promptFeedback: { blockReason: "OTHER" }, prune_metadata: metadata() }));
    expect((await collectTurn(b.provider.turn(req(), PROVIDER_KEY))).error).toMatch(/blocked.*OTHER/);
    const c = setup(() => json(200, { prune_metadata: metadata() }));
    expect((await collectTurn(c.provider.turn(req(), PROVIDER_KEY))).error).toMatch(/no candidates/);
  });
});

describe("model pinning and failures", () => {
  it("discards an agent answer served by another model and records the receipt", async () => {
    const s = setup(() => json(200, gemini([{ functionCall: { name: "fs_read", args: {} } }], "STOP", { prune_metadata: metadata({ routed_model: "gemini-3.1-pro-preview" }) })));
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.error).toMatch(/gemini-3.1-pro-preview instead of gemini-3.8-flash/);
    expect(r.toolCalls).toEqual([]);
    expect(s.receipts[0]!.servedModel).toBe("gemini-3.1-pro-preview");
  });

  it("does not resend a Prune-blocked request", async () => {
    const s = setup(() => json(403, { message: "no" }, { "x-prune-shield-code": "pii" }));
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.error).toMatch(/403 pii/);
    expect(s.notes).toEqual([]);
  });

  it("retries 5xx and network failures once directly, with a note", async () => {
    const a = setup(() => json(502, {}));
    expect((await collectTurn(a.provider.turn(req(), PROVIDER_KEY))).text).toBe("direct answer");
    expect(a.notes[0]).toMatch(/502.*directly/);
    const b = setup(() => { throw new Error("ECONNRESET"); });
    expect((await collectTurn(b.provider.turn(req(), PROVIDER_KEY))).text).toBe("direct answer");
  });

  it("yields cancelled on caller abort, and goes direct outside scope", async () => {
    const ac = new AbortController();
    const s = setup(() => json(200, {}), { fetch: hang });
    const p = collectTurn(s.provider.turn(req({ signal: ac.signal }), PROVIDER_KEY));
    setTimeout(() => ac.abort(), 5);
    expect((await p).done?.stopReason).toBe("cancelled");
    const t = setup(() => json(200, {}), { scope: "text_roles" });
    expect((await collectTurn(t.provider.turn(req(), PROVIDER_KEY))).text).toBe("direct answer");
    expect(t.sent).toEqual([]);
  });
});

const ARGS_SECRET = "ANTHROPIC_API_KEY=sk-ant-api03-TESTTESTTESTTEST1234567890";

describe("replay and redaction", () => {
  it("redacts tool results, system, user and assistant text", async () => {
    const s = setup(() => json(200, gemini([{ text: "ok" }])));
    await collectTurn(s.provider.turn(req({
      system: `sys ${ARGS_SECRET}`,
      messages: [
        { role: "user", content: `u ${ARGS_SECRET}` },
        { role: "assistant", content: `a ${ARGS_SECRET}` },
        { role: "tool", toolCallId: "c1", content: `t ${ARGS_SECRET}` },
      ],
    }), PROVIDER_KEY));
    expect(JSON.stringify(s.sent[0]!.body)).not.toContain("sk-ant-api03-TESTTEST");
  });

  it("throws a clear unsupported error when replaying tool calls, and sends nothing", async () => {
    const s = setup(() => json(200, gemini([{ text: "ok" }])));
    const messages: TurnRequest["messages"] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "fs_read", args: {}, providerMeta: { thoughtSignature: "sig-1" } }] },
      { role: "tool", toolCallId: "c1", content: "a" },
    ];
    expect(() => toRouteMessages("sys", messages)).toThrow(/unsupported/);
    await expect(collectTurn(s.provider.turn(req({ messages }), PROVIDER_KEY))).rejects.toThrow(/unsupported/);
    expect(s.sent).toEqual([]);
  });

  it("always sends a max token cap", async () => {
    const s = setup(() => json(200, gemini([{ text: "ok" }])));
    await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(s.sent[0]!.body.max_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    await collectTurn(s.provider.turn(req({ maxTokens: 77 }), PROVIDER_KEY));
    expect(s.sent[1]!.body.max_tokens).toBe(77);
  });
});

describe("served-model verification", () => {
  it("only notes (does not fail) when modelVersion differs and routed_model is missing", async () => {
    const s = setup(() => json(200, gemini([{ text: "ok" }], "STOP", { modelVersion: "gemini-3.6-flash", prune_metadata: metadata({ routed_model: undefined }) })));
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.text).toBe("ok");
    expect(r.error).toBeUndefined();
    expect(s.notes.join(" ")).toContain("gemini-3.6-flash");
    expect(s.notes.join(" ")).toContain("gemini-3.8-flash");
  });

  it("notes in the receipt when routed_model is set and modelVersion differs", async () => {
    const s = setup(() => json(200, gemini([{ text: "ok" }], "STOP", { modelVersion: "gemini-3.6-flash", prune_metadata: metadata({ routed_model: MODEL }) })));
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.text).toBe("ok");
    expect(s.receipts[0]!.optimizations).toContain("body_model_differs:gemini-3.6-flash");
    expect(s.notes.join(" ")).toContain("gemini-3.6-flash");
  });

  it("discards an agent answer with empty prune_metadata and no modelVersion", async () => {
    const s = setup(() => json(200, gemini([{ text: "ok" }], "STOP", { modelVersion: undefined, prune_metadata: {} })));
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.error).toMatch(/did not report which model/);
    expect(r.text).toBe("");
  });

  it("rejects an already-aborted signal before sending any request", async () => {
    const s = setup(() => json(200, gemini([{ text: "ok" }])));
    const ac = new AbortController();
    ac.abort();
    const r = await collectTurn(s.provider.turn(req({ signal: ac.signal }), PROVIDER_KEY));
    expect(r.done?.stopReason).toBe("cancelled");
    expect(s.sent).toEqual([]);
  });

  it("discards an agent answer when prune_metadata is missing entirely", async () => {
    const s = setup(() => json(200, gemini([{ text: "ok" }], "STOP", { prune_metadata: undefined })));
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.error).toMatch(/did not report/);
    expect(r.text).toBe("");
  });
});

describe("empty or odd successes are errors", () => {
  const cases: Array<[string, unknown[], string | undefined]> = [
    ["no parts", [], "STOP"],
    ["only an empty text part with a signature", [{ text: "", thoughtSignature: "sig-9" }], "STOP"],
    ["no finishReason", [{ text: "hi" }], undefined],
    ["MALFORMED_RESPONSE", [{ text: "hi" }], "MALFORMED_RESPONSE"],
    ["TOO_MANY_TOOL_CALLS", [], "TOO_MANY_TOOL_CALLS"],
    ["LANGUAGE", [{ text: "hi" }], "LANGUAGE"],
    ["FINISH_REASON_UNSPECIFIED", [{ text: "hi" }], "FINISH_REASON_UNSPECIFIED"],
    ["MAX_TOKENS with no content", [], "MAX_TOKENS"],
  ];
  for (const [name, parts, finish] of cases) {
    it(name, async () => {
      const body = gemini(parts, finish);
      if (finish === undefined) delete (body.candidates[0] as { finishReason?: string }).finishReason;
      const s = setup(() => json(200, body));
      const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
      expect(r.error).toBeDefined();
      expect(r.done).toBeUndefined();
    });
  }
  it("a functionCall without a name is an error and emits nothing", async () => {
    const s = setup(() => json(200, gemini([{ text: "hi" }, { functionCall: { args: {} } }])));
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.error).toMatch(/without a name/);
    expect(r.text).toBe("");
  });
});
