import { describe, expect, it } from "vitest";
import type { ModelCallReceipt } from "../contracts";
import { FakeProvider } from "./fake-provider";
import type { PruneConfig } from "./prune-adapter";
import { PRUNE_NATIVE_ANTHROPIC_PATH, nativeRouteFor, wrapAnthropicNative } from "./prune-native-anthropic";
import type { PruneMetadata } from "./prune-receipt";
import { collectTurn, type TurnRequest } from "./provider";

const PRUNE_KEY = "prune-test-key";
const PROVIDER_KEY = "provider-test-key";
const SECRET = "sk-ant-api03-SECRETSECRETSECRET1234567890";
const MODEL = "claude-sonnet-5-5";
const usage = { inputTokens: 1, outputTokens: 1 };

const metadata = (over: Partial<PruneMetadata> = {}): PruneMetadata => ({
  original_model: MODEL, routed_model: MODEL, route_applied: false, optimizations_applied: ["prompt_trimmed"],
  cost_with_prune_usd: 0.004, cost_without_prune_usd: 0.007, receipt_signature: "c2ln", ...over,
});
// Recorded shape: normal Anthropic message plus top-level prune_metadata; tool_use echoes extra keys.
const message = (over: Record<string, unknown> = {}) => ({
  id: "msg_1", type: "message", role: "assistant", model: MODEL, stop_reason: "end_turn",
  content: [{ type: "text", text: "Done." }], usage: { input_tokens: 10, output_tokens: 4 }, prune_metadata: metadata(), ...over,
});
const toolUseMessage = (over: Record<string, unknown> = {}) => message({
  stop_reason: "tool_use",
  content: [{ type: "text", text: "Reading." }, { type: "tool_use", id: "toolu_1", name: "fs_read", input: { path: "a.ts" }, text: null, caller: { type: "direct" } }],
  ...over,
});
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({ modelId: MODEL, role: "agent", system: "sys", messages: [{ role: "user", content: "hi" }], tools: [], ...over });
const hang = ((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;

function setup(respond: () => Response | Promise<Response>, over: Partial<PruneConfig> = {}) {
  const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  const receipts: ModelCallReceipt[] = [];
  const notes: string[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return respond();
  }) as typeof fetch;
  let n = 0;
  const direct = new FakeProvider({ id: "anthropic", script: [[{ type: "text_delta", text: "direct answer" }, { type: "done", usage, stopReason: "end_turn" }]] });
  const provider = wrapAnthropicNative(direct, {
    apiKey: PRUNE_KEY, scope: "all_roles", allowModelRouting: false, sessionId: "ses_01", fetch: f,
    newCallId: () => `call_${++n}`, now: () => "2026-11-07T03:15:00Z",
    onReceipt: r => receipts.push(r), onNote: x => notes.push(x), ...over,
  });
  return { provider, sent, receipts, notes };
}

describe("nativeRouteFor", () => {
  it("names the verified native routes only", () => {
    expect(nativeRouteFor("anthropic")).toBe("anthropic-messages");
    expect(nativeRouteFor("google")).toBe("gemini-chat-completions");
    expect(nativeRouteFor("swarms")).toBeUndefined();
    expect(nativeRouteFor("openai")).toBeUndefined();
  });
});

describe("request", () => {
  it("posts an Anthropic-shaped body to the native route with the Prune headers and no provider key", async () => {
    const s = setup(() => json(200, message()));
    await collectTurn(s.provider.turn(req({
      system: `sys ${SECRET}`, maxTokens: 500,
      tools: [{ name: "fs_read", description: "read", inputSchema: { type: "object" } }],
    }), PROVIDER_KEY));
    const c = s.sent[0]!;
    expect(PRUNE_NATIVE_ANTHROPIC_PATH).toBe("/proxy/anthropic/messages");
    expect(c.url).toBe("https://api.withprune.com/v1/proxy/anthropic/messages");
    expect(c.headers["x-prune-key"]).toBe(PRUNE_KEY);
    expect(c.headers["anthropic-version"]).toBe("2023-06-01");
    expect(c.headers["x-prune-template-id"]).toBe("nexus-agent");
    expect(JSON.stringify(c)).not.toContain(PROVIDER_KEY);
    expect(c.body.model).toBe(MODEL);
    expect(c.body.max_tokens).toBe(500);
    expect(c.body.system).not.toContain(SECRET);
    expect(c.body.tools).toEqual([{ name: "fs_read", description: "read", input_schema: { type: "object" } }]);
    expect(c.body.stream).toBe(false);
  });

  it("replays assistant tool_use blocks with only type, id, name and input, and redacts tool results", async () => {
    const s = setup(() => json(200, message()));
    await collectTurn(s.provider.turn(req({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "Reading.", toolCalls: [{ id: "toolu_1", name: "fs_read", args: { path: "a.ts" } }] },
        { role: "tool", toolCallId: "toolu_1", content: `key ${SECRET}` },
      ],
    }), PROVIDER_KEY));
    const msgs = s.sent[0]!.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(msgs[1]!.content[1]).toEqual({ type: "tool_use", id: "toolu_1", name: "fs_read", input: { path: "a.ts" } });
    expect(Object.keys(msgs[1]!.content[1]!).sort()).toEqual(["id", "input", "name", "type"]);
    expect(msgs[2]!.content[0]!.type).toBe("tool_result");
    expect(JSON.stringify(msgs[2])).not.toContain(SECRET);
  });
});

describe("response", () => {
  it("maps text and tool_use blocks to events, stops with tool_use, and reports a receipt", async () => {
    const s = setup(() => json(200, toolUseMessage()));
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.text).toBe("Reading.");
    expect(r.toolCalls).toEqual([{ id: "toolu_1", name: "fs_read", args: { path: "a.ts" } }]);
    expect(r.done).toEqual({ type: "done", usage: { inputTokens: 10, outputTokens: 4 }, stopReason: "tool_use" });
    expect(s.receipts).toHaveLength(1);
    expect(s.receipts[0]).toMatchObject({ requestedModel: MODEL, servedModel: MODEL, role: "agent", costUsd: 0.004, pruneReceiptId: "c2ln", sessionId: "ses_01" });
  });

  it("maps max_tokens and refusal", async () => {
    const a = setup(() => json(200, message({ stop_reason: "max_tokens" })));
    expect((await collectTurn(a.provider.turn(req(), PROVIDER_KEY))).done?.stopReason).toBe("max_tokens");
    const b = setup(() => json(200, message({ stop_reason: "refusal" })));
    expect((await collectTurn(b.provider.turn(req(), PROVIDER_KEY))).error).toMatch(/refused/);
  });

  it("treats a response with no stop_reason as incomplete", async () => {
    const s = setup(() => json(200, message({ stop_reason: null })));
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.error).toMatch(/not complete/);
    expect(r.done).toBeUndefined();
  });
});

describe("model pinning", () => {
  it("discards an agent answer served by another model, records the receipt, and yields an error", async () => {
    const s = setup(() => json(200, toolUseMessage({ prune_metadata: metadata({ routed_model: "claude-haiku-4-5", route_applied: true }) })));
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.error).toMatch(/claude-haiku-4-5 instead of claude-sonnet-5-5/);
    expect(r.toolCalls).toEqual([]);
    expect(r.text).toBe("");
    expect(s.receipts[0]!.servedModel).toBe("claude-haiku-4-5");
  });

  it("allows another served model for a text role only when routing is enabled", async () => {
    const routed = () => json(200, message({ prune_metadata: metadata({ routed_model: "claude-haiku-4-5" }) }));
    const off = setup(routed);
    expect((await collectTurn(off.provider.turn(req({ role: "summary" }), PROVIDER_KEY))).error).toBeDefined();
    const on = setup(routed, { allowModelRouting: true });
    expect((await collectTurn(on.provider.turn(req({ role: "summary" }), PROVIDER_KEY))).text).toBe("Done.");
  });
});

describe("failure handling", () => {
  it("treats a Prune refusal as an error and never resends it elsewhere", async () => {
    const s = setup(() => json(403, { message: "blocked" }, { "x-prune-shield-code": "secret_detected" }));
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.error).toMatch(/403 secret_detected/);
    expect(r.text).toBe("");
    expect(s.notes).toEqual([]);
  });

  it("retries a 5xx once directly against the provider and notes it", async () => {
    const s = setup(() => json(503, {}));
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.text).toBe("direct answer");
    expect(s.notes[0]).toMatch(/503.*directly/);
    expect(s.sent).toHaveLength(1);
  });

  it("retries a network failure directly", async () => {
    const s = setup(() => { throw new Error("ECONNRESET"); });
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.text).toBe("direct answer");
    expect(s.notes[0]).toMatch(/could not be reached/);
  });

  it("retries a timeout directly", async () => {
    const s = setup(() => json(200, message()), { fetch: hang, timeoutMs: 10 });
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.text).toBe("direct answer");
    expect(s.notes[0]).toMatch(/in time/);
  });

  it("yields cancelled when the caller aborts, without a direct retry", async () => {
    const ac = new AbortController();
    const s = setup(() => json(200, message()), { fetch: hang });
    const p = collectTurn(s.provider.turn(req({ signal: ac.signal }), PROVIDER_KEY));
    setTimeout(() => ac.abort(), 5);
    const r = await p;
    expect(r.done?.stopReason).toBe("cancelled");
    expect(s.notes).toEqual([]);
  });
});

describe("scope", () => {
  it("goes straight to the provider for an agent call under text_roles", async () => {
    const s = setup(() => json(200, message()), { scope: "text_roles" });
    const r = await collectTurn(s.provider.turn(req(), PROVIDER_KEY));
    expect(r.text).toBe("direct answer");
    expect(s.sent).toEqual([]);
  });
});
