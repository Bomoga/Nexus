import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../../contracts";
import { fx } from "../../contracts/fixtures";
import { SessionsController } from "../sessions/sessions-controller";
import { FakeGit, MemoryGate, MemoryStore, fakeClock } from "../testing/memory-ports";
import { ApprovalsController } from "./approvals-controller";

// Hang-path audit (S5-T4): when the store throws on I/O, the agent's waiting gate must be released (or refused with an
// error), never left pending forever. Every await goes through `bounded`, so a hang fails the test instead of the run.

const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
const boom = () => Promise.reject(new Error("store I/O failed"));

function bounded<T>(p: Promise<T>, ms = 1500): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("HUNG: still pending")), ms))]);
}

async function setup() {
  const store = new MemoryStore();
  await store.putTask({ ...fx.task });
  const clock = fakeClock();
  const shown: Array<{ approval: ApprovalRequest; choose(d: "approved" | "rejected"): void }> = [];
  const logs: string[] = [];
  // eslint-disable-next-line prefer-const
  let approvalsRef!: ApprovalsController;
  const requester = { request: (i: Parameters<ApprovalsController["request"]>[0]) => approvalsRef.request(i), sessionEnded: (id: string, how: "cancelled" | "failed" | "done") => approvalsRef.sessionEnded(id, how) };
  const gate = new MemoryGate({ approvals: requester });
  const sessions = new SessionsController({
    store, git: new FakeGit(), gate, clock, machineId: "m_adrian", getKey: async () => "k", log: m => logs.push(m),
    host: { startSession: async () => ({}), cancelSession: async () => ({}), endSession: () => {} },
    approvals: requester,
  });
  const approvals = new ApprovalsController({
    store, clock, sessions, log: m => logs.push(m), identity: () => "adrian",
    host: { sendEvent: () => true },
    notify: { show: (approval, _t, onChoice) => shown.push({ approval, choose: onChoice }), update: () => {} },
  });
  approvalsRef = approvals;
  const session = await sessions.start("task_01", model);
  const runCommand = () => gate.request(session, "cmd.run", { command: "npm test", timeoutMs: 1000 }).then(() => "ran", (e: Error) => e.message);
  return { store, sessions, approvals, session, shown, logs, runCommand };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("approvals: store failures never leave the agent waiting", () => {
  it("settle: a store failure while recording the decision still wakes the waiter with the human's decision", async () => {
    const s = await setup();
    const result = s.runCommand();
    await vi.waitFor(() => expect(s.shown).toHaveLength(1));
    vi.spyOn(s.store, "appendAgentEvent").mockImplementation(boom);
    vi.spyOn(s.store, "putSession").mockImplementation(boom);
    s.shown[0].choose("approved");
    expect(await bounded(result)).toBe("ran");
  });

  it("waitForDecision: a failing store read rejects instead of hanging, and a later decision does not break anything", async () => {
    const s = await setup();
    const a = await s.approvals.create({ sessionId: s.session.id, action: { kind: "run_command", command: "npm test" }, reason: "r" });
    const spy = vi.spyOn(s.store, "getApproval").mockImplementation(boom);
    await expect(bounded(s.approvals.waitForDecision(a.id))).rejects.toThrow("store I/O failed");
    expect((s.approvals as unknown as { waiters: Map<string, unknown> }).waiters.size).toBe(0);
    spy.mockRestore();
    const res = await bounded(s.approvals.resolve(a.id, "approved", { via: "slack", userId: "brandon" }));
    expect(res.won).toBe(true);
  });

  it("request: a failing read-back after the decision still returns the human's decision", async () => {
    const s = await setup();
    const p = s.approvals.request({ sessionId: s.session.id, action: { kind: "run_command", command: "npm test" }, reason: "r" });
    await vi.waitFor(() => expect(s.shown).toHaveLength(1));
    const real = s.store.getApproval.bind(s.store);
    let reads = 0;                                                 // resolve() reads once; every read after it fails
    vi.spyOn(s.store, "getApproval").mockImplementation(id => (++reads === 1 ? real(id) : boom()));
    s.shown[0].choose("approved");
    expect((await bounded(p)).decision).toBe("approved");
  });

  it("create: a store failure after the request was written rejects (the agent gets an error) and leaves nothing parked", async () => {
    const s = await setup();
    vi.spyOn(s.store, "getApproval").mockImplementationOnce(boom);
    await expect(bounded(s.approvals.create({ sessionId: s.session.id, action: { kind: "run_command", command: "npm test" }, reason: "r" }))).rejects.toThrow("store I/O failed");
    // The approval is on screen: a human deciding it must still be recorded and announced, not parked forever.
    const [stored] = await s.store.listApprovals();
    const res = await bounded(s.approvals.resolve(stored.id, "approved", { via: "slack", userId: "brandon" }));
    expect(res.won).toBe(true);
    expect(s.logs.join("\n")).not.toMatch(/HUNG/);
    expect((s.approvals as unknown as { creating: Map<string, unknown> }).creating.size).toBe(0);
  });

  it("create: putApproval failing rejects and leaves no pending entry", async () => {
    const s = await setup();
    vi.spyOn(s.store, "putApproval").mockImplementation(boom);
    await expect(bounded(s.approvals.create({ sessionId: s.session.id, action: { kind: "run_command", command: "npm test" }, reason: "r" }))).rejects.toThrow("store I/O failed");
    expect((s.approvals as unknown as { pending: Map<string, string> }).pending.size).toBe(0);
  });

  it("sessionEnded(cancelled): the store failing to record the cancel still releases the waiter as rejected, with no decision written", async () => {
    const s = await setup();
    const result = s.runCommand();
    await vi.waitFor(() => expect(s.shown).toHaveLength(1));
    const id = s.shown[0].approval.id;
    vi.spyOn(s.store, "decideApproval").mockImplementation(boom);
    await bounded(s.sessions.cancel(s.session.id));
    expect(await bounded(result)).toBe("rejected by a human");
    expect((await s.store.getApproval(id))!.decision).toBeUndefined();
    await expect(s.approvals.resolve(id, "approved", { via: "slack", userId: "brandon" })).rejects.toThrow("session has ended");
  });

  it("sessionEnded(failed): a completely failing store still releases the waiter as rejected, without a decision", async () => {
    const s = await setup();
    const result = s.runCommand();
    await vi.waitFor(() => expect(s.shown).toHaveLength(1));
    const id = s.shown[0].approval.id;
    for (const m of ["putSession", "putTask", "appendAgentEvent", "getApproval", "decideApproval", "getSession"] as const) vi.spyOn(s.store, m).mockImplementation(boom);
    await bounded(s.sessions.onProcessError(s.session.id, "agent process crashed"));
    expect(await bounded(result)).toBe("rejected by a human");
    expect(s.store.approvals.get(id)!.decision).toBeUndefined();
  });
});
