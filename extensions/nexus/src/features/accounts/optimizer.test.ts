import { describe, expect, it, vi } from "vitest";
import { DEFAULT_OPTIMIZER, Requests, type ModelCallReceipt } from "../../contracts";
import { fx, } from "../../contracts/fixtures";
import { scriptedReceipts } from "../../contracts/fixtures/stream";
import { MemoryStore } from "../testing/memory-ports";
import type { StateStore } from "./accounts-service";
import { OPTIMIZER_STATE_KEY, OptimizerService, PASSTHROUGH_STATE_KEY, optimizerBridgeHandlers, receiptSubscriptions, summarize } from "./optimizer";

function setup(opts: { key?: string | undefined; verified?: boolean } = {}) {
  const map = new Map<string, unknown>();
  if (opts.verified) map.set(PASSTHROUGH_STATE_KEY, true);
  const state: StateStore = { get: <T>(k: string) => map.get(k) as T | undefined, update: async (k, v) => { map.set(k, v); } };
  const store = new MemoryStore();
  const service = new OptimizerService({ state, store, getPruneKey: async () => ("key" in opts ? opts.key : "prune_key") });
  return { service, store, map };
}

const receipt = (over: Partial<ModelCallReceipt> = {}): ModelCallReceipt => ({ ...fx.receipt, callId: "c1", pruneReceiptId: "sig1", ...over });

describe("setting", () => {
  it("is off by default, text roles only, no model routing", () => {
    expect(setup().service.get()).toEqual(DEFAULT_OPTIMIZER);
    expect(DEFAULT_OPTIMIZER).toEqual({ enabled: false, scope: "text_roles", allowModelRouting: false });
  });

  it("toggle turns it on only when a Prune key exists, and persists the choice", async () => {
    const s = setup();
    expect((await s.service.toggle()).enabled).toBe(true);
    expect(s.service.get().enabled).toBe(true);
    expect(s.map.get(OPTIMIZER_STATE_KEY)).toMatchObject({ enabled: true });
    expect((await s.service.toggle()).enabled).toBe(false);
    const noKey = setup({ key: undefined });
    await expect(noKey.service.toggle()).rejects.toThrow("Connect a Prune key");
    expect(noKey.service.get().enabled).toBe(false);
  });

  it("turning it off never needs a key", async () => {
    const s = setup();
    await s.service.toggle();
    const noKey = new OptimizerService({ state: { get: <T>(k: string) => s.map.get(k) as T | undefined, update: async (k, v) => { s.map.set(k, v); } }, store: s.store, getPruneKey: async () => undefined });
    expect((await noKey.toggle()).enabled).toBe(false);
  });

  it("scope all_roles is settable only after the tool-calling check passed", async () => {
    const s = setup();
    await expect(s.service.set({ enabled: true, scope: "all_roles", allowModelRouting: false })).rejects.toThrow("live tool-calling check");
    const ok = setup({ verified: true });
    expect((await ok.service.set({ enabled: true, scope: "all_roles", allowModelRouting: false })).scope).toBe("all_roles");
  });

  it("falls back to the default when the saved value is corrupt, and notifies listeners of changes", async () => {
    const s = setup();
    s.map.set(OPTIMIZER_STATE_KEY, { enabled: "yes" });
    expect(s.service.get()).toEqual(DEFAULT_OPTIMIZER);
    const seen: boolean[] = [];
    const stop = s.service.onSettingChange(x => seen.push(x.enabled));
    await s.service.toggle();
    stop();
    await s.service.toggle();
    expect(seen).toEqual([true]);
  });
});

describe("pruneFor (what the agent process may do with Prune)", () => {
  it("is disabled while the toggle is off, and for the agent role under text_roles", async () => {
    const s = setup();
    expect(await s.service.pruneFor("agent")).toEqual({ enabled: false });
    await s.service.toggle();
    expect(await s.service.pruneFor("agent")).toEqual({ enabled: false });          // text_roles: the agent talks to its provider directly
    expect(await s.service.pruneFor("summary")).toEqual({ enabled: true, apiKey: "prune_key" });
  });

  it("includes the agent under all_roles, and is disabled without a key", async () => {
    const s = setup({ verified: true });
    await s.service.set({ enabled: true, scope: "all_roles", allowModelRouting: false });
    expect(await s.service.pruneFor("agent")).toEqual({ enabled: true, apiKey: "prune_key" });
    const lost = new OptimizerService({ state: { get: <T>(k: string) => s.map.get(k) as T | undefined, update: async () => {} }, store: s.store, getPruneKey: async () => undefined });
    expect(await lost.pruneFor("agent")).toEqual({ enabled: false });
  });
});

describe("receipts, totals and the status bar", () => {
  it("records receipts in the shared store and publishes them", async () => {
    const s = setup();
    const seen: string[] = [];
    s.service.subscribe(r => seen.push(r.callId));
    await s.service.record(receipt());
    expect(await s.store.listReceipts()).toHaveLength(1);
    expect(seen).toEqual(["c1"]);
  });

  it("totals cost and savings, counting savings only where a baseline is known and never negative", () => {
    const sum = summarize([receipt({ costUsd: 0.004, baselineCostUsd: 0.007 }), receipt({ callId: "c2", costUsd: 0.01 }), receipt({ callId: "c3", costUsd: 0.02, baselineCostUsd: 0.01 })], "ses_01");
    expect(sum.calls).toBe(3);
    expect(sum.costUsd).toBeCloseTo(0.034, 6);
    expect(sum.savedUsd).toBeCloseTo(0.003, 6);
    expect(sum.sessionId).toBe("ses_01");
    expect(summarize([]).sessionId).toBeUndefined();
  });

  it("matches the fixture stream: four receipts for ses_01, two cache hits", async () => {
    const s = setup();
    for (const r of scriptedReceipts) await s.service.record(r);
    const { receipts, summary } = await s.service.list("ses_01");
    expect(receipts).toHaveLength(4);
    expect(summary.calls).toBe(4);
    expect(summary.savedUsd).toBeGreaterThan(0);
    expect((await s.service.list("other")).summary.calls).toBe(0);
    expect((await s.service.list(undefined, 2)).receipts).toHaveLength(2);
  });

  it("shows 'PRUNE $cost · saved $saved' once something was spent or while it is on, and nothing otherwise", async () => {
    const s = setup();
    expect(await s.service.statusText()).toBeUndefined();
    await s.service.record(receipt({ costUsd: 0.0123, baselineCostUsd: 0.0333, sessionId: "ses_01" }));
    expect(await s.service.statusText("ses_01")).toBe("PRUNE $0.0123 · saved $0.0210");
    expect(await s.service.statusText("other")).toBeUndefined();
    const on = setup();
    await on.service.toggle();
    expect(await on.service.statusText()).toBe("PRUNE $0.0000 · saved $0.0000");
  });

  it("formats dollars above $1 with cents", async () => {
    const s = setup();
    await s.service.record(receipt({ costUsd: 2.5, baselineCostUsd: 10 }));
    expect(await s.service.statusText()).toBe("PRUNE $2.50 · saved $7.50");
  });
});

describe("openReceipt", () => {
  it("hands back the verify page and the signed metadata for a receipt this window recorded", async () => {
    const s = setup();
    await s.service.record(receipt(), { receipt_signature: "sig1", routed_model: "m" });
    const link = await s.service.openReceipt("sig1");
    expect(link.verifyUrl).toBe("https://withprune.com/verify");
    expect(JSON.parse(link.metadataJson!)).toEqual({ receipt_signature: "sig1", routed_model: "m" });
    expect(link.message).toMatch(/clipboard/);
  });

  it("explains an unsigned receipt, a receipt whose signed copy is gone, and an unknown id", async () => {
    const s = setup();
    await s.service.record(receipt({ callId: "c2", pruneReceiptId: "unsigned:c2" }));
    expect((await s.service.openReceipt("unsigned:c2")).message).toMatch(/nothing to verify/);
    await s.service.record(receipt());                                                 // recorded without metadata
    const gone = await s.service.openReceipt("sig1");
    expect(gone.metadataJson).toBeUndefined();
    expect(gone.message).toMatch(/dashboard/);
    await expect(s.service.openReceipt("nope")).rejects.toThrow("No such receipt");
  });
});

describe("bridge", () => {
  it("serves optimizer.get/set and receipts.list with contract-shaped responses, and filters the subscription by session", async () => {
    const s = setup();
    const h = optimizerBridgeHandlers(s.service);
    Requests["optimizer.get"].res.parse(await h["optimizer.get"]());
    Requests["optimizer.set"].res.parse(await h["optimizer.set"]({ enabled: true, scope: "text_roles", allowModelRouting: false }));
    await s.service.record(receipt({ sessionId: "ses_01" }));
    Requests["receipts.list"].res.parse(await h["receipts.list"]({ limit: 100 }));
    const mine = vi.fn(), theirs = vi.fn();
    receiptSubscriptions(s.service)["receipts.subscribe"]({ sessionId: "ses_01" }, mine);
    receiptSubscriptions(s.service)["receipts.subscribe"]({ sessionId: "other" }, theirs);
    await s.service.record(receipt({ callId: "c9", sessionId: "ses_01", pruneReceiptId: "sig9" }));
    expect(mine).toHaveBeenCalledTimes(1);
    expect(theirs).not.toHaveBeenCalled();
  });
});
