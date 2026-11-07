import type { AgentEvent, AgentSession, ApprovalRequest, DecidedBy, ModelCallReceipt, NexusEvent, SwarmReview, Task, TaskPlan, Thread } from "../../contracts";
import type { ApprovalRequester } from "../sessions/sessions-controller";
import type { Clock, DecideResult, GatePort, GateRequestName, GitPort, SessionWorktree, SlackPort, StorePort } from "../ports";
import type { AgentReqOut, AgentResIn } from "../../agent/process-host";

// In-memory implementations of Lane 1's ports, for controller tests and for running the agent path with no Lane 2
// services. Deterministic: ids count up, time moves one second per call.

export function fakeClock(startIso = "2026-11-07T03:15:00Z"): Clock & { calls: number } {
  const start = Date.parse(startIso);
  const counters = new Map<string, number>();
  const c = {
    calls: 0,
    now: () => new Date(start + 1000 * c.calls++).toISOString(),
    newId: (prefix: string) => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${n}`;
    },
  };
  return c;
}

export class MemoryStore implements StorePort {
  readonly tasks = new Map<string, Task>();
  readonly sessions = new Map<string, AgentSession>();
  readonly events = new Map<string, AgentEvent[]>();
  readonly approvals = new Map<string, ApprovalRequest>();
  readonly nexusEvents: NexusEvent[] = [];
  readonly reviews = new Map<string, SwarmReview[]>();          // by approval id, oldest first
  readonly plans = new Map<string, TaskPlan>();
  readonly receipts: ModelCallReceipt[] = [];
  /** Test hook: make the next appendAgentEvent calls fail. */
  failAppends = 0;

  async putTask(t: Task) { this.tasks.set(t.id, structuredClone(t)); }
  async getTask(id: string) { const t = this.tasks.get(id); return t && structuredClone(t); }
  async listTasks() { return [...this.tasks.values()].map(t => structuredClone(t)); }
  async putSession(s: AgentSession) { this.sessions.set(s.id, structuredClone(s)); }
  async getSession(id: string) { const s = this.sessions.get(id); return s && structuredClone(s); }
  async listSessions() { return [...this.sessions.values()].map(s => structuredClone(s)); }
  async appendAgentEvent(e: AgentEvent) {
    if (this.failAppends > 0) { this.failAppends--; throw new Error("store unavailable"); }
    const list = this.events.get(e.sessionId) ?? [];
    list.push(structuredClone(e));
    this.events.set(e.sessionId, list);
  }
  async agentEvents(sessionId: string, fromSeq: number) { return (this.events.get(sessionId) ?? []).filter(e => e.seq >= fromSeq).map(e => structuredClone(e)); }
  async putApproval(a: ApprovalRequest) { this.approvals.set(a.id, structuredClone(a)); }
  async getApproval(id: string) { const a = this.approvals.get(id); return a && structuredClone(a); }
  async listApprovals() { return [...this.approvals.values()].map(a => structuredClone(a)); }
  async decideApproval(id: string, decision: "approved" | "rejected", decidedBy: DecidedBy, at: string): Promise<DecideResult> {
    const a = this.approvals.get(id);
    if (!a) throw new Error(`No approval ${id}.`);
    if (a.decision) return { approval: structuredClone(a), won: false };          // conditional: only while undecided
    const decided: ApprovalRequest = { ...a, decision, decidedBy, decidedAt: at };
    this.approvals.set(id, decided);
    return { approval: structuredClone(decided), won: true };
  }
  async putNexusEvent(e: NexusEvent) { this.nexusEvents.push(structuredClone(e)); }
  async putReview(r: SwarmReview) {
    const list = this.reviews.get(r.approvalId) ?? [];
    const i = list.findIndex(x => x.id === r.id);
    if (i >= 0) list[i] = structuredClone(r); else list.push(structuredClone(r));
    this.reviews.set(r.approvalId, list);
  }
  async getReviewForApproval(approvalId: string) { const r = this.reviews.get(approvalId)?.at(-1); return r && structuredClone(r); }
  async putReceipt(r: ModelCallReceipt) { if (!this.receipts.some(x => x.callId === r.callId)) this.receipts.push(structuredClone(r)); }
  async listReceipts(sessionId?: string) { return this.receipts.filter(r => !sessionId || r.sessionId === sessionId).map(r => structuredClone(r)); }
  async putPlan(p: TaskPlan) { this.plans.set(p.id, structuredClone(p)); }
  async getPlan(id: string) { const p = this.plans.get(id); return p && structuredClone(p); }
}

export class FakeGit implements GitPort {
  readonly created: Array<{ sessionId: string; workspaceId: string }> = [];
  /** Tests assign this to observe cleanup after a session that could not start. */
  removeSessionWorktree?: (sessionId: string) => Promise<void>;
  constructor(private readonly base: Partial<SessionWorktree> = {}) {}
  async createSessionWorktree(input: { sessionId: string; workspaceId: string }): Promise<SessionWorktree> {
    this.created.push(input);
    return {
      branch: `nexus/agent-${input.sessionId}`, worktreePath: `/tmp/nexus-sessions/${input.sessionId}`,
      baseCommit: "3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21", baseBranch: "main", ...this.base,
    };
  }
}

export class FakeSlack implements SlackPort {
  constructor(private readonly threads: Thread[] = []) {}
  async getThread(channelId: string, threadTs: string): Promise<Thread> {
    const t = this.threads.find(x => x.channelId === channelId && x.threadTs === threadTs);
    if (!t) throw new Error(`No thread ${channelId}/${threadTs}.`);
    return structuredClone(t);
  }
}

/** A gate with an in-memory worktree. cmd.run and git.commit ask the approvals requester, like the real gate will. */
export class MemoryGate implements GatePort {
  readonly files = new Map<string, string>();
  readonly requests: Array<{ sessionId: string; name: GateRequestName; body: unknown }> = [];
  private lastWritten: string | undefined;
  /** Output of the next cmd.run, for tests that need a specific exit code or tail. */
  commandResult = { exitCode: 0, stdoutTail: "Tests  12 passed (12)", stderrTail: "" };

  constructor(opts: { files?: Record<string, string>; approvals?: ApprovalRequester } = {}) {
    for (const [p, c] of Object.entries(opts.files ?? {})) this.files.set(p, c);
    this.approvals = opts.approvals;
  }
  private readonly approvals?: ApprovalRequester;

  private async approve(session: AgentSession, action: Parameters<ApprovalRequester["request"]>[0]["action"], reason: string): Promise<string> {
    if (!this.approvals) return "apr_auto";
    const { approval, decision } = await this.approvals.request({ sessionId: session.id, action, reason });
    if (decision === "rejected") throw new Error("rejected by a human");
    return approval.id;
  }

  async request<K extends GateRequestName>(session: AgentSession, name: K, body: AgentReqOut<K>): Promise<AgentResIn<K>> {
    this.requests.push({ sessionId: session.id, name, body });
    const b = body as Record<string, unknown>;
    const out = await this.handle(session, name, b);
    return out as AgentResIn<K>;
  }

  private async handle(session: AgentSession, name: GateRequestName, b: Record<string, unknown>): Promise<unknown> {
    const checked = (p: unknown) => {
      const path = String(p);
      if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes("..")) throw new Error(`path outside the session worktree: ${path}`);
      return path;
    };
    switch (name) {
      case "fs.read": {
        const c = this.files.get(checked(b.path));
        if (c === undefined) throw new Error(`ENOENT: ${String(b.path)}`);
        return { content: c, truncated: false };
      }
      case "fs.write": { this.files.set(checked(b.path), String(b.content)); this.lastWritten = String(b.path); return { bytes: Buffer.byteLength(String(b.content)) }; }
      case "fs.list": return { entries: [...this.files.keys()].sort() };
      case "git.diff": return { diff: this.lastWritten ? `--- a/${this.lastWritten}\n+++ b/${this.lastWritten}\n@@ -1 +1 @@\n-old\n+new\n` : "" };
      case "cmd.run": {
        const id = await this.approve(session, { kind: "run_command", command: String(b.command) }, "run a command");
        return { ...this.commandResult, approvalId: id };
      }
      case "git.commit": {
        const id = await this.approve(session, { kind: "commit", message: String(b.message) }, "commit the change");
        return { sha: "9d4e1b7c2a5f8e3d6c0b9a8f7e6d5c4b3a2f1e0d", approvalId: id };
      }
    }
  }
}
