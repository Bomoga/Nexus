import { describe, expect, it, vi } from "vitest";
import { makeCibaHook } from "./ciba-hook";
import type { CibaOutcome } from "./ciba";

const approval = { id: "apr_1", sessionId: "ses_abcdefgh12", action: { kind: "commit", message: "m" }, reason: "r", requestedAt: "2026-11-07T00:00:00.000Z" } as never;
const by = { via: "auth0_push", userId: "auth0|me", auth0UserId: "auth0|me" } as const;
const make = (out: CibaOutcome | Error, approver: string | null = "auth0|me") => {
  const resolve = vi.fn(async () => ({}));
  const requestApproval = vi.fn(async (_r: unknown) => { if (out instanceof Error) throw out; return out; });
  const log = vi.fn();
  return { resolve, requestApproval, log, hook: makeCibaHook({ client: { requestApproval }, approverAuth0UserId: () => approver ?? undefined, resolve, log }) };
};

describe("ciba hook", () => {
  it("records an approved phone answer through resolve with the push identity", async () => {
    const t = make({ status: "approved", decidedBy: by });
    await t.hook.onCreated(approval);
    expect(t.resolve).toHaveBeenCalledWith("apr_1", "approved", by);
  });
  it("records a rejection too", async () => {
    const t = make({ status: "rejected", decidedBy: by });
    await t.hook.onCreated(approval);
    expect(t.resolve).toHaveBeenCalledWith("apr_1", "rejected", by);
  });
  it.each(["timeout", "expired", "error", "cancelled", "decided_elsewhere"] as const)("never decides on no_answer (%s)", async reason => {
    const t = make({ status: "no_answer", reason });
    await t.hook.onCreated(approval);
    expect(t.resolve).not.toHaveBeenCalled();
  });
  it("skips the push when nobody is signed in", async () => {
    const t = make({ status: "approved", decidedBy: by }, null);
    await t.hook.onCreated(approval);
    expect(t.requestApproval).not.toHaveBeenCalled();
    expect(t.resolve).not.toHaveBeenCalled();
  });
  it("does not throw or decide when the client throws", async () => {
    const t = make(new Error("boom"));
    await expect(t.hook.onCreated(approval)).resolves.toBeUndefined();
    expect(t.resolve).not.toHaveBeenCalled();
    expect(t.log).toHaveBeenCalled();
  });
  it("swallows a lost race when resolve rejects", async () => {
    const t = make({ status: "approved", decidedBy: by });
    t.resolve.mockRejectedValueOnce(new Error("session ended"));
    await expect(t.hook.onCreated(approval)).resolves.toBeUndefined();
  });
  it("cancel aborts the in-flight request", async () => {
    let seen: AbortSignal | undefined;
    const requestApproval = vi.fn(async (r: { signal?: AbortSignal }) => { seen = r.signal; await new Promise(res => r.signal?.addEventListener("abort", () => res(null))); return { status: "no_answer", reason: "cancelled" } as CibaOutcome; });
    const hook = makeCibaHook({ client: { requestApproval }, approverAuth0UserId: () => "auth0|me", resolve: vi.fn() });
    const p = hook.onCreated(approval);
    await Promise.resolve(); await Promise.resolve();
    hook.cancel("apr_1");
    await p;
    expect(seen?.aborted).toBe(true);
  });
});
