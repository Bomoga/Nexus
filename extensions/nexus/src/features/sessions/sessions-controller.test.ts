import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { SYSTEM_RULES } from "../../agent/prompt-framing";
import { ProcessHost, type Transport } from "../../agent/process-host";
import { AgentChannel } from "../../agent-process/channel";
import { AgentRuntime } from "../../agent-process/runtime";
import { SESSION_FINISHED } from "../../agent-process/session-events";
import { AgentEvent, Requests } from "../../contracts";
import { fx } from "../../contracts/fixtures";
import { FakeProvider } from "../../models/fake-provider";
import { FakeGit, MemoryGate, MemoryStore, fakeClock } from "../testing/memory-ports";
import { SessionsController, sessionsBridgeHandlers, sessionsSubscriptions, type HostPort } from "./sessions-controller";

const SECRET = "sk-ant-api03-SECRETSECRETSECRET1234567890";
const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };

function fakeHost() {
  const calls: string[] = [];
  const host: HostPort & { calls: string[]; startParams?: Parameters<HostPort["startSession"]>[0]; failStart?: Error } = {
    calls,
    async startSession(p) { calls.push("start"); host.startParams = p; if (host.failStart) throw host.failStart; return { accepted: true }; },
    async cancelSession(id) { calls.push(`cancel:${id}`); return { cancelled: true }; },
    endSession(id) { calls.push(`end:${id}`); },
  };
  return host;
}

async function setup(over: { gate?: MemoryGate; getKey?: (p: string) => Promise<string | undefined>; agentModels?: () => typeof fx.models; task?: Partial<typeof fx.task> } = {}) {
  const store = new MemoryStore();
  await store.putTask({ ...fx.task, ...over.task });
  const git = new FakeGit();
  const host = fakeHost();
  const gate = over.gate ?? new MemoryGate({ files: { "src/cart.ts": "old" } });
  const clock = fakeClock();
  const c = new SessionsController({ store, git, gate, host, clock, machineId: "m_adrian", getKey: over.getKey ?? (async () => "sk-live-key"), agentModels: over.agentModels });
  return { c, store, git, host, gate, clock };
}

describe("SessionsController.start", () => {
  it("creates the worktree and branch via the git port, persists the session, and starts the agent", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    expect(s.git.created).toEqual([{ sessionId: session.id, workspaceId: "ws_demo" }]);
    expect(session).toMatchObject({ taskId: "task_01", model, branch: `nexus/agent-${session.id}`, status: "running", machineId: "m_adrian", baseCommit: "3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21" });
    expect(await s.store.getSession(session.id)).toEqual(session);
    expect(await s.store.getTask("task_01")).toMatchObject({ status: "running", sessionId: session.id });
    expect(s.host.startParams).toMatchObject({ session: { id: session.id, branch: session.branch, worktreePath: session.worktreePath }, systemRules: SYSTEM_RULES, task: { status: "running" } });
    expect((await s.store.agentEvents(session.id, 0))[0]).toMatchObject({ seq: 0, type: "status", status: "running" });
  });

  it("writes an agent_session event on the base branch family's orbit", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    expect(s.store.nexusEvents).toHaveLength(1);
    expect(s.store.nexusEvents[0]).toMatchObject({ kind: "agent_session", orbit: "main", target: { type: "session", sessionId: session.id }, actor: { kind: "agent" }, machineId: "m_adrian" });
  });

  it("refuses unknown tasks, non-draft tasks, a second concurrent session, and models that cannot run the agent", async () => {
    const s = await setup({ agentModels: () => fx.models.filter(m => m.provider !== "swarms") });
    await expect(s.c.start("nope", model)).rejects.toThrow("No task");
    await expect(s.c.start("task_01", { provider: "swarms", modelId: "swarms:single-agent" })).rejects.toThrow("cannot run the coding agent");
    await s.c.start("task_01", model);
    await expect(s.c.start("task_01", model)).rejects.toThrow("already running");
    const done = await setup({ task: { status: "done" } });
    await expect(done.c.start("task_01", model)).rejects.toThrow("not draft");
    expect(done.git.created).toEqual([]);
  });

  it("fails the session and the task cleanly when the agent process will not start", async () => {
    const s = await setup();
    s.host.failStart = new Error(`spawn failed ${SECRET}`);
    await expect(s.c.start("task_01", model)).rejects.toThrow("did not start");
    const [session] = await s.store.listSessions();
    expect(session.status).toBe("failed");
    expect(await s.store.getTask("task_01")).toMatchObject({ status: "failed" });
    const events = await s.store.agentEvents(session.id, 0);
    expect(events.at(-1)).toMatchObject({ type: "status", status: "failed" });
    expect(JSON.stringify(events)).not.toContain("SECRETSECRET");
    expect(s.c.activeSession).toBeUndefined();
    s.host.failStart = undefined;
    await s.store.putTask({ ...fx.task });                       // a new draft can start a new session afterwards
    await expect(s.c.start("task_01", model)).resolves.toBeDefined();
  });
});

describe("SessionsController events", () => {
  it("assigns contiguous seq with no gaps across concurrent emits, and persists in order", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    await Promise.all(Array.from({ length: 50 }, (_, i) => s.c.emit(session.id, { type: "message", text: `m${i}` })));
    const events = await s.store.agentEvents(session.id, 0);
    expect(events.map(e => e.seq)).toEqual(Array.from({ length: 51 }, (_, i) => i));
    expect(events.slice(1).map(e => (e as { text: string }).text)).toEqual(Array.from({ length: 50 }, (_, i) => `m${i}`));
  });

  it("does not burn a seq when the store write fails, so the stream stays gap-free", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    s.store.failAppends = 1;
    await expect(s.c.emit(session.id, { type: "message", text: "lost" })).rejects.toThrow("store unavailable");
    await s.c.emit(session.id, { type: "message", text: "kept" });
    expect((await s.store.agentEvents(session.id, 0)).map(e => e.seq)).toEqual([0, 1]);
  });

  it("continues numbering after a restart by reading the store", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    await s.c.emit(session.id, { type: "message", text: "a" });
    const again = new SessionsController({ store: s.store, git: s.git, gate: s.gate, host: s.host, clock: s.clock, machineId: "m_adrian", getKey: async () => "k" });
    expect((await again.emit(session.id, { type: "message", text: "b" })).seq).toBe(2);
  });

  it("subscribe replays from fromSeq and then streams live, in order, without duplicates", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    for (let i = 0; i < 3; i++) await s.c.emit(session.id, { type: "message", text: `old${i}` });
    const got: number[] = [];
    const stop = s.c.subscribe(session.id, 2, e => got.push(e.seq));
    const racing = s.c.emit(session.id, { type: "message", text: "during replay" });        // lands while the replay is loading
    await racing;
    await vi.waitFor(() => expect(got).toEqual([2, 3, 4]));
    await s.c.emit(session.id, { type: "message", text: "live" });
    await vi.waitFor(() => expect(got).toEqual([2, 3, 4, 5]));
    stop();
    await s.c.emit(session.id, { type: "message", text: "after unsubscribe" });
    expect(got).toEqual([2, 3, 4, 5]);
  });

  it("replays a whole session from seq 0", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    await s.c.emit(session.id, { type: "message", text: "x" });
    const got: number[] = [];
    s.c.subscribe(session.id, 0, e => got.push(e.seq));
    await vi.waitFor(() => expect(got).toEqual([0, 1]));
  });
});

describe("SessionsController agent handlers", () => {
  it("maps event.emit payloads to AgentEvents and returns the seq the host assigned", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    const h = s.c.agentHandlers();
    expect(await h["event.emit"]!({ type: "message", payload: { text: "hi" } })).toEqual({ seq: 1 });
    await h["event.emit"]!({ type: "tool_call", payload: { tool: "read_file", args: { path: "a" } } });
    await h["event.emit"]!({ type: "tool_result", payload: { tool: "read_file", ok: true, summary: "read" } });
    await h["event.emit"]!({ type: "error", payload: { message: "boom" } });
    await h["event.emit"]!({ type: "receipt", payload: fx.receipt });
    const events = await s.store.agentEvents(session.id, 0);
    expect(events.map(e => e.type)).toEqual(["status", "message", "tool_call", "tool_result", "error", "receipt"]);
    expect(events.every(e => AgentEvent.safeParse(e).success)).toBe(true);
  });

  it("emits a git-produced file_edit after fs.write, never the model's description", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    await s.c.agentHandlers()["fs.write"]!({ path: "src/cart.ts", content: "new" });
    const edit = (await s.store.agentEvents(session.id, 0)).find(e => e.type === "file_edit")!;
    expect(edit).toMatchObject({ path: "src/cart.ts", diff: expect.stringContaining("--- a/src/cart.ts") });
  });

  it("emits test_output with the exit code and a redacted tail of at most 200 lines after cmd.run", async () => {
    const gate = new MemoryGate();
    gate.commandResult = { exitCode: 1, stdoutTail: Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"), stderrTail: `token leak ${SECRET}` };
    const s = await setup({ gate });
    const session = await s.c.start("task_01", model);
    await s.c.agentHandlers()["cmd.run"]!({ command: "npm test", timeoutMs: 1000 });
    const ev = (await s.store.agentEvents(session.id, 0)).find(e => e.type === "test_output") as Extract<AgentEvent, { type: "test_output" }>;
    expect(ev).toMatchObject({ command: "npm test", exitCode: 1 });
    expect(ev.tail.split("\n").length).toBeLessThanOrEqual(200);
    expect(ev.tail).not.toContain("SECRETSECRET");
    expect(ev.tail).toContain("REDACTED");
  });

  it("emits a commit event after git.commit", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    const res = await s.c.agentHandlers()["git.commit"]!({ message: "fix" });
    expect((await s.store.agentEvents(session.id, 0)).at(-1)).toMatchObject({ type: "commit", sha: res.sha });
  });

  it("gives the running session's own provider its key per call, and nothing else", async () => {
    const getKey = vi.fn(async (p: string) => (p === "anthropic" ? "sk-live-key" : "other-key"));
    const s = await setup({ getKey });
    await s.c.start("task_01", model);
    const h = s.c.agentHandlers();
    expect(await h["credentials.get"]!({ provider: "anthropic", callId: "c1" })).toEqual({ apiKey: "sk-live-key" });
    await expect(h["credentials.get"]!({ provider: "google", callId: "c2" })).rejects.toThrow("not google");
    expect(getKey).toHaveBeenCalledTimes(1);
    const none = await setup({ getKey: async () => undefined });
    await none.c.start("task_01", model);
    await expect(none.c.agentHandlers()["credentials.get"]!({ provider: "anthropic", callId: "c3" })).rejects.toThrow("No API key");
  });

  it("delegates approval.request and slack.progress, and reports progress unavailable without a port", async () => {
    const approvals = { request: vi.fn(async ({ sessionId }: { sessionId: string }) => ({ approval: { ...fx.approval, id: "apr_9", sessionId }, decision: "approved" as const })) };
    const progress = { update: vi.fn(async (_session: unknown, _text: string) => true) };
    const s = await setup();
    const c = new SessionsController({ store: s.store, git: s.git, gate: s.gate, host: s.host, clock: s.clock, machineId: "m", getKey: async () => "k", approvals, progress });
    const session = await c.start("task_01", model);
    const h = c.agentHandlers();
    expect(await h["approval.request"]!({ kind: "other", description: "ok to proceed?", reason: "because" })).toEqual({ approvalId: "apr_9", decision: "approved" });
    expect(approvals.request).toHaveBeenCalledWith({ sessionId: session.id, action: { kind: "other", description: "ok to proceed?" }, reason: "because" });
    expect(await h["slack.progress"]!({ text: `working with ${SECRET}` })).toEqual({ ok: true });
    expect(progress.update.mock.calls[0][1]).not.toContain("SECRETSECRET");

    const bare = await setup();
    await bare.c.start("task_01", model);
    expect(await bare.c.agentHandlers()["slack.progress"]!({ text: "x" })).toEqual({ ok: false });
    await expect(bare.c.agentHandlers()["approval.request"]!({ kind: "other", description: "d", reason: "r" })).rejects.toThrow("not available");
  });

  it("the in-memory gate refuses forward-slash, backslash and absolute escapes from the worktree", async () => {
    const s = await setup();
    await s.c.start("task_01", model);
    const h = s.c.agentHandlers();
    for (const path of ["../x", "a/../../x", "..\\x", "a\\..\\x", "/etc/passwd", "C:\\x"]) {
      await expect(h["fs.write"]!({ path, content: "x" }), path).rejects.toThrow("outside the session worktree");
    }
  });

  it("refuses every request when no session is running", async () => {
    const s = await setup();
    const h = s.c.agentHandlers();
    await expect(h["fs.read"]!({ path: "a" })).rejects.toThrow("No agent session");
    await expect(h["credentials.get"]!({ provider: "anthropic", callId: "c" })).rejects.toThrow("No agent session");
  });
});

describe("SessionsController lifecycle", () => {
  it("onFinished(done) ends the session, the task and the host's active session, then allows a new one", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    await s.c.onFinished({ sessionId: session.id, outcome: "done", turns: 5 });
    expect(await s.store.getSession(session.id)).toMatchObject({ status: "done", endedAt: expect.any(String) });
    expect(await s.store.getTask("task_01")).toMatchObject({ status: "done" });
    expect((await s.store.agentEvents(session.id, 0)).at(-1)).toMatchObject({ type: "status", status: "done" });
    expect(s.host.calls).toContain(`end:${session.id}`);
    expect(s.c.activeSession).toBeUndefined();
    await s.c.onFinished({ sessionId: session.id, outcome: "failed", turns: 1 });     // a duplicate report changes nothing
    expect((await s.store.getSession(session.id))!.status).toBe("done");
  });

  it("onFinished(failed) records the (redacted) reason as an error event", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    await s.c.onFinished({ sessionId: session.id, outcome: "failed", turns: 2, reason: `model error ${SECRET}` });
    const events = await s.store.agentEvents(session.id, 0);
    expect(events.map(e => e.type).slice(-2)).toEqual(["error", "status"]);
    expect(JSON.stringify(events)).not.toContain("SECRETSECRET");
    expect((await s.store.getSession(session.id))!.status).toBe("failed");
  });

  it("a process crash fails the session", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    await s.c.onProcessError(session.id, "agent process crashed and was restarted once");
    expect((await s.store.getSession(session.id))!.status).toBe("failed");
    await s.c.onProcessError("other", "ignored");                                      // an unrelated session id is ignored
  });

  it("cancel tells the host, marks the session cancelled, and is a no-op on a finished session", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    const cancelled = await s.c.cancel(session.id);
    expect(cancelled.status).toBe("cancelled");
    expect(s.host.calls).toContain(`cancel:${session.id}`);
    expect(await s.store.getTask("task_01")).toMatchObject({ status: "cancelled" });
    expect((await s.c.cancel(session.id)).status).toBe("cancelled");
    await expect(s.c.cancel("nope")).rejects.toThrow("No session");
  });

  it("setStatus flips awaiting_approval and back, once per change, and ignores finished sessions", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    await s.c.setStatus(session.id, "awaiting_approval");
    await s.c.setStatus(session.id, "awaiting_approval");
    expect(await s.store.getTask("task_01")).toMatchObject({ status: "awaiting_approval" });
    await s.c.setStatus(session.id, "running");
    expect((await s.store.agentEvents(session.id, 0)).filter(e => e.type === "status").map(e => (e as { status: string }).status)).toEqual(["running", "awaiting_approval", "running"]);
    await s.c.onFinished({ sessionId: session.id, outcome: "done", turns: 1 });
    await s.c.setStatus(session.id, "awaiting_approval");
    expect((await s.store.getSession(session.id))!.status).toBe("done");
  });
});

describe("SessionsController robustness", () => {
  const second = { ...fx.task, id: "task_02", title: "Second task" };

  it("two concurrent starts: exactly one wins, one worktree is made, the host is asked once", async () => {
    const s = await setup();
    await s.store.putTask(second);
    const results = await Promise.allSettled([s.c.start("task_01", model), s.c.start("task_02", model)]);
    expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.message).toMatch(/already running/);
    expect(s.git.created).toHaveLength(1);
    expect(s.host.calls.filter(c => c === "start")).toHaveLength(1);
    expect((await s.store.listSessions()).filter(x => x.status === "running")).toHaveLength(1);
  });

  it("a store failure after the session became active never wedges the controller", async () => {
    const s = await setup();
    await s.store.putTask(second);
    const put = s.store.putNexusEvent.bind(s.store);
    s.store.putNexusEvent = async () => { throw new Error("tiger down"); };
    await expect(s.c.start("task_01", model)).rejects.toThrow("did not start");
    expect(s.c.activeSession).toBeUndefined();
    expect((await s.store.listSessions())[0].status).toBe("failed");
    expect(s.host.calls).not.toContain("start");                                   // the agent was never asked to run
    s.store.putNexusEvent = put;
    await expect(s.c.start("task_02", model)).resolves.toBeDefined();               // and the next one works
  });

  it("gives the worktree back when the session cannot even be saved", async () => {
    const s = await setup();
    const removed: string[] = [];
    s.git.removeSessionWorktree = async id => { removed.push(id); };
    s.store.putSession = async () => { throw new Error("disk full"); };
    await expect(s.c.start("task_01", model)).rejects.toThrow("disk full");
    expect(removed).toEqual([s.git.created[0].sessionId]);
    expect(s.c.activeSession).toBeUndefined();
    expect((await s.store.getTask("task_01"))!.status).toBe("draft");
  });

  it("finalizing survives failing writes: the host is still told, the controller is free", async () => {
    const logs: string[] = [];
    const store = new MemoryStore();
    await store.putTask({ ...fx.task });
    const host = fakeHost();
    const c = new SessionsController({ store, git: new FakeGit(), gate: new MemoryGate(), host, clock: fakeClock(), machineId: "m", getKey: async () => "k", log: m => logs.push(m) });
    const session = await c.start("task_01", model);
    store.putSession = async () => { throw new Error("store down"); };
    store.failAppends = 5;
    await c.onFinished({ sessionId: session.id, outcome: "done", turns: 1 });
    expect(host.calls).toContain(`end:${session.id}`);
    expect(c.activeSession).toBeUndefined();
    expect(logs.join("\n")).toMatch(/could not save the session: store down/);
  });

  it("a throwing subscriber neither fails emit nor starves the others", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    const got: number[] = [];
    s.c.subscribe(session.id, 0, () => { throw new Error("boom"); });
    s.c.subscribe(session.id, 0, e => got.push(e.seq));
    await vi.waitFor(() => expect(got).toEqual([0]));
    await expect(s.c.emit(session.id, { type: "message", text: "x" })).resolves.toBeDefined();
    await vi.waitFor(() => expect(got).toEqual([0, 1]));
  });

  it("a failed replay is logged, and live events still arrive", async () => {
    const logs: string[] = [];
    const store = new MemoryStore();
    await store.putTask({ ...fx.task });
    const c = new SessionsController({ store, git: new FakeGit(), gate: new MemoryGate(), host: fakeHost(), clock: fakeClock(), machineId: "m", getKey: async () => "k", log: m => logs.push(m) });
    const session = await c.start("task_01", model);
    const read = store.agentEvents.bind(store);
    store.agentEvents = async () => { throw new Error("replay failed"); };
    const got: number[] = [];
    c.subscribe(session.id, 0, e => got.push(e.seq));
    await vi.waitFor(() => expect(logs.some(l => l.includes("could not replay"))).toBe(true));
    store.agentEvents = read;
    await c.emit(session.id, { type: "message", text: "live" });
    expect(got.length).toBeGreaterThan(0);
  });
});

describe("what the host stores from the child", () => {
  it("re-sanitizes event payloads: deep secrets, huge arrays and long strings never reach the store", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    let deep: unknown = SECRET;
    for (let i = 0; i < 9; i++) deep = { next: deep };
    const many = Array.from({ length: 500 }, () => "x".repeat(1500));
    await s.c.agentHandlers()["event.emit"]!({ type: "tool_call", payload: { tool: `t-${SECRET}`, args: { deep, many, [`key-${SECRET}`]: 1 } } });
    const stored = JSON.stringify(await s.store.agentEvents(session.id, 0));
    expect(stored).not.toContain("SECRETSECRET");
    expect(stored.length).toBeLessThan(40_000);
  });

  it("redacts the path and caps the size of a file_edit diff", async () => {
    const base = new MemoryGate();
    const big = "+" + "line of change\n+".repeat(5000);
    const gate = { request: async (session: Parameters<MemoryGate["request"]>[0], name: Parameters<MemoryGate["request"]>[1], body: unknown) => (name === "git.diff" ? { diff: `${big} ${SECRET}` } : base.request(session, name, body as never)) } as unknown as MemoryGate;
    const store = new MemoryStore();
    await store.putTask({ ...fx.task });
    const c = new SessionsController({ store, git: new FakeGit(), gate, host: fakeHost(), clock: fakeClock(), machineId: "m", getKey: async () => "k" });
    const session = await c.start("task_01", model);
    await c.agentHandlers()["fs.write"]!({ path: `src/${SECRET}.ts`, content: "x" });
    const edit = (await store.agentEvents(session.id, 0)).find(e => e.type === "file_edit") as Extract<AgentEvent, { type: "file_edit" }>;
    expect(edit.path).not.toContain("SECRETSECRET");
    expect(edit.diff.length).toBeLessThan(21_000);
    expect(edit.diff).toContain("clipped");
  });

  it("hands the agent a Prune setting only when the optimizer says so, never allowing routing, and reports receipts", async () => {
    const receipts: unknown[] = [];
    const store = new MemoryStore();
    await store.putTask({ ...fx.task });
    let prune: { enabled: boolean; apiKey?: string } = { enabled: false };
    const c = new SessionsController({ store, git: new FakeGit(), gate: new MemoryGate(), host: fakeHost(), clock: fakeClock(), machineId: "m", getKey: async () => "sk-live", prune: async () => prune, onReceipt: r => receipts.push(r) });
    const session = await c.start("task_01", model);
    const h = c.agentHandlers();
    expect(await h["credentials.get"]!({ provider: "anthropic", callId: "c1" })).toEqual({ apiKey: "sk-live" });
    prune = { enabled: true, apiKey: "prune_key_123" };
    expect(await h["credentials.get"]!({ provider: "anthropic", callId: "c2" })).toEqual({ apiKey: "sk-live", prune: { enabled: true, apiKey: "prune_key_123", allowModelRouting: false } });
    prune = { enabled: true };                                                       // no Prune key: no Prune
    expect(await h["credentials.get"]!({ provider: "anthropic", callId: "c3" })).toEqual({ apiKey: "sk-live" });
    await h["event.emit"]!({ type: "receipt", payload: fx.receipt });
    expect(receipts).toEqual([fx.receipt]);
    expect((await store.agentEvents(session.id, 0)).at(-1)).toMatchObject({ type: "receipt", receipt: { callId: "call_01" } });
  });
});

describe("bridge handlers", () => {
  it("serve agent.start, agent.cancel, sessions.get and sessions.list with contract-shaped responses", async () => {
    const s = await setup();
    const h = sessionsBridgeHandlers(s.c, s.store);
    const started = await h["agent.start"]({ taskId: "task_01", model });
    Requests["agent.start"].res.parse(started);
    Requests["sessions.get"].res.parse(await h["sessions.get"]({ sessionId: started.id }));
    expect(await h["sessions.list"]({ status: "running" })).toHaveLength(1);
    expect(await h["sessions.list"]({ status: "done" })).toHaveLength(0);
    Requests["agent.cancel"].res.parse(await h["agent.cancel"]({ sessionId: started.id }));
    await expect(h["sessions.get"]({ sessionId: "nope" })).rejects.toThrow("No session");
  });

  it("agent.subscribe replays from fromSeq then streams", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    const got: number[] = [];
    sessionsSubscriptions(s.c)["agent.subscribe"]({ sessionId: session.id, fromSeq: 0 }, e => got.push(e.seq));
    await vi.waitFor(() => expect(got).toEqual([0]));
  });
});

describe("the whole slice offline: controller + real ProcessHost + agent runtime + fake provider", () => {
  it("runs the scripted fix and leaves a contiguous, schema-valid event stream ending in done", async () => {
    const store = new MemoryStore();
    await store.putTask({ ...fx.task });
    const gate = new MemoryGate({ files: { "src/cart.ts": "old" } });
    const hostToChild = new PassThrough();
    const childToHost = new PassThrough();
    const channel = new AgentChannel(hostToChild, childToHost);
    const runtime = new AgentRuntime({ providers: { anthropic: new FakeProvider() }, gate: channel, onFinished: o => channel.notify(SESSION_FINISHED, o) });
    runtime.attach(channel);
    const transport: Transport = { stdin: hostToChild, stdout: childToHost, kill: () => channel.close(), onExit: () => {} };

    // Assigned after the host exists (the host's handlers read it lazily), so it cannot be a const.
    // eslint-disable-next-line prefer-const
    let controller!: SessionsController;
    const host = new ProcessHost({
      spawn: () => transport,
      handlers: { get "fs.read"() { return controller.agentHandlers()["fs.read"]; }, get "fs.write"() { return controller.agentHandlers()["fs.write"]; }, get "fs.list"() { return controller.agentHandlers()["fs.list"]; }, get "cmd.run"() { return controller.agentHandlers()["cmd.run"]; }, get "git.diff"() { return controller.agentHandlers()["git.diff"]; }, get "git.commit"() { return controller.agentHandlers()["git.commit"]; }, get "approval.request"() { return controller.agentHandlers()["approval.request"]; }, get "slack.progress"() { return controller.agentHandlers()["slack.progress"]; }, get "credentials.get"() { return controller.agentHandlers()["credentials.get"]; }, get "event.emit"() { return controller.agentHandlers()["event.emit"]; } },
      onSessionFinished: o => { void controller.onFinished(o); },
    });
    controller = new SessionsController({ store, git: new FakeGit(), gate, host, clock: fakeClock(), machineId: "m_adrian", getKey: async () => "sk-live-key" });

    const session = await controller.start("task_01", model);
    await vi.waitFor(async () => expect((await store.getSession(session.id))!.status).toBe("done"), { timeout: 5000 });

    const events = await store.agentEvents(session.id, 0);
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.every(e => AgentEvent.safeParse(e).success)).toBe(true);
    expect(events[0]).toMatchObject({ type: "status", status: "running" });
    expect(events.at(-1)).toMatchObject({ type: "status", status: "done" });
    const kinds = new Set(events.map(e => e.type));
    for (const k of ["message", "tool_call", "tool_result", "file_edit", "test_output", "commit"]) expect(kinds.has(k as AgentEvent["type"])).toBe(true);
    expect(gate.files.get("src/cart.ts")).toBe("<fixed cart.ts>");
    expect(await store.getTask("task_01")).toMatchObject({ status: "done" });
    host.dispose();
  });
});
