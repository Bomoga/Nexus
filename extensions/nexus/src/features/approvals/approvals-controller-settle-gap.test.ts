import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../../contracts";
import { fx } from "../../contracts/fixtures";
import { SessionsController } from "../sessions/sessions-controller";
import { FakeGit, MemoryGate, MemoryStore, fakeClock } from "../testing/memory-ports";
import { ApprovalsController } from "./approvals-controller";

// Gap between "decision applied" and "waiters woken", an early rejection nobody handles, and a hung read that must not hold
// back another approval's release.

const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
const human = { via: "slack", userId: "brandon" } as const;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function bounded<T>(p: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("HUNG: still pending")), ms))]);
}

async function setup() {
  const store = new MemoryStore();
  await store.putTask({ ...fx.task });
  const clock = fakeClock();
  const shown: Array<{ approval: ApprovalRequest }> = [];
  // eslint-disable-next-line prefer-const
  let approvalsRef!: ApprovalsController;
  const requester = { request: (i: Parameters<ApprovalsController["request"]>[0]) => approvalsRef.request(i), sessionEnded: (id: string, how: "cancelled" | "failed" | "done") => approvalsRef.sessionEnded(id, how) };
  const gate = new MemoryGate({ approvals: requester });
  const sessions = new SessionsController({
    store, git: new FakeGit(), gate, clock, machineId: "m_adrian", getKey: async () => "k",
    host: { startSession: async () => ({}), cancelSession: async () => ({}), endSession: () => {} },
    approvals: requester,
  });
  const approvals = new ApprovalsController({
    store, clock, sessions, identity: () => "adrian",
    host: { sendEvent: () => true },
    notify: { show: approval => { shown.push({ approval }); }, update: () => {} },
  });
  approvalsRef = approvals;
  const session = await sessions.start("task_01", model);
  const action = { kind: "run_command", command: "npm test" } as const;
  return { store, sessions, approvals, session, shown, action };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("approvals: settle gap, early rejection, hung refresh", () => {
  it("a human decision applied but not yet woken is returned even when the store read finds no row", async () => {
    const s = await setup();
    const a = await s.approvals.create({ sessionId: s.session.id, action: s.action, reason: "r" });
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const realEmit = s.sessions.emit.bind(s.sessions);
    let entered!: () => void;
    const inGap = new Promise<void>(r => { entered = r; });
    vi.spyOn(s.sessions, "emit").mockImplementation(async (id, ev) => { if (ev.type === "approval_resolved") { entered(); await held; } return realEmit(id, ev); });
    const resolving = s.approvals.resolve(a.id, "approved", human);
    await bounded(inGap);                                             // settle() has cleared `pending` but not woken anyone
    vi.spyOn(s.store, "getApproval").mockResolvedValue(undefined);
    const waiting = s.approvals.waitForDecision(a.id);
    release();
    await resolving;
    expect(await bounded(waiting)).toBe("approved");
  });

  it("a decision applied before waitForDecision is called is not lost", async () => {
    const s = await setup();
    const a = await s.approvals.create({ sessionId: s.session.id, action: s.action, reason: "r" });
    await s.approvals.resolve(a.id, "rejected", human);
    vi.spyOn(s.store, "getApproval").mockResolvedValue(undefined);
    expect(await bounded(s.approvals.waitForDecision(a.id))).toBe("rejected");
  });

  it("a missing row for a live approval keeps waiting", async () => {
    const s = await setup();
    const a = await s.approvals.create({ sessionId: s.session.id, action: s.action, reason: "r" });
    vi.spyOn(s.store, "getApproval").mockResolvedValue(undefined);
    const waiting = s.approvals.waitForDecision(a.id);
    expect(await Promise.race([waiting, sleep(50).then(() => "still waiting")])).toBe("still waiting");
    await s.approvals.sessionEnded(s.session.id, "failed");
    await expect(waiting).rejects.toThrow("the session ended (failed)");
  });

  it("sessionEnded(failed) while the store read is slow rejects the waiter without an unhandled rejection", async () => {
    const s = await setup();
    const a = await s.approvals.create({ sessionId: s.session.id, action: s.action, reason: "r" });
    const real = s.store.getApproval.bind(s.store);
    vi.spyOn(s.store, "getApproval").mockImplementation(async id => { await sleep(30); return real(id); });
    const waiting = s.approvals.waitForDecision(a.id);
    const outcome = waiting.then(() => "woken", (e: Error) => e.message);   // the caller awaits at once, as request() does
    void s.approvals.sessionEnded(s.session.id, "failed");
    await sleep(80);                                                  // the rejection lands while nobody has awaited `waiting` yet
    expect(await outcome).toBe("the session ended (failed); nothing was approved");
  });

  it("a hung refresh read of one approval never holds back the session's other waiter", async () => {
    const s = await setup();
    const a1 = await s.approvals.create({ sessionId: s.session.id, action: s.action, reason: "one" });
    const a2 = await s.approvals.create({ sessionId: s.session.id, action: { kind: "run_command", command: "npm run lint" }, reason: "two" });
    const w1 = s.approvals.waitForDecision(a1.id).then(() => "woken", (e: Error) => e.message);
    const w2 = s.approvals.waitForDecision(a2.id).then(() => "woken", (e: Error) => e.message);
    await sleep(10);
    const real = s.store.getApproval.bind(s.store);
    vi.spyOn(s.store, "getApproval").mockImplementation(id => (id === a1.id ? new Promise<never>(() => {}) : real(id)));
    void s.approvals.sessionEnded(s.session.id, "failed");
    expect(await bounded(w1)).toBe("the session ended (failed); nothing was approved");
    expect(await bounded(w2)).toBe("the session ended (failed); nothing was approved");
  });
});
