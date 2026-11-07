import { afterEach, describe, expect, it, vi } from "vitest";
import { Requests, type ApprovalRequest } from "../../contracts";
import { fx } from "../../contracts/fixtures";
import { SessionsController } from "../sessions/sessions-controller";
import { FakeGit, MemoryGate, MemoryStore, fakeClock } from "../testing/memory-ports";
import { ApprovalConflict, ApprovalsController, approvalsBridgeHandlers, describeAction, type ApprovalHook } from "./approvals-controller";

const SECRET = "sk-ant-api03-SECRETSECRETSECRET1234567890";
const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
const runCmd = { kind: "run_command", command: "npm test" } as const;

afterEach(() => { vi.useRealTimers(); });

async function setup(opts: { hooks?: ApprovalHook[] } = {}) {
  const store = new MemoryStore();
  await store.putTask({ ...fx.task });
  const clock = fakeClock();
  const hostEvents: Array<{ approvalId: string; decision: string }> = [];
  const shown: Array<{ approval: ApprovalRequest; text: string; choose(d: "approved" | "rejected"): void }> = [];
  const updates: Array<{ id: string; text: string }> = [];
  const logs: string[] = [];
  // Assigned after the sessions controller that points at it exists, so it cannot be a const.
  // eslint-disable-next-line prefer-const
  let approvalsRef!: ApprovalsController;
  const requester = { request: (i: Parameters<ApprovalsController["request"]>[0]) => approvalsRef.request(i), sessionEnded: (id: string, how: "cancelled" | "failed" | "done") => approvalsRef.sessionEnded(id, how) };
  const gate = new MemoryGate({ approvals: requester });          // like the real gate, cmd.run and git.commit wait on a human
  const sessions = new SessionsController({
    store, git: new FakeGit(), gate, clock, machineId: "m_adrian", getKey: async () => "k",
    host: { startSession: async () => ({}), cancelSession: async () => ({}), endSession: () => {} },
    approvals: requester,
  });
  const approvals = new ApprovalsController({
    store, clock, sessions, hooks: opts.hooks, log: m => logs.push(m), identity: () => "adrian",
    host: { sendEvent: (_n, body) => { hostEvents.push(body); return true; } },
    notify: { show: (approval, text, onChoice) => shown.push({ approval, text, choose: onChoice }), update: (id, text) => updates.push({ id, text }) },
  });
  approvalsRef = approvals;
  const session = await sessions.start("task_01", model);
  const eventTypes = async () => (await store.agentEvents(session.id, 0)).map(e => e.type + (e.type === "status" ? `:${(e as { status: string }).status}` : ""));
  return { store, sessions, approvals, session, hostEvents, shown, updates, logs, eventTypes, gate };
}

const human = (userId = "brandon", via: "app" | "slack" | "auth0_push" = "slack") => ({ via, userId });

describe("creating and waiting", () => {
  it("persists the request, emits approval_request, flips the session to awaiting_approval and notifies", async () => {
    const hook = { name: "slack", onCreated: vi.fn(async () => {}) };
    const s = await setup({ hooks: [hook] });
    const created = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "Need to run the tests" });
    expect(created).toMatchObject({ sessionId: s.session.id, action: runCmd, reason: "Need to run the tests" });
    expect(created.decision).toBeUndefined();
    expect(await s.store.getApproval(created.id)).toEqual(created);
    expect(await s.eventTypes()).toEqual(["status:running", "approval_request", "status:awaiting_approval"]);
    expect(s.shown[0].text).toBe("Agent wants to run: npm test: Need to run the tests (model-written)");
    expect(hook.onCreated).toHaveBeenCalledWith(created);
    expect((await s.store.getTask("task_01"))!.status).toBe("awaiting_approval");
  });

  it("redacts secrets in the action, reason and diff preview before anything is stored or shown", async () => {
    const s = await setup();
    const a = await s.approvals.create({ sessionId: s.session.id, action: { kind: "run_command", command: `curl -H "Authorization: Bearer ${SECRET}" x` }, reason: `uses ${SECRET}`, diffPreview: `+API_KEY=${SECRET}` });
    const stored = JSON.stringify(await s.store.getApproval(a.id)) + s.shown[0].text;
    expect(stored).not.toContain("SECRETSECRET");
    expect(stored).toContain("REDACTED");
  });

  it("a failing hook never blocks the approval and is logged", async () => {
    const s = await setup({ hooks: [{ name: "swarm", onCreated: async () => { throw new Error("swarms down"); } }, { name: "slack", onCreated: async () => {} }] });
    const a = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "r" });
    await vi.waitFor(() => expect(s.logs).toEqual(["approval hook swarm failed: swarms down"]));
    expect(await s.approvals.get(a.id)).toBeDefined();
  });

  it("waitForDecision never times out", async () => {
    vi.useFakeTimers();
    const s = await setup();
    const a = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "r" });
    let settled = false;
    void s.approvals.waitForDecision(a.id).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(7 * 24 * 3600 * 1000);
    expect(settled).toBe(false);
    expect((await s.store.getApproval(a.id))!.decision).toBeUndefined();
  });
});

describe("deciding", () => {
  it("a notification APPROVE click decides as the local user, wakes the agent, and returns the session to running", async () => {
    const s = await setup();
    const pending = s.approvals.request({ sessionId: s.session.id, action: runCmd, reason: "r" });
    await vi.waitFor(() => expect(s.shown).toHaveLength(1));
    s.shown[0].choose("approved");
    const { approval, decision } = await pending;
    expect(decision).toBe("approved");
    expect(approval).toMatchObject({ decision: "approved", decidedBy: { via: "app", userId: "adrian" }, decidedAt: expect.any(String) });
    expect(await s.eventTypes()).toEqual(["status:running", "approval_request", "status:awaiting_approval", "approval_resolved", "status:running"]);
    expect(s.hostEvents).toEqual([{ approvalId: approval.id, decision: "approved" }]);
    expect(s.updates.at(-1)).toEqual({ id: approval.id, text: "Decided by adrian via app: approved" });
  });

  it("rejected is delivered to the agent as rejected", async () => {
    const s = await setup();
    const pending = s.approvals.request({ sessionId: s.session.id, action: { kind: "commit", message: "fix" }, reason: "r" });
    await vi.waitFor(() => expect(s.shown).toHaveLength(1));
    await s.approvals.resolve(s.shown[0].approval.id, "rejected", human("brandon", "slack"));
    expect((await pending).decision).toBe("rejected");
    expect(s.hostEvents[0].decision).toBe("rejected");
  });

  it("two concurrent resolves: exactly one winner, one approval_resolved event, both callers see the winner", async () => {
    const s = await setup();
    const a = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "r" });
    const [x, y] = await Promise.all([
      s.approvals.resolve(a.id, "approved", human("brandon", "slack")),
      s.approvals.resolve(a.id, "rejected", { via: "auth0_push", userId: "auth0|123", auth0UserId: "auth0|123" }),
    ]);
    expect([x.won, y.won].sort()).toEqual([false, true]);
    expect(x.approval).toEqual(y.approval);
    expect((await s.eventTypes()).filter(t => t === "approval_resolved")).toHaveLength(1);
    expect(s.hostEvents).toHaveLength(1);
    expect(s.hostEvents[0].decision).toBe(x.approval.decision);
  });

  it("a later resolve keeps the first decision and reports who decided", async () => {
    const s = await setup();
    const a = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "r" });
    await s.approvals.resolve(a.id, "approved", human("brandon"));
    const late = await s.approvals.resolve(a.id, "rejected", human("elkin"));
    expect(late.won).toBe(false);
    expect(late.approval).toMatchObject({ decision: "approved", decidedBy: { userId: "brandon" } });
  });

  it("a decision made on another machine (observed from the store) wakes the waiting agent too", async () => {
    const s = await setup();
    const pending = s.approvals.request({ sessionId: s.session.id, action: runCmd, reason: "r" });
    await vi.waitFor(() => expect(s.shown).toHaveLength(1));
    const id = s.shown[0].approval.id;
    const { approval } = await s.store.decideApproval(id, "approved", human("brandon", "slack"), "2026-11-07T03:20:00Z");
    await s.approvals.observe(approval);
    expect((await pending).decision).toBe("approved");
    expect((await s.store.getApproval(id))!.decidedBy).toMatchObject({ via: "slack", userId: "brandon" });
    expect(s.updates.at(-1)!.text).toBe("Decided by brandon via slack: approved");
    await s.approvals.observe(approval);                                       // a repeat changes nothing
    expect((await s.eventTypes()).filter(t => t === "approval_resolved")).toHaveLength(1);
  });

  it("a teammate's approval is announced locally but never wakes this machine's agent", async () => {
    const s = await setup();
    const theirs: ApprovalRequest = { ...fx.approval, id: "apr_remote", sessionId: "ses_remote" };
    const seen: ApprovalRequest[] = [];
    s.approvals.subscribe(a => seen.push(a));
    await s.approvals.observe(theirs);
    await s.approvals.observe(theirs);
    expect(s.shown.filter(n => n.approval.id === "apr_remote")).toHaveLength(1);
    await s.approvals.observe({ ...theirs, decision: "approved", decidedBy: human(), decidedAt: "2026-11-07T03:20:00Z" });
    expect(s.hostEvents).toEqual([]);
    expect(await s.store.agentEvents("ses_remote", 0)).toEqual([]);
    expect(seen).toHaveLength(2);
  });

  it("keeps the session awaiting while any approval is pending, and resumes after the last", async () => {
    const s = await setup();
    const a = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "1" });
    const b = await s.approvals.create({ sessionId: s.session.id, action: { kind: "commit", message: "m" }, reason: "2" });
    await s.approvals.resolve(a.id, "approved", human());
    expect((await s.store.getSession(s.session.id))!.status).toBe("awaiting_approval");
    await s.approvals.resolve(b.id, "approved", human());
    expect((await s.store.getSession(s.session.id))!.status).toBe("running");
  });

  it("only a named human can decide, and only an existing approval", async () => {
    const s = await setup();
    const a = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "r" });
    await expect(s.approvals.resolve(a.id, "approved", { via: "app", userId: "  " })).rejects.toThrow("name of the person");
    await expect(s.approvals.resolve(a.id, "approved", { via: "agent" as never, userId: "x" })).rejects.toThrow();
    await expect(s.approvals.resolve("apr_nope", "approved", human())).rejects.toThrow("No approval");
    expect((await s.store.getApproval(a.id))!.decision).toBeUndefined();
  });

  it("the agent's approval.request creates an undecided request and gets an answer only from a human", async () => {
    const s = await setup();
    const handlers = s.sessions.agentHandlers();
    expect(Object.keys(handlers).some(k => k.startsWith("approvals"))).toBe(false);          // no resolve path for the agent
    let answered: unknown;
    const call = handlers["approval.request"]!({ kind: "other", description: "delete the cache?", reason: "stale" }).then(r => { answered = r; });
    await vi.waitFor(() => expect(s.shown).toHaveLength(1));
    await new Promise(r => setTimeout(r, 20));
    expect(answered).toBeUndefined();
    expect((await s.store.getApproval(s.shown[0].approval.id))!.decision).toBeUndefined();
    await s.approvals.resolve(s.shown[0].approval.id, "approved", human());
    await call;
    expect(answered).toEqual({ approvalId: s.shown[0].approval.id, decision: "approved" });
  });
});

describe("commands, listing, subscriptions", () => {
  it("nexus.approve / nexus.reject without an id act only when exactly one approval is waiting, and never guess between several", async () => {
    const s = await setup();
    expect(await s.approvals.decideFromCommand("approved")).toBeUndefined();               // nothing waiting
    const a = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "old" });
    const b = await s.approvals.create({ sessionId: s.session.id, action: { kind: "commit", message: "m" }, reason: "new" });
    await expect(s.approvals.decideFromCommand("rejected")).rejects.toThrow("2 approvals are waiting");
    expect((await s.approvals.get(a.id))!.decision).toBeUndefined();                       // nothing was decided by the keypress
    expect((await s.approvals.get(b.id))!.decision).toBeUndefined();
    const res = await s.approvals.decideFromCommand("rejected", b.id);                     // an explicit id always works
    expect(res!.approval).toMatchObject({ id: b.id, decision: "rejected", decidedBy: { via: "app", userId: "adrian" } });
    const only = await s.approvals.decideFromCommand("approved");                          // now exactly one is left
    expect(only!.approval).toMatchObject({ id: a.id, decision: "approved" });
  });

  it("lists by session and pending-only, oldest first", async () => {
    const s = await setup();
    const a = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "1" });
    const b = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "2" });
    await s.approvals.resolve(a.id, "approved", human());
    expect((await s.approvals.list()).map(x => x.id)).toEqual([a.id, b.id]);
    expect((await s.approvals.list({ pendingOnly: true })).map(x => x.id)).toEqual([b.id]);
    expect(await s.approvals.list({ sessionId: "other" })).toEqual([]);
  });

  it("subscribe sees every create and resolve until unsubscribed", async () => {
    const s = await setup();
    const seen: string[] = [];
    const stop = s.approvals.subscribe(a => seen.push(`${a.id}:${a.decision ?? "pending"}`));
    const a = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "r" });
    await s.approvals.resolve(a.id, "approved", human());
    stop();
    await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "later" });
    expect(seen).toEqual([`${a.id}:pending`, `${a.id}:approved`]);
  });

  it("describes every action kind", () => {
    expect(describeAction({ kind: "write_outside_scope", path: "/etc/hosts" })).toBe("write outside its worktree: /etc/hosts");
    expect(describeAction({ kind: "commit", message: "m" })).toBe('commit: "m"');
    expect(describeAction({ kind: "other", description: "d" })).toBe("d");
  });
});

describe("races with the shared store", () => {
  const decideAndObserve = async (s: Awaited<ReturnType<typeof setup>>, approvalId: string) => {
    const { approval } = await s.store.decideApproval(approvalId, "approved", human("brandon"), "2026-11-07T03:20:00Z");
    await s.approvals.observe(approval);
  };

  it("a decision that lands while the approval is still being written is applied afterwards, in order, and wakes the agent", async () => {
    const s = await setup();
    const put = s.store.putApproval.bind(s.store);
    s.store.putApproval = async a => { await put(a); await decideAndObserve(s, a.id); };
    const { decision } = await s.approvals.request({ sessionId: s.session.id, action: runCmd, reason: "r" });
    expect(decision).toBe("approved");
    expect(await s.eventTypes()).toEqual(["status:running", "approval_request", "status:awaiting_approval", "approval_resolved", "status:running"]);
    expect((await s.store.getSession(s.session.id))!.status).toBe("running");
    expect(s.hostEvents).toHaveLength(1);
  });

  it("a decision that lands while approval_request is being emitted does not show the session as waiting afterwards", async () => {
    const s = await setup();
    const append = s.store.appendAgentEvent.bind(s.store);
    s.store.appendAgentEvent = async e => { await append(e); if (e.type === "approval_request") await decideAndObserve(s, e.approvalId); };
    await s.approvals.request({ sessionId: s.session.id, action: runCmd, reason: "r" });
    expect(await s.eventTypes()).toEqual(["status:running", "approval_request", "status:awaiting_approval", "approval_resolved", "status:running"]);
    expect((await s.store.getTask("task_01"))!.status).toBe("running");
  });

  it("waitForDecision called after the decision was settled still returns it", async () => {
    const s = await setup();
    const a = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "r" });
    await s.approvals.resolve(a.id, "rejected", human());
    expect(await s.approvals.waitForDecision(a.id)).toBe("rejected");
  });

  it("two waiters for one approval are both woken", async () => {
    const s = await setup();
    const a = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "r" });
    const both = Promise.all([s.approvals.waitForDecision(a.id), s.approvals.waitForDecision(a.id)]);
    await s.approvals.resolve(a.id, "approved", human());
    expect(await both).toEqual(["approved", "approved"]);
  });
});

describe("when the session ends", () => {
  const runCommand = (s: Awaited<ReturnType<typeof setup>>) => s.gate.request(s.session, "cmd.run", { command: "npm test", timeoutMs: 1000 }).then(() => "ran", (e: Error) => e.message);

  it("cancelling records the waiting approval as the cancelling human's rejection, and a late APPROVE runs nothing", async () => {
    const s = await setup();
    const result = runCommand(s);
    await vi.waitFor(() => expect(s.shown).toHaveLength(1));
    const id = s.shown[0].approval.id;
    await s.sessions.cancel(s.session.id);
    expect(await result).toBe("rejected by a human");
    expect(await s.store.getApproval(id)).toMatchObject({ decision: "rejected", decidedBy: { via: "app", userId: "adrian" } });
    const late = await s.approvals.resolve(id, "approved", human("brandon"));
    expect(late).toMatchObject({ won: false, approval: { decision: "rejected" } });
    const types = await s.eventTypes();
    expect(types.indexOf("approval_resolved")).toBeLessThan(types.indexOf("status:cancelled"));
    expect(types).not.toContain("test_output");
    expect(s.updates.at(-1)!.text).toMatch(/Decided by adrian via app: rejected/);
  });

  it("a crashed session releases the waiting gate as rejected without writing any decision, and refuses later decisions", async () => {
    const s = await setup();
    const result = runCommand(s);
    await vi.waitFor(() => expect(s.shown).toHaveLength(1));
    const id = s.shown[0].approval.id;
    await s.sessions.onProcessError(s.session.id, "agent process crashed");
    expect(await result).toBe("rejected by a human");
    expect((await s.store.getApproval(id))!.decision).toBeUndefined();            // nobody decided: the session just ended
    await expect(s.approvals.resolve(id, "approved", human())).rejects.toThrow("session has ended");
    expect(s.updates.at(-1)!.text).toMatch(/session ended/);
    expect(await s.eventTypes()).not.toContain("approval_resolved");
  });

  it("does not list an undecidable approval of an ended session as waiting, and cancel racing the child's finish ends it once", async () => {
    const s = await setup();
    const result = runCommand(s);
    await vi.waitFor(() => expect(s.shown).toHaveLength(1));
    expect(await s.approvals.list({ pendingOnly: true })).toHaveLength(1);
    const [cancelled] = await Promise.all([
      s.sessions.cancel(s.session.id),
      s.sessions.onFinished({ sessionId: s.session.id, outcome: "failed", turns: 1 }),
    ]);
    await result;
    const final = (await s.store.getSession(s.session.id))!.status;                  // whichever ending came first wins; the other does not rewrite it
    expect(cancelled.status).toBe(final);
    expect(["cancelled", "failed"]).toContain(final);
    expect(await s.approvals.list({ pendingOnly: true })).toEqual([]);
    expect((await s.eventTypes()).filter(t => t === "status:cancelled" || t === "status:failed")).toEqual([`status:${final}`]);
  });

  it("refuses to create a new approval for a session that has ended", async () => {
    const s = await setup();
    await s.sessions.onFinished({ sessionId: s.session.id, outcome: "done", turns: 1 });
    await expect(s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "r" })).rejects.toThrow("session has ended");
  });
});

describe("bridge handlers", () => {
  it("serve approvals.list and approvals.resolve; a lost race throws ApprovalConflict carrying the winner", async () => {
    const s = await setup();
    const h = approvalsBridgeHandlers(s.approvals, () => "adrian");
    const a = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "r" });
    Requests["approvals.list"].res.parse(await h["approvals.list"]({ pendingOnly: true }));
    await s.approvals.resolve(a.id, "approved", human("brandon", "slack"));
    const err = await h["approvals.resolve"]({ approvalId: a.id, decision: "rejected" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalConflict);
    expect((err as ApprovalConflict).winner).toMatchObject({ decision: "approved", decidedBy: { userId: "brandon" } });
    const b = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "r2" });
    const won = await h["approvals.resolve"]({ approvalId: b.id, decision: "approved" });
    Requests["approvals.resolve"].res.parse(won);
    expect(won.decidedBy).toEqual({ via: "app", userId: "adrian" });
  });
});

describe("notification text is plain", () => {
  const LINK = "[APPROVE](command:workbench.action.quit)";

  it("a model-written reason or action with a command link never reaches the notification with ASCII brackets", async () => {
    const s = await setup();
    await s.approvals.create({ sessionId: s.session.id, action: { kind: "run_command", command: `echo ${LINK}` }, reason: `please ${LINK}\u202E` });
    expect(s.shown[0].text).not.toMatch(/[[\]]/);
    expect(s.shown[0].text).not.toContain("\u202E");
    expect(s.shown[0].text).toContain("［APPROVE］");
  });

  it("the decided-by text cannot carry a link either", async () => {
    const s = await setup();
    const a = await s.approvals.create({ sessionId: s.session.id, action: runCmd, reason: "r" });
    await s.approvals.resolve(a.id, "approved", { via: "slack", userId: `eve ${LINK}` });
    expect(s.updates.length).toBeGreaterThan(0);
    for (const u of s.updates) expect(u.text).not.toMatch(/[[\]]/);
    expect(s.updates.at(-1)!.text).toContain("Decided by eve ［APPROVE］");
  });
});
