import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../../contracts";
import { fx } from "../../contracts/fixtures";
import { SessionsController } from "../sessions/sessions-controller";
import { FakeGit, MemoryGate, MemoryStore, fakeClock } from "../testing/memory-ports";
import { ApprovalsController } from "./approvals-controller";

// A session that ends while create() is still writing the approval must release the gate (as rejected, no decision written)
// and leave no live card behind; otherwise the agent waits forever.

const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };

function bounded<T>(p: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("HUNG: still pending")), ms))]);
}

async function setup() {
  const store = new MemoryStore();
  await store.putTask({ ...fx.task });
  const clock = fakeClock();
  const shown: Array<{ approval: ApprovalRequest; choose(d: "approved" | "rejected"): void }> = [];
  const updates: Array<{ id: string; text: string }> = [];
  const hostEvents: unknown[] = [];
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
    host: { sendEvent: (_n, body) => { hostEvents.push(body); return true; } },
    notify: { show: (approval, _t, onChoice) => { shown.push({ approval, choose: onChoice }); }, update: (id, text) => { updates.push({ id, text }); } },
  });
  approvalsRef = approvals;
  const session = await sessions.start("task_01", model);
  const runCommand = () => gate.request(session, "cmd.run", { command: "npm test", timeoutMs: 1000 }).then(() => "ran", (e: Error) => e.message);
  // Holds the first putApproval until release() is called.
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const real = store.putApproval.bind(store);
  let entered!: () => void;
  const inPut = new Promise<void>(r => { entered = r; });
  vi.spyOn(store, "putApproval").mockImplementation(async a => { entered(); await held; return real(a); });
  return { store, sessions, approvals, session, shown, updates, hostEvents, runCommand, release, inPut };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("approvals: the session ends while create() is writing the approval", () => {
  for (const how of ["process error", "cancel"] as const) {
    it(`${how}: the gate is released, no card is left, nothing is decided, a later decision is refused`, async () => {
      const s = await setup();
      const result = s.runCommand();
      await s.inPut;
      await bounded(Promise.resolve(how === "cancel" ? s.sessions.cancel(s.session.id) : s.sessions.onProcessError(s.session.id, "agent process crashed")));
      s.release();
      expect(await bounded(result)).toMatch(/ended|nothing to approve/);
      expect(s.shown).toEqual([]);                                   // no live APPROVE / REJECT card for a dead session
      const stored = (await s.store.listApprovals())[0];
      expect(stored?.decision).toBeUndefined();                      // nothing written: no human decided
      const events = await s.store.agentEvents(s.session.id, 0);
      expect(events.some(e => e.type === "approval_request")).toBe(false);
      expect((await s.store.getSession(s.session.id))!.status).toBe(how === "cancel" ? "cancelled" : "failed");
      if (stored) {
        const res = await s.approvals.resolve(stored.id, "approved", { via: "slack", userId: "brandon" }).catch(() => undefined);
        expect(res?.won ?? false).toBe(false);
        expect((await s.store.getApproval(stored.id))!.decision).toBeUndefined();
      }
      expect(s.hostEvents).toEqual([]);
    });
  }

  for (const method of ["appendAgentEvent", "getApproval"] as const) {
    it(`process error while create() is in ${method}: the gate is released and the card is cleared, nothing decided`, async () => {
      const s = await setup();
      vi.restoreAllMocks();
      const real = (s.store[method] as (...a: never[]) => Promise<unknown>).bind(s.store);
      let release!: () => void;
      const held = new Promise<void>(r => { release = r; });
      let entered!: () => void;
      const inCall = new Promise<void>(r => { entered = r; });
      let first = true;
      vi.spyOn(s.store, method).mockImplementation((async (...a: never[]) => { if (first) { first = false; entered(); await held; } return real(...a); }) as never);
      const result = s.runCommand();
      await inCall;
      const ending = s.sessions.onProcessError(s.session.id, "agent process crashed");   // may queue behind the held write
      await new Promise(r => setTimeout(r, 20));
      release();
      await bounded(ending);
      expect(await bounded(result)).toMatch(/ended|nothing to approve/);
      const stored = (await s.store.listApprovals())[0];
      expect(stored.decision).toBeUndefined();
      expect(s.shown.length === 0 || s.updates.some(u => u.id === stored.id && u.text.includes("nothing to approve"))).toBe(true);   // no live card is left
      expect((await s.store.getSession(s.session.id))!.status).toBe("failed");
      expect(s.hostEvents).toEqual([]);
    });
  }

  it("waitForDecision rejects at once for an undecided approval of an ended session", async () => {
    const s = await setup();
    vi.restoreAllMocks();
    const a = await s.approvals.create({ sessionId: s.session.id, action: { kind: "run_command", command: "npm test" }, reason: "r" });
    await s.sessions.onProcessError(s.session.id, "crash");
    await expect(bounded(s.approvals.waitForDecision(a.id))).rejects.toThrow(/ended/);
    expect((s.approvals as unknown as { waiters: Map<string, unknown> }).waiters.size).toBe(0);
    expect((await s.store.getApproval(a.id))!.decision).toBeUndefined();
  });

  it("a human approval that lands while waitForDecision is reading the store still returns approved", async () => {
    const s = await setup();
    vi.restoreAllMocks();
    const a = await s.approvals.create({ sessionId: s.session.id, action: { kind: "run_command", command: "npm test" }, reason: "r" });
    const real = s.store.getApproval.bind(s.store);
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let entered!: () => void;
    const inRead = new Promise<void>(r => { entered = r; });
    vi.spyOn(s.store, "getApproval").mockImplementationOnce(async id => { const pre = await real(id); entered(); await held; return pre; });   // the pre-decision row
    const waiting = s.approvals.waitForDecision(a.id);
    await inRead;
    await s.approvals.resolve(a.id, "approved", { via: "slack", userId: "brandon" });
    release();
    expect(await bounded(waiting)).toBe("approved");
  });
});
