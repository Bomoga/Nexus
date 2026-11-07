import { afterEach, describe, expect, it, vi } from "vitest";
import { fx } from "../../contracts/fixtures";
import { SessionsController } from "../sessions/sessions-controller";
import { FakeGit, MemoryGate, MemoryStore, fakeClock } from "../testing/memory-ports";
import { ApprovalsController } from "./approvals-controller";

// Small leftovers: a decision racing a failed request, a read-back that outlives a cancel, an evicted pending approval.

const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
const human = { via: "slack", userId: "brandon" } as const;
const runCmd = { kind: "run_command", command: "npm test" } as const;
const never = () => new Promise<never>(() => { /* a store read that never answers */ });

function bounded<T>(p: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("HUNG: still pending")), ms))]);
}

async function setup() {
  const store = new MemoryStore();
  await store.putTask({ ...fx.task });
  const clock = fakeClock();
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
    notify: { show: () => {}, update: () => {} },
  });
  approvalsRef = approvals;
  const session = await sessions.start("task_01", model);
  return { store, sessions, approvals, session };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("approvals leftovers", () => {
  it("(a) an approve whose request failed while resolve() was reading is refused, nothing is written", async () => {
    const s = await setup();
    const a = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "r" });
    const real = s.store.getApproval.bind(s.store);
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let entered!: () => void;
    const inRead = new Promise<void>(r => { entered = r; });
    vi.spyOn(s.store, "getApproval").mockImplementationOnce(async id => { const row = await real(id); entered(); await held; return row; });
    const deciding = s.approvals.resolve(a.id, "approved", human);
    await inRead;
    await (s.approvals as unknown as { markDead(a: unknown): Promise<void> }).markDead(a);   // the gate's request failed meanwhile
    release();
    const res = await bounded(deciding);
    expect(res.won).toBe(false);
    expect((await s.store.getApproval(a.id))!.decision).toBeUndefined();
  });

  it("(c) the read-back after a decision does not outlive a cancelled session", async () => {
    const s = await setup();
    const real = s.store.decideApproval.bind(s.store);
    let hang = false;
    vi.spyOn(s.store, "decideApproval").mockImplementation(async (...a) => { const r = await real(...a); hang = true; return r; });
    const realGet = s.store.getApproval.bind(s.store);
    vi.spyOn(s.store, "getApproval").mockImplementation(id => (hang ? never() : realGet(id)));
    const asking = s.approvals.request({ sessionId: s.session.id, action: runCmd, reason: "r" }).then(r => r.decision);
    await new Promise(r => setTimeout(r, 20));
    const [pending] = await s.store.listApprovals();
    await s.approvals.resolve(pending.id, "approved", human);
    await new Promise(r => setTimeout(r, 20));                         // request() is now stuck in its read-back
    await bounded(s.sessions.cancel(s.session.id), 2000);
    expect(await bounded(asking)).toBe("approved");                   // the human's decision stands; the read just stopped being awaited
  });

  it("(d) an approval pushed out of sessionOf still learns that its session ended", async () => {
    const s = await setup();
    const first = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "first" });
    for (let i = 0; i < 300; i++) await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: String(i) });
    expect((s.approvals as unknown as { sessionOf: Map<string, string> }).sessionOf.has(first.id)).toBe(false);
    await s.approvals.sessionEnded(s.session.id, "failed");
    vi.spyOn(s.store, "getApproval").mockImplementation(async () => undefined);   // the row is missing: only the session knowledge can answer
    await expect(bounded(s.approvals.waitForDecision(first.id))).rejects.toThrow(/nothing to approve/);
  });
});
