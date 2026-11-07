import { describe, expect, it } from "vitest";
import { ModelCallReceipt } from "../contracts";
import { isVerifiable, optimizationsOf, toReceipt } from "./prune-receipt";

const ctx = { callId: "call_1", sessionId: "ses_01", role: "agent" as const, requestedModel: "claude-sonnet-4-5", at: "2026-11-07T03:15:00Z" };

describe("toReceipt", () => {
  it("maps a full prune_metadata to a contract-valid receipt", () => {
    const r = toReceipt({ routed_model: "claude-sonnet-4-5", cost_with_prune_usd: 0.004, cost_without_prune_usd: 0.007, optimizations_applied: ["prompt_trimmed"], receipt_signature: "c2ln" }, ctx);
    expect(ModelCallReceipt.safeParse(r).success).toBe(true);
    expect(r).toEqual({ callId: "call_1", sessionId: "ses_01", role: "agent", requestedModel: "claude-sonnet-4-5", servedModel: "claude-sonnet-4-5", costUsd: 0.004, baselineCostUsd: 0.007, optimizations: ["prompt_trimmed"], pruneReceiptId: "c2ln", at: ctx.at });
  });

  it("takes the served model from routed_model, never assuming the requested one", () => {
    expect(toReceipt({ routed_model: "other" }, ctx).servedModel).toBe("other");
    expect(toReceipt({}, ctx).servedModel).toBe("claude-sonnet-4-5");
  });

  it("flags a missing cost and a missing signature instead of inventing them", () => {
    const r = toReceipt({}, ctx);
    expect(r).toMatchObject({ costUsd: 0, optimizations: ["cost_unreported"], pruneReceiptId: "unsigned:call_1" });
    expect(r.baselineCostUsd).toBeUndefined();
  });

  it("ignores negative, non-finite and non-numeric costs", () => {
    const r = toReceipt({ cost_with_prune_usd: -1, cost_without_prune_usd: Number.NaN }, ctx);
    expect(r.costUsd).toBe(0);
    expect(r.baselineCostUsd).toBeUndefined();
    expect(toReceipt({ cost_with_prune_usd: "0.5" as unknown as number }, ctx).costUsd).toBe(0);
  });

  it("omits sessionId when there is none", () => {
    expect("sessionId" in toReceipt({}, { ...ctx, sessionId: undefined })).toBe(false);
  });
});

describe("optimizationsOf / isVerifiable", () => {
  it("lists reported optimizations, adding cache_hit once", () => {
    expect(optimizationsOf({ optimizations_applied: ["model_routing", 5, "output_cap:400"] })).toEqual(["model_routing", "output_cap:400"]);
    expect(optimizationsOf({ cache_hit: true, optimizations_applied: ["cache_hit"] })).toEqual(["cache_hit"]);
    expect(optimizationsOf({ cache_hit: true })).toEqual(["cache_hit"]);
    expect(optimizationsOf({ optimizations_applied: "nope" })).toEqual([]);
  });

  it("only a signed receipt can be checked on Prune's verify page", () => {
    expect(isVerifiable({ receipt_signature: "abc" })).toBe(true);
    expect(isVerifiable({ receipt_signature: "" })).toBe(false);
    expect(isVerifiable({})).toBe(false);
    expect(isVerifiable(undefined)).toBe(false);
  });
});
