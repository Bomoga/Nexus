import { describe, expect, it, vi } from "vitest";
import { connectSlackApprovals, type SlackApprovalResolver } from "./slack-approvals";

const approval = { id: "apr_1", sessionId: "ses_1", action: { kind: "commit", message: "m" }, reason: "r", requestedAt: "2026-11-07T00:00:00.000Z" } as never;
const by = { via: "slack", userId: "U1" } as never;

describe("connectSlackApprovals", () => {
  it("gives Lane 2 a resolver that reaches the controller with the same arguments and returns its answer", async () => {
    let given: SlackApprovalResolver | undefined;
    const resolve = vi.fn(async () => ({ won: true, approval }));
    connectSlackApprovals({ setSlackApprovalResolver: r => { given = r; } }, { resolve });
    expect(given).toBeDefined();
    const out = await given!("apr_1", "approved", by);
    expect(resolve).toHaveBeenCalledWith("apr_1", "approved", by);
    expect(out).toEqual({ won: true, approval });
  });
  it("passes a lost race through unchanged (first answer wins)", async () => {
    let given: SlackApprovalResolver | undefined;
    const lost = { won: false, approval: { ...(approval as object), decision: "rejected" } as never };
    connectSlackApprovals({ setSlackApprovalResolver: r => { given = r; } }, { resolve: async () => lost });
    expect(await given!("apr_1", "approved", by)).toBe(lost);
  });
  it("does nothing when Lane 2 gave no setter", () => {
    expect(() => connectSlackApprovals({}, { resolve: vi.fn() as never })).not.toThrow();
  });
});
