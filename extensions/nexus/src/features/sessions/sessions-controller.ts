import { SYSTEM_RULES } from "../../agent/prompt-framing";
import type { AgentHandlers } from "../../agent/process-host";
import type { SessionFinished } from "../../agent-process/session-events";
import { AgentEvent, orbitOf, type AgentSession, type ApprovalAction, type ApprovalRequest, type ModelInfo, type NexusEvent, type Req, type Res, type Task } from "../../contracts";
import { redact } from "../../shared/redact";
import type { Clock, GatePort, GitPort, StorePort, Unsubscribe } from "../ports";

// Sessions controller (PLAN L1-10): the lifecycle of one agent session on the extension-host side. It asks the git
// port for the session's own worktree and branch, starts the agent process, assigns the gap-free `seq` of every
// AgentEvent, persists everything through the store port, and serves the agent's requests (gate, credentials,
// approvals, progress). The session never touches the user's checkout: branch and worktree come only from the git port.

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewAgentEvent = DistributiveOmit<AgentEvent, "sessionId" | "seq" | "at">;

/** What the approvals controller needs from sessions: emit events, flip the awaiting_approval status. */
export interface SessionEvents {
  emit(sessionId: string, event: NewAgentEvent): Promise<AgentEvent>;
  setStatus(sessionId: string, status: "running" | "awaiting_approval"): Promise<void>;
}

/** The approvals controller as the agent's `approval.request` sees it. */
export interface ApprovalRequester {
  request(input: { sessionId: string; action: ApprovalAction; reason: string }): Promise<{ approval: ApprovalRequest; decision: "approved" | "rejected" }>;
}

/** The session's single Slack progress message (L1-13, proposed to move to Lane 2). */
export interface ProgressPort {
  update(session: AgentSession, text: string): Promise<boolean>;
}

/** The slice of ProcessHost this controller drives. */
export interface HostPort {
  startSession(params: { session: { id: string; taskId: string; branch: string; worktreePath: string; baseCommit: string; model: { provider: string; modelId: string } }; task: Task; systemRules: string; untrustedBlocks: Array<{ label: string; text: string }> }): Promise<unknown>;
  cancelSession(sessionId: string): Promise<unknown>;
  endSession(sessionId: string): void;
}

export interface SessionsDeps {
  store: StorePort;
  git: GitPort;
  gate: GatePort;
  host: HostPort;
  clock: Clock;
  machineId: string;
  /** Returns the API key for a provider, or undefined (AccountsService.getKey). */
  getKey(provider: string): Promise<string | undefined>;
  approvals?: ApprovalRequester;
  progress?: ProgressPort;
  /** When given, the chosen model must be one of these for the agent role (connected, tool-capable, never Swarms). */
  agentModels?: () => ModelInfo[];
  /** Extra untrusted blocks for the agent's system prompt (the brief builder supplies the quoted thread). */
  untrustedBlocks?: (task: Task) => Array<{ label: string; text: string }>;
  /** Called after every task write (status changes), so tasks.subscribe can publish them. */
  onTaskChange?: (task: Task) => void;
}

const TERMINAL = new Set<AgentSession["status"]>(["done", "failed", "cancelled"]);

interface Counter {
  next?: number;
  chain: Promise<unknown>;
}

export class SessionsController implements SessionEvents {
  private active?: { session: AgentSession; task: Task };
  private readonly counters = new Map<string, Counter>();
  private readonly subscribers = new Map<string, Set<(e: AgentEvent) => void>>();

  constructor(private readonly deps: SessionsDeps) {}

  /** Sessions this controller can host at once: one agent process runs one session (the scheduler never asks for more). */
  readonly capacity = 1;

  get activeSession(): AgentSession | undefined {
    return this.active?.session;
  }

  // ---- lifecycle ----

  async start(taskId: string, model: { provider: string; modelId: string }): Promise<AgentSession> {
    const { store, git, host, clock } = this.deps;
    if (this.active) throw new Error("An agent session is already running; cancel it or wait for it to finish.");
    const task = await store.getTask(taskId);
    if (!task) throw new Error(`No task ${taskId}.`);
    if (task.status !== "draft") throw new Error(`Task "${task.title}" is ${task.status}, not draft.`);
    if (this.deps.agentModels && !this.deps.agentModels().some(m => m.provider === model.provider && m.modelId === model.modelId)) {
      throw new Error(`${model.provider} ${model.modelId} cannot run the coding agent (not connected, no tool calling, or a text-only provider).`);
    }

    const id = clock.newId("ses");
    const wt = await git.createSessionWorktree({ sessionId: id, workspaceId: task.workspaceId });
    const session: AgentSession = {
      id, taskId, model: { provider: model.provider, modelId: model.modelId },
      branch: wt.branch, worktreePath: wt.worktreePath, baseCommit: wt.baseCommit,
      status: "running", startedAt: clock.now(), machineId: this.deps.machineId,
    };
    const running: Task = { ...task, status: "running", sessionId: id };
    await store.putSession(session);
    await this.putTask(running);
    this.active = { session, task: running };
    await this.emit(id, { type: "status", status: "running" });
    await store.putNexusEvent(this.sessionEvent(session, running, orbitOf(wt.baseBranch)));

    try {
      await host.startSession({
        session: { id, taskId, branch: session.branch, worktreePath: session.worktreePath, baseCommit: session.baseCommit, model: session.model },
        task: running, systemRules: SYSTEM_RULES, untrustedBlocks: this.deps.untrustedBlocks?.(running) ?? [],
      });
    } catch (e) {
      await this.emit(id, { type: "error", message: `The agent process did not start: ${redact(e instanceof Error ? e.message : "unknown error")}` });
      await this.finalize(id, "failed");
      throw new Error("The agent process did not start.", { cause: e });
    }
    return session;
  }

  async cancel(sessionId: string): Promise<AgentSession> {
    const a = this.active;
    if (!a || a.session.id !== sessionId) {
      const stored = await this.deps.store.getSession(sessionId);
      if (!stored) throw new Error(`No session ${sessionId}.`);
      return stored;                                            // already over: nothing to cancel
    }
    try { await this.deps.host.cancelSession(sessionId); } catch { /* the process may already be gone */ }
    return this.finalize(sessionId, "cancelled");
  }

  /** ProcessHost.onSessionFinished */
  async onFinished(outcome: SessionFinished): Promise<void> {
    if (this.active?.session.id !== outcome.sessionId) return;
    if (outcome.reason) await this.emit(outcome.sessionId, { type: "error", message: redact(outcome.reason) });
    await this.finalize(outcome.sessionId, outcome.outcome);
  }

  /** ProcessHost.onSessionError: a crash loses the runtime's conversation, so the session fails rather than silently restarting. */
  async onProcessError(sessionId: string, message: string): Promise<void> {
    if (this.active?.session.id !== sessionId) return;
    await this.emit(sessionId, { type: "error", message: redact(message) });
    await this.finalize(sessionId, "failed");
  }

  async setStatus(sessionId: string, status: "running" | "awaiting_approval"): Promise<void> {
    const a = this.active;
    if (!a || a.session.id !== sessionId || TERMINAL.has(a.session.status) || a.session.status === status) return;
    a.session = { ...a.session, status };
    a.task = { ...a.task, status };
    await this.deps.store.putSession(a.session);
    await this.putTask(a.task);
    await this.emit(sessionId, { type: "status", status });
  }

  private async putTask(task: Task): Promise<void> {
    await this.deps.store.putTask(task);
    this.deps.onTaskChange?.(task);
  }

  private async finalize(sessionId: string, status: "done" | "failed" | "cancelled"): Promise<AgentSession> {
    const a = this.active;
    if (!a || a.session.id !== sessionId) return (await this.deps.store.getSession(sessionId))!;
    this.active = undefined;
    const ended: AgentSession = { ...a.session, status, endedAt: this.deps.clock.now() };
    await this.deps.store.putSession(ended);
    await this.putTask({ ...a.task, status });
    await this.emit(sessionId, { type: "status", status });
    this.deps.host.endSession(sessionId);
    return ended;
  }

  private sessionEvent(session: AgentSession, task: Task, orbit: string): NexusEvent {
    return {
      id: this.deps.clock.newId("evt"), kind: "agent_session", at: session.startedAt, orbit,
      title: `agent session: ${task.title}`, actor: { name: "Nexus agent", kind: "agent" },
      target: { type: "session", sessionId: session.id }, workspaceId: task.workspaceId, machineId: this.deps.machineId,
    };
  }

  // ---- events: gap-free seq, persisted, replayable ----

  async emit(sessionId: string, event: NewAgentEvent): Promise<AgentEvent> {
    let counter = this.counters.get(sessionId);
    if (!counter) { counter = { chain: Promise.resolve() }; this.counters.set(sessionId, counter); }
    const c = counter;
    const run = c.chain.then(async () => {
      if (c.next === undefined) {
        const past = await this.deps.store.agentEvents(sessionId, 0);
        c.next = past.length === 0 ? 0 : past[past.length - 1].seq + 1;
      }
      const full = AgentEvent.parse({ ...event, sessionId, seq: c.next, at: this.deps.clock.now() });
      await this.deps.store.appendAgentEvent(full);
      c.next = full.seq + 1;                                    // advanced only after a successful write: no gaps
      for (const cb of this.subscribers.get(sessionId) ?? []) cb(full);
      return full;
    });
    c.chain = run.catch(() => undefined);
    return run;
  }

  /** Replays from `fromSeq`, then streams live, in order and without duplicates. */
  subscribe(sessionId: string, fromSeq: number, cb: (e: AgentEvent) => void): Unsubscribe {
    const buffered: AgentEvent[] = [];
    let live = false;
    let last = fromSeq - 1;
    const deliver = (e: AgentEvent) => { if (e.seq > last) { last = e.seq; cb(e); } };
    const handler = (e: AgentEvent) => (live ? deliver(e) : buffered.push(e));
    const set = this.subscribers.get(sessionId) ?? new Set();
    set.add(handler);
    this.subscribers.set(sessionId, set);
    void this.deps.store.agentEvents(sessionId, fromSeq).then(past => {
      for (const e of past) deliver(e);
      for (const e of buffered) deliver(e);
      live = true;
    });
    return () => { set.delete(handler); };
  }

  // ---- the agent's requests ----

  /** Handlers for ProcessHost: the gate for files/commands/git, plus credentials, approvals, progress and events. */
  agentHandlers(): AgentHandlers {
    const session = () => {
      const a = this.active;
      if (!a) throw new Error("No agent session is running.");
      return a.session;
    };
    const { gate } = this.deps;
    return {
      "fs.read": async b => gate.request(session(), "fs.read", b),
      "fs.list": async b => gate.request(session(), "fs.list", b),
      "git.diff": async b => gate.request(session(), "git.diff", b),
      "fs.write": async b => {
        const s = session();
        const res = await gate.request(s, "fs.write", b);
        // The diff is produced by git in the host, never written by the model (CLAUDE.md §5).
        const { diff } = await gate.request(s, "git.diff", {});
        if (diff.trim().length > 0) await this.emit(s.id, { type: "file_edit", path: b.path, diff: redact(diff) });
        return res;
      },
      "cmd.run": async b => {
        const s = session();
        const res = await gate.request(s, "cmd.run", b);
        const tail = `${res.stdoutTail}${res.stderrTail ? `\n${res.stderrTail}` : ""}`.split("\n").slice(-200).join("\n");
        await this.emit(s.id, { type: "test_output", command: redact(b.command), exitCode: res.exitCode, tail: redact(tail) });
        return res;
      },
      "git.commit": async b => {
        const s = session();
        const res = await gate.request(s, "git.commit", b);
        await this.emit(s.id, { type: "commit", sha: res.sha });
        return res;
      },
      "approval.request": async b => {
        const s = session();
        if (!this.deps.approvals) throw new Error("Approvals are not available.");
        const { approval, decision } = await this.deps.approvals.request({ sessionId: s.id, action: { kind: "other", description: b.description }, reason: b.reason });
        return { approvalId: approval.id, decision };
      },
      "slack.progress": async b => {
        const s = session();
        return { ok: this.deps.progress ? await this.deps.progress.update(s, redact(b.text)) : false };
      },
      "credentials.get": async b => {
        const s = session();
        // Only the running session's own provider: the agent cannot ask for another provider's key.
        if (b.provider !== s.model.provider) throw new Error(`The session uses ${s.model.provider}, not ${b.provider}.`);
        const apiKey = await this.deps.getKey(b.provider);
        if (!apiKey) throw new Error(`No API key for ${b.provider}.`);
        return { apiKey };
      },
      "event.emit": async b => {
        const s = session();
        const ev = this.fromPayload(b.type, b.payload);
        return { seq: (await this.emit(s.id, ev)).seq };
      },
    };
  }

  private fromPayload(type: "message" | "tool_call" | "tool_result" | "error" | "receipt", payload: unknown): NewAgentEvent {
    const p = (payload ?? {}) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    switch (type) {
      case "message": return { type: "message", text: s(p.text) };
      case "tool_call": return { type: "tool_call", tool: s(p.tool), args: p.args };
      case "tool_result": return { type: "tool_result", tool: s(p.tool), ok: p.ok === true, summary: s(p.summary) };
      case "error": return { type: "error", message: s(p.message) };
      case "receipt": return { type: "receipt", receipt: p as never };
    }
  }
}

/** The webview-protocol handlers this controller serves; Lane 2's bridge router registers them by name. */
export function sessionsBridgeHandlers(c: SessionsController, store: Pick<StorePort, "getSession" | "listSessions">) {
  return {
    "agent.start": async (r: Req<"agent.start">): Promise<Res<"agent.start">> => c.start(r.taskId, r.model),
    "agent.cancel": async (r: Req<"agent.cancel">): Promise<Res<"agent.cancel">> => c.cancel(r.sessionId),
    "sessions.get": async (r: Req<"sessions.get">): Promise<Res<"sessions.get">> => {
      const s = await store.getSession(r.sessionId);
      if (!s) throw new Error(`No session ${r.sessionId}.`);
      return s;
    },
    "sessions.list": async (r: Req<"sessions.list">): Promise<Res<"sessions.list">> => (await store.listSessions()).filter(s => !r.status || s.status === r.status),
  };
}

/** Subscription form of agent.subscribe: replay from fromSeq, then live. */
export function sessionsSubscriptions(c: SessionsController) {
  return {
    "agent.subscribe": (r: { sessionId: string; fromSeq: number }, emit: (e: AgentEvent) => void): Unsubscribe => c.subscribe(r.sessionId, r.fromSeq, emit),
  };
}
