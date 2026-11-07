import { SYSTEM_RULES } from "../../agent/prompt-framing";
import type { AgentHandlers } from "../../agent/process-host";
import type { SessionFinished } from "../../agent-process/session-events";
import { AgentEvent, orbitOf, type AgentSession, type ApprovalAction, type ApprovalRequest, type ModelCallReceipt, type ModelInfo, type NexusEvent, type Req, type Res, type Task } from "../../contracts";
import { redact } from "../../shared/redact";
import { cleanString, sanitizeForEvent } from "../../shared/sanitize";
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
  request(input: { sessionId: string; action: ApprovalAction; reason: string; diffPreview?: string }): Promise<{ approval: ApprovalRequest; decision: "approved" | "rejected" }>;
  /** The session is over: release whatever is still waiting and refuse later decisions (a cancelled session's APPROVE must run nothing). */
  sessionEnded?(sessionId: string, how: "cancelled" | "failed" | "done"): Promise<void>;
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
  /** Whether the agent's next provider call should go through Prune (OptimizerService.pruneFor("agent")). */
  prune?: () => Promise<{ enabled: boolean; apiKey?: string }>;
  /** Called with every receipt the agent reports, so spend totals and the shared store see it. */
  onReceipt?: (receipt: ModelCallReceipt) => void;
  log?: (message: string) => void;
}

/** A cumulative diff can grow without bound over a session; events keep at most this much of it. */
const MAX_DIFF_CHARS = 20_000;

const TERMINAL = new Set<AgentSession["status"]>(["done", "failed", "cancelled"]);

interface Counter {
  next?: number;
  chain: Promise<unknown>;
}

export class SessionsController implements SessionEvents {
  private active?: { session: AgentSession; task: Task };
  /** Held from the first line of start() until the session is active, so two concurrent starts cannot both pass the guard. */
  private reserved = false;
  /** Endings in flight, so a second caller waits for the first instead of seeing a half-written session. */
  private readonly ending = new Map<string, Promise<AgentSession>>();
  /** The terminal session and task of each ended session, so a late write can be corrected. */
  private readonly settled = new Map<string, { session: AgentSession; task: Task }>();
  private readonly counters = new Map<string, Counter>();
  private readonly subscribers = new Map<string, Set<(e: AgentEvent) => void>>();
  private readonly allSubscribers = new Set<(e: AgentEvent) => void>();

  constructor(private readonly deps: SessionsDeps) {}

  /** Sessions this controller can host at once: one agent process runs one session (the scheduler never asks for more). */
  readonly capacity = 1;

  get activeSession(): AgentSession | undefined {
    return this.active?.session;
  }

  // ---- lifecycle ----

  async start(taskId: string, model: { provider: string; modelId: string }): Promise<AgentSession> {
    const { store, git, host, clock } = this.deps;
    if (this.reserved || this.active) throw new Error("An agent session is already running; cancel it or wait for it to finish.");
    this.reserved = true;                                       // synchronous with the check above: no await in between
    try {
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
      try {
        await store.putSession(session);
        await this.putTask(running);
      } catch (e) {
        // The agent never started: give the worktree back instead of leaking it.
        await Promise.resolve().then(() => git.removeSessionWorktree?.(id)).catch(err => this.deps.log?.(`could not remove worktree ${id}: ${err instanceof Error ? err.message : "unknown error"}`));
        throw e;
      }
      this.active = { session, task: running };

      try {
        await this.emit(id, { type: "status", status: "running" });
        await store.putNexusEvent(this.sessionEvent(session, running, orbitOf(wt.baseBranch)));
        await host.startSession({
          session: { id, taskId, branch: session.branch, worktreePath: session.worktreePath, baseCommit: session.baseCommit, model: session.model },
          task: running, systemRules: SYSTEM_RULES, untrustedBlocks: this.deps.untrustedBlocks?.(running) ?? [],
        });
      } catch (e) {
        // Whatever failed, the controller must not stay "busy" with an agent that never ran.
        await this.emit(id, { type: "error", message: `The agent did not start: ${redact(e instanceof Error ? e.message : "unknown error")}` }).catch(() => undefined);
        await this.finalize(id, "failed");
        throw new Error("The agent process did not start.", { cause: e });
      }
      return session;
    } finally {
      this.reserved = false;
    }
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
    const reason = outcome.reason;
    if (reason) await this.attempt("record the error", () => this.emit(outcome.sessionId, { type: "error", message: redact(reason) }));
    await this.finalize(outcome.sessionId, outcome.outcome);
  }

  /** ProcessHost.onSessionError: a crash loses the runtime's conversation, so the session fails rather than silently restarting. */
  async onProcessError(sessionId: string, message: string): Promise<void> {
    if (this.active?.session.id !== sessionId) return;
    await this.attempt("record the error", () => this.emit(sessionId, { type: "error", message: redact(message) }));
    await this.finalize(sessionId, "failed");
  }

  async setStatus(sessionId: string, status: "running" | "awaiting_approval"): Promise<void> {
    const a = this.active;
    if (!a || a.session.id !== sessionId || TERMINAL.has(a.session.status) || a.session.status === status) return;
    a.session = { ...a.session, status };
    a.task = { ...a.task, status };
    const live = () => this.active === a && !TERMINAL.has(a.session.status);
    // The session can end while a write below is in flight; its late non-terminal write would then land after the
    // terminal one. After every await, if it ended, put the terminal state back and drop the stale status event.
    await this.deps.store.putSession(a.session);
    if (!live()) return this.reassertTerminal(sessionId);
    await this.putTask(a.task);
    if (!live()) return this.reassertTerminal(sessionId);
    await this.emit(sessionId, { type: "status", status });
  }

  private async reassertTerminal(sessionId: string): Promise<void> {
    const t = this.settled.get(sessionId);
    if (!t) return;
    await this.attempt("restore the session", () => this.deps.store.putSession(t.session));
    await this.attempt("restore the task", () => this.putTask(t.task));
  }

  private async putTask(task: Task): Promise<void> {
    await this.deps.store.putTask(task);
    this.deps.onTaskChange?.(task);
  }

  private finalize(sessionId: string, status: "done" | "failed" | "cancelled"): Promise<AgentSession> {
    const a = this.active;
    if (!a || a.session.id !== sessionId) {
      // Someone else is already ending it: wait for that to finish so the caller sees the final state.
      return this.ending.get(sessionId) ?? this.deps.store.getSession(sessionId).then(s => s!);
    }
    const run = this.runFinalize(a, sessionId, status).finally(() => this.ending.delete(sessionId));
    this.ending.set(sessionId, run);
    return run;
  }

  private async runFinalize(a: NonNullable<SessionsController["active"]>, sessionId: string, status: "done" | "failed" | "cancelled"): Promise<AgentSession> {
    // Claim the ending before the first await, so a second finalize (cancel racing the child's own "finished") returns
    // above instead of running twice, and nothing can flip the session back to running while it ends.
    this.active = undefined;
    // Release anything still waiting on a human; a cancelled session's APPROVE must run nothing afterwards.
    await this.attempt("release approvals", () => this.deps.approvals?.sessionEnded?.(sessionId, status) ?? Promise.resolve());
    const ended: AgentSession = { ...a.session, status, endedAt: this.deps.clock.now() };
    this.settled.set(sessionId, { session: ended, task: { ...a.task, status } });
    // Each write is best effort: a store hiccup must never leave the controller wedged or the agent host un-ended.
    await this.attempt("save the session", () => this.deps.store.putSession(ended));
    await this.attempt("save the task", () => this.putTask({ ...a.task, status }));
    await this.attempt("record the final status", () => this.emit(sessionId, { type: "status", status }));
    this.deps.host.endSession(sessionId);
    return ended;
  }

  private async attempt(what: string, fn: () => Promise<unknown>): Promise<void> {
    try { await fn(); } catch (e) { this.deps.log?.(`could not ${what}: ${redact(e instanceof Error ? e.message : "unknown error")}`); }
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
      // The event is already stored: a broken subscriber must neither fail the emit nor starve the others.
      for (const cb of [...(this.subscribers.get(sessionId) ?? []), ...this.allSubscribers]) {
        try { cb(full); } catch (e) { this.deps.log?.(`an event subscriber failed: ${e instanceof Error ? e.message : "unknown error"}`); }
      }
      return full;
    });
    c.chain = run.catch(() => undefined);
    return run;
  }

  /** Every stored event of every session, live only (the bridge router does its own replay and ordering). */
  subscribeAll(cb: (e: AgentEvent) => void): Unsubscribe {
    this.allSubscribers.add(cb);
    return () => { this.allSubscribers.delete(cb); };
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
    this.deps.store.agentEvents(sessionId, fromSeq).then(past => {
      for (const e of past) deliver(e);
      for (const e of buffered.splice(0)) deliver(e);
      live = true;
    }).catch(e => {
      // The replay could not be loaded: say so, drop the buffer, and carry on with live events only.
      this.deps.log?.(`could not replay session ${sessionId}: ${e instanceof Error ? e.message : "unknown error"}`);
      buffered.length = 0;
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
        // Path and diff are redacted and size-capped here: the path is chosen by the model, the diff grows with the session.
        if (diff.trim().length > 0) await this.emit(s.id, { type: "file_edit", path: cleanString(b.path, 300), diff: cleanString(diff, MAX_DIFF_CHARS) });
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
        // Prune only when the toggle is on, the agent is in scope and a Prune key exists; the agent is never allowed to route.
        const prune = await this.deps.prune?.();
        return prune?.enabled && prune.apiKey ? { apiKey, prune: { enabled: true, apiKey: prune.apiKey, allowModelRouting: false as const } } : { apiKey };
      },
      "event.emit": async b => {
        const s = session();
        const ev = this.fromPayload(b.type, b.payload);
        return { seq: (await this.emit(s.id, ev)).seq };
      },
    };
  }

  private fromPayload(type: "message" | "tool_call" | "tool_result" | "error" | "receipt", payload: unknown): NewAgentEvent {
    // The child already sanitized its payloads; the host never trusts that and applies the same bounds again.
    const p = (sanitizeForEvent(payload ?? {}) ?? {}) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    switch (type) {
      case "message": return { type: "message", text: s(p.text) };
      case "tool_call": return { type: "tool_call", tool: cleanString(s(p.tool), 100), args: p.args };
      case "tool_result": return { type: "tool_result", tool: cleanString(s(p.tool), 100), ok: p.ok === true, summary: s(p.summary) };
      case "error": return { type: "error", message: s(p.message) };
      case "receipt": {
        this.deps.onReceipt?.(p as never);
        return { type: "receipt", receipt: p as never };
      }
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
