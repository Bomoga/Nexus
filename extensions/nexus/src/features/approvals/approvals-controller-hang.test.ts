import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../../contracts";
import { fx } from "../../contracts/fixtures";
import { SessionsController } from "../sessions/sessions-controller";
import { FakeGit, MemoryGate, MemoryStore, fakeClock } from "../testing/memory-ports";
import { ApprovalConflict, ApprovalsController, approvalsBridgeHandlers } from "./approvals-controller";

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
  const updates: Array<{ id: string; text: string }> = [];
  const hostEvents: Array<{ approvalId: string; decision: string }> = [];
  const flags = { updateThrows: false };
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
    host: { sendEvent: (_n, body) => { hostEvents.push(body); return true; } },
    notify: { show: (approval, _t, onChoice) => shown.push({ approval, choose: onChoice }), update: (id, text) => { updates.push({ id, text }); if (flags.updateThrows) throw new Error("ui exploded"); } },
  });
  approvalsRef = approvals;
  const session = await sessions.start("task_01", model);
  const runCommand = () => gate.request(session, "cmd.run", { command: "npm test", timeoutMs: 1000 }).then(() => "ran", (e: Error) => e.message);
  return { store, sessions, approvals, session, shown, logs, updates, hostEvents, flags, runCommand };
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
    expect(s.sessions.activeSession?.status).toBe("running");        // the failed event write must not leave it showing "awaiting_approval"
    expect(s.hostEvents).toHaveLength(1);
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

  const create = (s: Awaited<ReturnType<typeof setup>>) => s.approvals.create({ sessionId: s.session.id, action: { kind: "run_command", command: "npm test" }, reason: "r" });
  const internals = (s: Awaited<ReturnType<typeof setup>>) => s.approvals as unknown as { creating: Map<string, unknown>; pending: Map<string, string> };

  it("create: a failure after the request was announced kills it: the notification is cleared and every later decision is refused, nothing written", async () => {
    const s = await setup();
    vi.spyOn(s.store, "getApproval").mockImplementationOnce(boom);
    await expect(bounded(create(s))).rejects.toThrow("store I/O failed");
    const [stored] = await s.store.listApprovals();
    expect(s.updates.at(-1)).toMatchObject({ id: stored.id, text: expect.stringContaining("nothing to approve") });
    const res = await bounded(s.approvals.resolve(stored.id, "approved", { via: "slack", userId: "brandon" }));
    expect(res.won).toBe(false);
    s.shown[0].choose("approved");                                   // the on-screen button, too
    await new Promise(r => setTimeout(r, 20));
    expect((await s.store.getApproval(stored.id))!.decision).toBeUndefined();
    expect(await s.approvals.list({ pendingOnly: true })).toEqual([]);
    expect(internals(s).creating.size).toBe(0);
    expect(internals(s).pending.size).toBe(0);
  });

  it("create: after that failure the session is not left showing awaiting_approval", async () => {
    const s = await setup();
    vi.spyOn(s.store, "getApproval").mockImplementationOnce(boom);
    await expect(bounded(create(s))).rejects.toThrow("store I/O failed");
    expect((await s.store.getSession(s.session.id))!.status).toBe("running");
    expect((await s.store.getTask("task_01"))!.status).toBe("running");
  });

  it("create: if restoring the status also fails, the original error still surfaces and the failure is logged", async () => {
    const s = await setup();
    vi.spyOn(s.store, "getApproval").mockImplementationOnce(() => { vi.spyOn(s.store, "putSession").mockImplementation(boom); return boom(); });
    await expect(bounded(create(s))).rejects.toThrow("store I/O failed");
    expect(s.logs.some(l => l.includes("could not restore the session status"))).toBe(true);
  });

  it("create: a human decision parked during the failing read is still recorded and delivered", async () => {
    const s = await setup();
    const real = s.store.getApproval.bind(s.store);
    let reads = 0;
    vi.spyOn(s.store, "getApproval").mockImplementation(async id => {
      if (++reads > 1) return real(id);
      await s.approvals.resolve(id, "approved", { via: "slack", userId: "brandon" });   // lands while create() is reading
      throw new Error("store I/O failed");
    });
    await expect(bounded(create(s))).rejects.toThrow("store I/O failed");
    const [stored] = await s.store.listApprovals();
    expect(stored.decision).toBe("approved");
    expect(s.hostEvents).toEqual([{ approvalId: stored.id, decision: "approved" }]);
    const types = (await s.store.agentEvents(s.session.id, 0)).map(e => e.type);
    expect(types).toContain("approval_resolved");
    expect((await s.store.getSession(s.session.id))!.status).toBe("running");
    expect(internals(s).creating.size).toBe(0);
    expect(internals(s).pending.size).toBe(0);
  });

  it("create: a parked decision settled after the failing read still returns the session to running when appending the event also fails", async () => {
    const s = await setup();
    const real = s.store.getApproval.bind(s.store);
    let reads = 0;
    vi.spyOn(s.store, "getApproval").mockImplementation(async id => {
      if (++reads > 1) return real(id);
      await s.approvals.resolve(id, "approved", { via: "slack", userId: "brandon" });
      vi.spyOn(s.store, "appendAgentEvent").mockImplementation(boom);
      throw new Error("store I/O failed");
    });
    await expect(bounded(create(s))).rejects.toThrow("store I/O failed");
    expect(s.sessions.activeSession?.status).toBe("running");
    expect(s.hostEvents).toHaveLength(1);
  });

  it("create: a throwing notification update in the dead path neither skips the status restore nor replaces the store error", async () => {
    const s = await setup();
    s.flags.updateThrows = true;
    vi.spyOn(s.store, "getApproval").mockImplementationOnce(boom);
    await expect(bounded(create(s))).rejects.toThrow("store I/O failed");
    expect(s.sessions.activeSession?.status).toBe("running");
    expect(s.logs.some(l => l.includes("could not update the notification"))).toBe(true);
  });

  it("bridge: resolving a dead approval says it is no longer pending (not a lost race); a real lost race is still an ApprovalConflict", async () => {
    const s = await setup();
    const h = approvalsBridgeHandlers(s.approvals, () => "adrian");
    vi.spyOn(s.store, "getApproval").mockImplementationOnce(boom);
    await expect(bounded(create(s))).rejects.toThrow("store I/O failed");
    const [dead] = await s.store.listApprovals();
    const err = await bounded(h["approvals.resolve"]({ approvalId: dead.id, decision: "approved" }).catch((e: unknown) => e));
    expect(err).not.toBeInstanceOf(ApprovalConflict);
    expect((err as Error).message).toBe("This approval is no longer pending.");
    const live = await s.approvals.create({ sessionId: s.session.id, action: { kind: "run_command", command: "npm test" }, reason: "r" });
    await s.approvals.resolve(live.id, "approved", { via: "slack", userId: "brandon" });
    expect(await h["approvals.resolve"]({ approvalId: live.id, decision: "rejected" }).catch((e: unknown) => e)).toBeInstanceOf(ApprovalConflict);
  });

  it("settle: a throwing notification update or subscriber cannot skip waking the agent", async () => {
    const s = await setup();
    const result = s.runCommand();
    await vi.waitFor(() => expect(s.shown).toHaveLength(1));
    s.flags.updateThrows = true;
    s.approvals.subscribe(() => { throw new Error("subscriber exploded"); });
    s.shown[0].choose("approved");
    expect(await bounded(result)).toBe("ran");
    expect(s.hostEvents).toHaveLength(1);
    expect((await s.store.getSession(s.session.id))!.status).toBe("running");
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
