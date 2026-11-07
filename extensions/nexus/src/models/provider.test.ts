import { describe, expect, it } from "vitest";
import { fx } from "../contracts/fixtures";
import { FAKE_AGENT_SCRIPT, FakeProvider, keyFingerprint } from "./fake-provider";
import { ListingCache } from "./listing-cache";
import { ProviderAuthError, collectTurn, roleEligible, type TurnRequest } from "./provider";

const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({
  modelId: "claude-sonnet-4-5", role: "agent", system: "s", messages: [{ role: "user", content: "go" }], tools: [], ...over,
});

describe("FakeProvider", () => {
  it("yields the scripted tool calls in order, one turn per call", async () => {
    const p = new FakeProvider();
    const names: string[] = [];
    for (let i = 0; i < FAKE_AGENT_SCRIPT.length; i++) {
      const r = await collectTurn(p.turn(req(), "k"));
      names.push(...r.toolCalls.map(t => t.name));
      expect(r.done).toBeDefined();
    }
    expect(names).toEqual(["read_file", "write_file", "run_command", "commit"]);
  });

  it("ends the script with an end_turn text answer", async () => {
    const p = new FakeProvider({ script: FAKE_AGENT_SCRIPT.slice(-1) });
    const r = await collectTurn(p.turn(req(), "k"));
    expect(r.text).toMatch(/Fixed/);
    expect(r.done?.stopReason).toBe("end_turn");
    expect(r.toolCalls).toEqual([]);
  });

  it("reports an error event once the script is exhausted", async () => {
    const p = new FakeProvider({ script: [] });
    expect((await collectTurn(p.turn(req(), "k"))).error).toMatch(/exhausted/);
  });

  it("is deterministic: two providers replay identical events", async () => {
    const a = await collectTurn(new FakeProvider().turn(req(), "k"));
    const b = await collectTurn(new FakeProvider().turn(req(), "k"));
    expect(a).toEqual(b);
  });

  it("stops with stopReason cancelled when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await collectTurn(new FakeProvider().turn(req({ signal: ac.signal }), "k"));
    expect(r.done?.stopReason).toBe("cancelled");
    expect(r.toolCalls).toEqual([]);
  });

  it("records requests and a fingerprint of the key on each call, and never holds a key", async () => {
    const p = new FakeProvider();
    await p.listModels("sk-key-1");
    await collectTurn(p.turn(req(), "sk-key-2"));
    expect(p.keyFingerprints).toEqual([keyFingerprint("sk-key-1"), keyFingerprint("sk-key-2")]);
    expect(p.requests).toHaveLength(1);
    expect(JSON.stringify(p)).not.toContain("sk-key");
    expect(JSON.stringify(Object.values(p))).not.toContain("sk-key");
  });

  it("lists the fixture models for its provider and can fail with an auth error", async () => {
    expect((await new FakeProvider().listModels("k")).map(m => m.provider)).toEqual(["anthropic"]);
    const bad = new FakeProvider({ listError: new ProviderAuthError() });
    await expect(bad.listModels("k")).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

describe("roleEligible", () => {
  const [anthropic, google, swarms] = fx.models;
  it("never offers Swarms for the agent role", () => {
    expect(roleEligible(swarms, "agent")).toBe(false);
  });
  it("offers Swarms for every text role", () => {
    for (const role of ["brief", "summary", "approval_wording", "swarm_input"] as const) expect(roleEligible(swarms, role)).toBe(true);
  });
  it("offers tool-capable Anthropic and Gemini models for the agent", () => {
    expect(roleEligible(anthropic, "agent")).toBe(true);
    expect(roleEligible(google, "agent")).toBe(true);
  });
  it("requires tool support for the agent role", () => {
    expect(roleEligible({ provider: "ollama", supportsTools: false }, "agent")).toBe(false);
    expect(roleEligible({ provider: "ollama", supportsTools: false }, "summary")).toBe(true);
  });
});

describe("ListingCache", () => {
  it("treats an unlisted account as missing, never connected", () => {
    expect(new ListingCache().statusOf("acc_anthropic")).toBe("missing");
  });

  it("is connected only after a successful listing, and keeps the models", () => {
    let t = 1000;
    const c = new ListingCache(() => t);
    c.recordSuccess("acc_anthropic", [fx.models[0]]);
    t = 4000;
    expect(c.statusOf("acc_anthropic")).toBe("connected");
    expect(c.get("acc_anthropic")).toMatchObject({ status: "connected", at: 1000 });
    expect(c.ageMs("acc_anthropic")).toBe(3000);
  });

  it("a failure drops the old models and flips the status", () => {
    const c = new ListingCache();
    c.recordSuccess("a", [fx.models[0]]);
    c.recordFailure("a", "invalid");
    expect(c.statusOf("a")).toBe("invalid");
    expect(c.get("a")?.models).toEqual([]);
  });

  it("shows only models of connected accounts", () => {
    const c = new ListingCache();
    c.recordSuccess("a", [fx.models[0]]);
    c.recordSuccess("b", [fx.models[1]]);
    c.recordFailure("b", "invalid");
    expect(c.connectedModels().map(m => m.modelId)).toEqual(["claude-sonnet-4-5"]);
  });

  it("returns copies, so callers cannot mutate the cache", () => {
    const c = new ListingCache();
    c.recordSuccess("a", [{ ...fx.models[0] }]);
    c.get("a")!.models[0].displayName = "hacked";
    expect(c.get("a")!.models[0].displayName).toBe("Claude Sonnet 4.5");
  });
});
