import { describe, expect, it } from "vitest";
import type { ModelCallReceipt } from "../contracts";
import { FakeProvider } from "./fake-provider";
import { PRUNE_BASE_URL, inScope, routingAllowed, templateIdFor, toOpenAiMessages, wrapProvider, type PruneConfig } from "./prune-adapter";
import type { PruneMetadata } from "./prune-receipt";
import { collectTurn, type TurnEvent, type TurnRequest } from "./provider";

const SECRET = "sk-ant-api03-SECRETSECRETSECRET1234567890";
const PRUNE_KEY = "prune_test_key_12345678901234567890";
const PROVIDER_KEY = "sk-provider-key-abcdef";
const MODEL = "claude-sonnet-4-5";
const usage = { inputTokens: 1, outputTokens: 1 };

const metadata = (over: Partial<PruneMetadata> = {}): PruneMetadata => ({
  original_model: MODEL, routed_model: MODEL, cache_hit: false, optimizations_applied: ["prompt_trimmed", "output_cap:400"],
  cost_with_prune_usd: 0.004, cost_without_prune_usd: 0.007, receipt_signature: "c2ln", receipt_signing_key_id: "prune-ed25519-2026-01", ...over,
});
const answer = (over: Record<string, unknown> = {}) => ({
  choices: [{ message: { content: "Done.", tool_calls: undefined }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 }, prune_metadata: metadata(), ...over,
});
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({ modelId: MODEL, role: "summary", system: "sys", messages: [{ role: "user", content: "hi" }], tools: [], ...over });

function setup(respond: (init: RequestInit & { parsed?: Record<string, unknown> }) => Response | Promise<Response>, over: Partial<PruneConfig> = {}) {
  const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const receipts: Array<{ receipt: ModelCallReceipt; md: PruneMetadata }> = [];
  const notes: string[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body });
    return respond({ ...init, parsed: body });
  }) as typeof fetch;
  let n = 0;
  const direct = new FakeProvider({ id: "anthropic", script: [[{ type: "text_delta", text: "direct answer" }, { type: "done", usage, stopReason: "end_turn" }]] });
  const provider = wrapProvider(direct, {
    apiKey: PRUNE_KEY, scope: "text_roles", allowModelRouting: false, sessionId: "ses_01", fetch: f,
    newCallId: () => `call_${++n}`, now: () => "2026-11-07T03:15:00Z",
    onReceipt: (receipt, md) => receipts.push({ receipt, md }), onNote: note => notes.push(note), ...over,
  });
  return { provider, direct, sent, receipts, notes };
}

describe("scope", () => {
  it("routes text roles always and the agent only under all_roles", () => {
    expect(inScope("text_roles", "summary")).toBe(true);
    expect(inScope("text_roles", "agent")).toBe(false);
    expect(inScope("all_roles", "agent")).toBe(true);
  });
  it("allows routing to another model only for text roles that opted in, never the agent", () => {
    expect(routingAllowed({ allowModelRouting: true }, "summary")).toBe(true);
    expect(routingAllowed({ allowModelRouting: true }, "agent")).toBe(false);
    expect(routingAllowed({ allowModelRouting: false }, "summary")).toBe(false);
  });

  it("sends an agent call straight to the provider under text_roles, and never touches Prune", async () => {
    const s = setup(() => json(200, answer()));
    const r = await collectTurn(s.provider.turn(req({ role: "agent" }), PROVIDER_KEY));
    expect(r.text).toBe("direct answer");
    expect(s.sent).toEqual([]);
    expect(s.direct.keyFingerprints).toHaveLength(1);
    expect(s.receipts).toEqual([]);
  });

  it("routes the agent through Prune under all_roles", async () => {
    const s = setup(() => json(200, answer()), { scope: "all_roles" });
    await collectTurn(s.provider.turn(req({ role: "agent" }), PROVIDER_KEY));
    expect(s.sent).toHaveLength(1);
    expect(s.direct.requests).toHaveLength(0);
  });

  it("delegates listModels to the provider", async () => {
    const s = setup(() => json(200, answer()));
    expect((await s.provider.listModels(PROVIDER_KEY))[0].modelId).toBe("claude-sonnet-4-5");
    expect(s.sent).toEqual([]);
  });
});

describe("the request", () => {
  it("posts OpenAI chat-completions to Prune with the Prune key as Bearer and no provider key anywhere", async () => {
    const s = setup(() => json(200, answer()));
    await collectTurn(s.provider.turn(req({
      maxTokens: 300, tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" } }],
      messages: [{ role: "user", content: "go" }, { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read_file", args: { path: "a" } }] }, { role: "tool", toolCallId: "t1", content: "A" }],
    }), PROVIDER_KEY));
    const call = s.sent[0];
    expect(call.url).toBe(`${PRUNE_BASE_URL}/chat/completions`);
    expect(call.headers).toMatchObject({ authorization: `Bearer ${PRUNE_KEY}`, "content-type": "application/json", "x-prune-template-id": "nexus-summary" });
    expect(templateIdFor("approval_wording")).toBe("nexus-approval-wording");     // one stable id per role, not per request
    expect(templateIdFor("???" as never)).toBe("nexus-call");
    expect(call.body).toMatchObject({
      model: MODEL, stream: false, max_tokens: 300,
      tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } }],
      messages: [
        { role: "system", content: "sys" }, { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
        { role: "tool", tool_call_id: "t1", content: "A" },
      ],
    });
    expect(JSON.stringify(call)).not.toContain(PROVIDER_KEY);
  });

  it("redacts secrets in everything it sends", async () => {
    const s = setup(() => json(200, answer()));
    await collectTurn(s.provider.turn(req({ system: `rules ${SECRET}`, messages: [{ role: "user", content: `key ${SECRET}` }] }), PROVIDER_KEY));
    expect(JSON.stringify(s.sent[0].body)).not.toContain("SECRETSECRET");
  });

  it("toOpenAiMessages omits an empty system prompt", () => {
    expect(toOpenAiMessages("", [{ role: "user", content: "x" }])).toEqual([{ role: "user", content: "x" }]);
  });
});

describe("the answer and its receipt", () => {
  it("yields the text and usage, and records a receipt from prune_metadata", async () => {
    const s = setup(() => json(200, answer()));
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.text).toBe("Done.");
    expect(r.done).toEqual({ type: "done", usage: { inputTokens: 10, outputTokens: 4 }, stopReason: "end_turn" });
    expect(s.receipts).toHaveLength(1);
    expect(s.receipts[0].receipt).toEqual({
      callId: "call_1", sessionId: "ses_01", role: "summary", requestedModel: MODEL, servedModel: MODEL, costUsd: 0.004, baselineCostUsd: 0.007,
      optimizations: ["prompt_trimmed", "output_cap:400"], pruneReceiptId: "c2ln", at: "2026-11-07T03:15:00Z",
    });
    expect(s.receipts[0].md.receipt_signing_key_id).toBe("prune-ed25519-2026-01");
  });

  it("maps tool calls (parsed arguments) and finish reasons", async () => {
    const withTool = answer({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"src/cart.ts"}' } }, { function: { name: "list_files", arguments: "" } }] }, finish_reason: "tool_calls" }] });
    const r = await collectTurn(setup(() => json(200, withTool)).provider.turn(req({ role: "summary" }), PROVIDER_KEY));
    expect(r.toolCalls).toEqual([{ id: "c1", name: "read_file", args: { path: "src/cart.ts" } }, { id: "prune_call_2", name: "list_files", args: {} }]);
    expect(r.done?.stopReason).toBe("tool_use");
    const len = await collectTurn(setup(() => json(200, answer({ choices: [{ message: { content: "cut" }, finish_reason: "length" }] }))).provider.turn(req(), PROVIDER_KEY));
    expect(len.done?.stopReason).toBe("max_tokens");
  });

  it("reports malformed tool arguments as an error", async () => {
    const bad = answer({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path": ' } }] }, finish_reason: "tool_calls" }] });
    const r = await collectTurn(setup(() => json(200, bad)).provider.turn(req(), PROVIDER_KEY));
    expect(r.error).toMatch(/malformed arguments for tool read_file/);
    expect(r.toolCalls).toEqual([]);
  });

  it("marks a cache hit and an unreported cost in the receipt", async () => {
    const s = setup(() => json(200, answer({ prune_metadata: { original_model: MODEL, routed_model: MODEL, cache_hit: true } })));
    await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(s.receipts[0].receipt).toMatchObject({ costUsd: 0, optimizations: ["cache_hit", "cost_unreported"], pruneReceiptId: "unsigned:call_1" });
  });
});

describe("model pinning", () => {
  const routed = () => json(200, answer({ prune_metadata: metadata({ routed_model: "cheaper-model", optimizations_applied: ["model_routing"] }) }));

  it("discards the answer and fails the call when Prune routed the coding agent elsewhere, but still records the receipt", async () => {
    const s = setup(routed, { scope: "all_roles", allowModelRouting: true });          // even with routing "allowed", the agent is pinned
    const r = await collectTurn(s.provider.turn(req({ role: "agent" }), PROVIDER_KEY));
    expect(r.error).toMatch(/Prune answered with cheaper-model instead of claude-sonnet-4-5.*pinned.*discarded/);
    expect(r.text).toBe("");
    expect(r.done).toBeUndefined();
    expect(s.receipts[0].receipt).toMatchObject({ requestedModel: MODEL, servedModel: "cheaper-model", optimizations: ["model_routing"] });
    expect(s.direct.requests).toHaveLength(0);                                          // not silently redone elsewhere
  });

  it("refuses a routed answer for a text role when routing is off, and accepts it when the user enabled it", async () => {
    const off = setup(routed, { allowModelRouting: false });
    expect((await collectTurn(off.provider.turn(req(), PROVIDER_KEY))).error).toMatch(/Model routing is off/);
    const on = setup(routed, { allowModelRouting: true });
    const r = await collectTurn(on.provider.turn(req(), PROVIDER_KEY));
    expect(r.error).toBeUndefined();
    expect(r.text).toBe("Done.");
    expect(on.receipts[0].receipt.servedModel).toBe("cheaper-model");                  // the picked model is never shown as the one that answered
  });
});

describe("blocked and failing calls", () => {
  it.each([
    [403, { "x-prune-shield-code": "prompt_injection" }, "403 prompt_injection"],
    [429, {}, "429"],
    [402, {}, "402"],
    [400, {}, "400"],
  ])("a %i from Prune is a clear error and is never resent to the provider", async (status, headers, expected) => {
    const s = setup(() => json(status, { message: `blocked ${SECRET}` }, headers));
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.error).toContain(expected);
    expect(r.error).toContain("not sent anywhere else");
    expect(r.error).not.toContain("SECRETSECRET");
    expect(s.direct.requests).toHaveLength(0);
    expect(s.notes).toEqual([]);
    expect(s.receipts).toEqual([]);
  });

  it.each([
    ["a 500", () => json(500, {})],
    ["a 503", () => json(503, {})],
    ["a network failure", () => { throw new Error(`ECONNRESET ${SECRET}`); }],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })],
  ])("%s is retried once directly against the provider, and noted", async (_name, respond) => {
    const s = setup(respond);
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.text).toBe("direct answer");
    expect(s.direct.requests).toHaveLength(1);
    expect(s.notes).toHaveLength(1);
    expect(s.notes[0]).toMatch(/went directly to the provider/);
    expect(s.notes[0]).not.toContain("SECRETSECRET");
    expect(s.receipts).toEqual([]);
  });

  it("falls back directly when Prune does not answer in time", async () => {
    const hang = ((_u: string, init?: RequestInit) => new Promise((_res, rej) => init!.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    const s = setup(() => json(200, answer()), { fetch: hang, timeoutMs: 20 });
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.text).toBe("direct answer");
    expect(s.notes[0]).toMatch(/did not answer in time/);
  });

  it("an abort is a cancelled turn, not a fallback", async () => {
    const hang = ((_u: string, init?: RequestInit) => new Promise((_res, rej) => init!.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    const ac = new AbortController();
    const s = setup(() => json(200, answer()), { fetch: hang });
    const pending = collectTurn(s.provider.turn(req({ signal: ac.signal }), PROVIDER_KEY));
    setTimeout(() => ac.abort(), 10);
    const r = await pending;
    expect(r.done?.stopReason).toBe("cancelled");
    expect(s.direct.requests).toHaveLength(0);
    expect(s.notes).toEqual([]);
  });

  it("holds no key", () => {
    const s = setup(() => json(200, answer()));
    expect(Object.keys(s.provider).sort()).toEqual(["id", "listModels", "turn"]);
    expect(JSON.stringify(s.provider)).not.toContain(PRUNE_KEY);
    const events: TurnEvent[] = [];
    expect(events).toEqual([]);
  });
});
