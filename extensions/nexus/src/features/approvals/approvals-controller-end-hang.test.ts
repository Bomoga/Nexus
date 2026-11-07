import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../../contracts";
import { fx } from "../../contracts/fixtures";
import { SessionsController } from "../sessions/sessions-controller";
import { FakeGit, MemoryGate, MemoryStore, fakeClock } from "../testing/memory-ports";
import { ApprovalsController } from "./approvals-controller";

// A session ending must release every waiter before any store call, and must itself finish promptly even when the store hangs.

const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
const never = () => new Promise<never>(() => { /* a store read that never answers */ });
const runCmd = { kind: "run_command", command: "npm test" } as const;

function within<T>(p: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("HUNG: still pending")), ms))]);
}

async function setup() {
  const store = new MemoryStore();
  await store.putTask({ ...fx.task });
  const clock = fakeClock();
  const shown: Array<{ approval: ApprovalRequest; choose(d: "approved" | "rejected"): void }> = [];
  const logs: string[] = [];
  const ended: string[] = [];
  // eslint-disable-next-line prefer-const
  let approvalsRef!: ApprovalsController;
  const requester = { request: (i: Parameters<ApprovalsController["request"]>[0]) => approvalsRef.request(i), sessionEnded: (id: string, how: "cancelled" | "failed" | "done") => approvalsRef.sessionEnded(id, how) };
  const gate = new MemoryGate({ approvals: requester });
  const sessions = new SessionsController({
    store, git: new FakeGit(), gate, clock, machineId: "m_adrian", getKey: async () => "k", log: m => logs.push(m),
    host: { startSession: async () => ({}), cancelSession: async () => ({}), endSession: id => { ended.push(id); } },
    approvals: requester,
  });
  const approvals = new ApprovalsController({
    store, clock, sessions, log: m => logs.push(m), identity: () => "adrian",
    host: { sendEvent: () => true },
    notify: { show: (approval, _t, onChoice) => { shown.push({ approval, choose: onChoice }); }, update: () => {} },
  });
  approvalsRef = approvals;
  const session = await sessions.start("task_01", model);
  return { store, sessions, approvals, session, shown, logs, ended };
}

type S = Awaited<ReturnType<typeof setup>>;
const internals = (s: S) => s.approvals as unknown as { sessionOf: Map<string, string>; waiters: Map<string, unknown> };
const waitingTwo = async (s: S) => {
  const a1 = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "one" });
  const a2 = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "two" });
  const w1 = s.approvals.waitForDecision(a1.id).then(d => d, (e: Error) => e.message);
  const w2 = s.approvals.waitForDecision(a2.id).then(d => d, (e: Error) => e.message);
  await new Promise(r => setTimeout(r, 0));
  return { a1, a2, w1, w2 };
};

afterEach(() => { vi.restoreAllMocks(); });

describe("sessionEnded releases every waiter before any store call", () => {
  it("cancelled: a hung getApproval for the first approval still releases both waiters, as rejected", async () => {
    const s = await setup();
    const { a1, w1, w2 } = await waitingTwo(s);
    const real = s.store.getApproval.bind(s.store);
    vi.spyOn(s.store, "getApproval").mockImplementation(id => (id === a1.id ? never() : real(id)));
    await within(s.approvals.sessionEnded(s.session.id, "cancelled"));
    expect(await within(w1)).toBe("rejected");
    expect(await within(w2)).toBe("rejected");
  });

  it("failed and cancelled: sessionEnded itself returns promptly while getApproval hangs", async () => {
    for (const how of ["failed", "cancelled"] as const) {
      const s = await setup();
      await waitingTwo(s);
      vi.spyOn(s.store, "getApproval").mockImplementation(never);
      await within(s.approvals.sessionEnded(s.session.id, how), 2000);
    }
  });

  it("a session whose store getApproval hangs still ends: endSession is called and the stored session is no longer awaiting", async () => {
    const s = await setup();
    const result = s.approvals.waitForDecision((await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "r" })).id).then(() => "woke", (e: Error) => e.message);
    vi.spyOn(s.store, "getApproval").mockImplementation(never);
    await within(s.sessions.onProcessError(s.session.id, "crash"), 2500);
    expect(s.ended).toEqual([s.session.id]);
    expect((await s.store.getSession(s.session.id))!.status).toBe("failed");
    expect(await within(result)).toContain("nothing was approved");
  });

  it("cancelled: the cancelling human's rejection is still recorded in the background", async () => {
    const s = await setup();
    const { a1 } = await waitingTwo(s);
    await s.approvals.sessionEnded(s.session.id, "cancelled");
    await vi.waitFor(async () => expect(await s.store.getApproval(a1.id)).toMatchObject({ decision: "rejected", decidedBy: { via: "app", userId: "adrian" } }));
  });
});

describe("bookkeeping", () => {
  it("sessionOf stays bounded", async () => {
    const s = await setup();
    for (let i = 0; i < 300; i++) await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: String(i) });
    expect(internals(s).sessionOf.size).toBeLessThanOrEqual(256);
  });

  it("waitForDecision's promise is handled-safe: a caller that attaches late sees the error and no unhandled rejection fires", async () => {
    const s = await setup();
    const a = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "r" });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const late = s.approvals.waitForDecision(a.id);
      await s.approvals.sessionEnded(s.session.id, "failed");
      await new Promise(r => setTimeout(r, 30));                      // the caller is slow to attach
      expect(await late.then(() => "woke", (e: Error) => e.message)).toContain("nothing was approved");
      await new Promise(r => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally { process.off("unhandledRejection", onUnhandled); }
  });
});
