// CombinedStore: the EventStore the rest of the extension uses. LocalStore (the offline copy and outbox) in front, a remote
// EventStore (TigerStore in production) behind.
//
// Writes: local first (that is what the UI reads and what survives offline; it also queues the write in the local outbox),
// then sent to the remote in the background. A remote failure leaves the write queued and flips the status offline.
// Approval decisions are the exception: online, the decision is made REMOTELY first (the conditional UPDATE is what makes
// the first answer win across machines) and then mirrored locally. Offline it is decided locally and queued; if it later
// loses remotely, the local copy is corrected to the winner and published.
// Reads: remote within a time budget (falling back to local), merged with the local copy so a write not yet flushed is
// still visible. Live remote changes arrive in L2-11, not here; subscriptions publish local changes only.
import type {
  AgentEvent, AgentSession, ApprovalRequest, DecidedBy, EventQuery, EventSearchHit, ModelCallReceipt,
  NexusEvent, SwarmReview, Task, TaskPlan,
} from "../../contracts";
import type { LocalStore, OutboxEntry } from "./local-store";
import type { DecideResult, EventStore, StatusEvent, StoreStatus, Unsubscribe } from "./store";
import { isTransientError } from "./tiger-store";

/** What a remote must offer for owner decisions to converge (TigerStore does). Without it a lost owner decision is only corrected locally. */
export interface DecisionOverride {
  overrideDecision(id: string, decision: "approved" | "rejected", decidedBy: DecidedBy, at: string): Promise<ApprovalRequest>;
}

/**
 * Thrown by decideApproval when the shared store cannot answer and this machine is not the one running the session's agent.
 * Nothing was decided anywhere. `code` is "offline".
 */
export class ApprovalOfflineError extends Error {
  readonly code = "offline";
  constructor() { super("The shared store is unreachable; only the machine running this agent can decide while offline."); }
}

export interface CombinedStoreOptions {
  /** This machine's id. It owns a session (and so its approvals) when it equals the session's `machineId`. */
  machineId: string;
  local: LocalStore;
  remote: EventStore & Partial<DecisionOverride>;
  /** How long a remote read may take before the local copy answers instead. Default 1500. */
  readBudgetMs?: number;
  /** How long a remote write may take before it counts as failed (and stays queued). Default 10000. */
  writeBudgetMs?: number;
  /**
   * How long the remote conditional UPDATE for an approval decision may take before this machine stops waiting. Default 11000:
   * longer than the Tiger pool's own 10 s query_timeout, so a query the pool would itself fail reports that failure instead of
   * us giving up on an UPDATE that may still be applying. Shorter budgets are allowed (tests), but each timeout leaves the UPDATE
   * in flight; its late result is reconciled either way.
   */
  decideBudgetMs?: number;
  now?: () => string;
}

export interface FlushResult { flushed: number; remaining: number }

/** A queued write the remote refused for good (a constraint or data error, an unparseable row). Never includes the record itself. */
export interface DeadLetter { table: string; op: string; key: string; reason: string; at: string }

const clone = <T>(value: T): T => structuredClone(value);
const safely = (fn: () => void) => { try { fn(); } catch { /* one throwing subscriber cannot break the store */ } };
const FAILED = Symbol("remote failed");

class BudgetExceeded extends Error {
  constructor() { super("remote did not answer within its time budget"); }
}

/** Rejects if the promise has not settled within ms; the late result (or error) is ignored. */
function withBudget<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BudgetExceeded()), ms);
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

/** The identity of a record inside its table, for deciding which side wins a merge. */
function recordKey(table: OutboxEntry["table"], record: unknown): string {
  const r = (record ?? {}) as Record<string, unknown>;
  if (table === "agent_events") return `${String(r.sessionId)}:${String(r.seq)}`;
  if (table === "receipts") return String(r.callId);
  return String(r.id);
}

const ms = (iso: string) => Date.parse(iso);

export class CombinedStore implements EventStore {
  private readonly local: LocalStore;
  private readonly remote: EventStore & Partial<DecisionOverride>;
  private readonly readBudget: number;
  private readonly writeBudget: number;
  private readonly decideBudget: number;
  private readonly machineId: string;
  private deadLetterListeners = new Set<(letter: DeadLetter) => void>();
  private deadLetterList: DeadLetter[] = [];
  private readonly now: () => string;

  private online = true;
  private flushing: Promise<FlushResult> | undefined;
  /** Remote winners that overrule a local decision made offline. In memory: after a restart the remote read supplies the winner. */
  private corrections = new Map<string, ApprovalRequest>();
  private approvalListeners = new Set<(approval: ApprovalRequest) => void>();

  constructor(opts: CombinedStoreOptions) {
    this.local = opts.local;
    this.remote = opts.remote;
    this.readBudget = opts.readBudgetMs ?? 1500;
    this.writeBudget = opts.writeBudgetMs ?? 10_000;
    this.decideBudget = opts.decideBudgetMs ?? 11_000;
    this.machineId = opts.machineId;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  // ---- tasks ----
  async putTask(task: Task) { await this.local.putTask(task); this.schedule(); }
  async getTask(id: string) {
    const local = await this.local.getTask(id);
    const remote = await this.tryRemote(() => this.remote.getTask(id));
    return remote === FAILED || remote === undefined || this.isDirty("tasks", id) ? local : remote;
  }
  async listTasks() {
    return this.mergeList("tasks", await this.local.listTasks(), await this.tryRemote(() => this.remote.listTasks()), t => t.id, t => ms(t.createdAt));
  }

  // ---- sessions ----
  async putSession(session: AgentSession) { await this.local.putSession(session); this.schedule(); }
  async getSession(id: string) {
    const local = await this.local.getSession(id);
    const remote = await this.tryRemote(() => this.remote.getSession(id));
    return remote === FAILED || remote === undefined || this.isDirty("sessions", id) ? local : remote;
  }
  async listSessions() {
    return this.mergeList("sessions", await this.local.listSessions(), await this.tryRemote(() => this.remote.listSessions()), s => s.id, s => ms(s.startedAt));
  }

  // ---- agent events ----
  async appendAgentEvent(event: AgentEvent) { await this.local.appendAgentEvent(event); this.schedule(); }
  async agentEvents(sessionId: string, fromSeq: number) {
    const local = await this.local.agentEvents(sessionId, fromSeq);
    const remote = await this.tryRemote(() => this.remote.agentEvents(sessionId, fromSeq));
    return this.mergeList("agent_events", local, remote, e => `${e.sessionId}:${e.seq}`, e => e.seq);
  }

  // ---- approvals ----
  async putApproval(approval: ApprovalRequest) { await this.local.putApproval(approval); this.schedule(); }
  async getApproval(id: string) {
    const local = await this.local.getApproval(id);
    const remote = await this.tryRemote(() => this.remote.getApproval(id));
    const chosen = remote === FAILED || remote === undefined || this.isDirty("approvals", id) ? local : remote;
    return this.corrected(chosen);
  }
  async listApprovals() {
    const merged = this.mergeList("approvals", await this.local.listApprovals(), await this.tryRemote(() => this.remote.listApprovals()), a => a.id, a => ms(a.requestedAt));
    return merged.map(a => this.corrected(a)!);
  }

  /**
   * Always tries the remote conditional UPDATE first, whatever the cached online flag says: a slow read must never turn decisions
   * local-only, because only the remote UPDATE makes the first answer win across machines. When the remote answers, that answer
   * is final and mirrored locally. When it cannot (unreachable, over budget, row missing or unparseable), see
   * decideWhenRemoteUnreachable. An UPDATE that is over budget keeps running; its late answer is reconciled when it settles.
   */
  async decideApproval(id: string, decision: "approved" | "rejected", decidedBy: DecidedBy, at: string): Promise<DecideResult> {
    const attempt = this.attemptRemoteDecide(id, decision, decidedBy, at);
    let result: DecideResult | undefined;
    let overBudget = false;
    try {
      result = await withBudget(attempt, this.decideBudget);
      this.setOnline(true);
    } catch (err) {
      overBudget = err instanceof BudgetExceeded;
      if (isTransientError(err)) this.setOnline(false);
    }
    if (result) {
      await this.reconcileAnswer(result);
      this.schedule();   // the remote is reachable: send the backlog
      return { approval: clone(result.approval), won: result.won };
    }
    const fallback = this.decideWhenRemoteUnreachable(id, decision, decidedBy, at);
    if (overBudget) {
      // The UPDATE may still land. Once the local fallback has finished (an owner's local decision must exist before we
      // compare), take its late answer into account.
      void Promise.allSettled([attempt, fallback]).then(async ([late]) => {
        if (late.status === "fulfilled") await this.reconcileAnswer(late.value);
      }).catch(() => undefined);
    } else {
      attempt.catch(() => undefined);
    }
    return fallback;
  }

  private async attemptRemoteDecide(id: string, decision: "approved" | "rejected", decidedBy: DecidedBy, at: string): Promise<DecideResult> {
    await this.sendPendingApprovalPuts(id);   // the approval must exist remotely; unrelated backlog is not waited for
    return this.remote.decideApproval(id, decision, decidedBy, at);
  }

  /**
   * POLICY POINT. The remote could not decide. The machine running the session's agent is the final authority for that session's
   * approvals, so an agent never acts on a decision that can later lose:
   *  - the OWNER decides locally (that wakes its agent) and queues the decision; if Tiger holds a different one when it flushes,
   *    the owner's decision is written over it, so every machine converges on what the agent did;
   *  - anyone else decides nothing, anywhere, and gets an ApprovalOfflineError.
   * Swap this function to change the policy.
   */
  private async decideWhenRemoteUnreachable(id: string, decision: "approved" | "rejected", decidedBy: DecidedBy, at: string): Promise<DecideResult> {
    if (!(await this.isOwner(id))) throw new ApprovalOfflineError();
    const r = await this.local.decideApproval(id, decision, decidedBy, at);
    const corrected = this.corrected(r.approval);
    return { approval: corrected, won: r.won && corrected === r.approval };
  }

  /** True when this machine runs the approval's session. Looks the approval and session up locally, then remotely; unknown means no. */
  private async isOwner(approvalId: string): Promise<boolean> {
    const approval = (await this.local.getApproval(approvalId)) ?? (await this.lookupRemote(() => this.remote.getApproval(approvalId)));
    if (!approval) return false;
    const session = (await this.local.getSession(approval.sessionId)) ?? (await this.lookupRemote(() => this.remote.getSession(approval.sessionId)));
    return session?.machineId === this.machineId;
  }

  /** A remote lookup that never throws and never touches the online flag. */
  private async lookupRemote<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try { return await withBudget(fn(), this.readBudget); } catch { return undefined; }
  }

  /**
   * Takes the remote's answer for an approval into the local copy. The owner is the exception: if its agent already acted on a local
   * decision that differs from the remote winner, the owner's decision is written over the winner instead of adopting it.
   */
  private async reconcileAnswer(result: DecideResult): Promise<void> {
    const winner = result.approval;
    const local = await this.local.getApproval(winner.id);
    if (local?.decision && winner.decision) {
      if (local.decision === winner.decision) {
        this.ackDecideEntries(winner.id);   // Tiger holds the decision the agent acted on; the queued copy is redundant
        return;
      }
      const override = this.remote.overrideDecision?.bind(this.remote);
      if (override && local.decidedBy && local.decidedAt && await this.isOwner(winner.id)) {
        await withBudget(override(winner.id, local.decision, local.decidedBy, local.decidedAt), this.writeBudget);
        this.ackDecideEntries(winner.id);
        return;
      }
    }
    await this.mirrorApproval(winner);
  }

  private ackDecideEntries(approvalId: string): void {
    const ids = this.local.pendingOutbox().filter(e => e.table === "approvals" && e.op === "decide" && recordKey(e.table, e.record) === approvalId).map(e => e.id);
    if (ids.length) this.local.ackOutbox(ids, this.now());
  }

  /** Called with each write the remote refused for good (so the lead can notify). Returns an unsubscribe. */
  onDeadLetter(listener: (letter: DeadLetter) => void): Unsubscribe {
    this.deadLetterListeners.add(listener);
    return () => { this.deadLetterListeners.delete(listener); };
  }

  // ---- events ----
  async putNexusEvent(event: NexusEvent) { await this.local.putNexusEvent(event); this.schedule(); }

  // ---- reviews, receipts, plans ----
  async putReview(review: SwarmReview) { await this.local.putReview(review); this.schedule(); }
  async getReviewForApproval(approvalId: string) {
    const local = await this.local.getReviewForApproval(approvalId);
    const remote = await this.tryRemote(() => this.remote.getReviewForApproval(approvalId));
    if (remote === FAILED || remote === undefined) return local;
    return local && local.at > remote.at ? local : remote;
  }

  async putReceipt(receipt: ModelCallReceipt) { await this.local.putReceipt(receipt); this.schedule(); }
  async listReceipts(sessionId?: string) {
    const local = await this.local.listReceipts(sessionId);
    const remote = await this.tryRemote(() => this.remote.listReceipts(sessionId));
    return this.mergeList("receipts", local, remote, r => r.callId, r => ms(r.at));
  }

  async putPlan(plan: TaskPlan) { await this.local.putPlan(plan); this.schedule(); }
  async getPlan(id: string) {
    const local = await this.local.getPlan(id);
    const remote = await this.tryRemote(() => this.remote.getPlan(id));
    return remote === FAILED || remote === undefined || this.isDirty("plans", id) ? local : remote;
  }

  // ---- read side ----
  async queryEvents(query: EventQuery) {
    const local = await this.local.queryEvents(query);
    const remote = await this.tryRemote(() => this.remote.queryEvents(query));
    if (remote === FAILED) return local;
    return this.mergeList("events", local, remote, e => e.id, e => ms(e.at)).slice(0, query.limit ?? 2000);
  }

  async searchEvents(text: string, limit: number): Promise<EventSearchHit[]> {
    const local = await this.local.searchEvents(text, limit);
    const remote = await this.tryRemote(() => this.remote.searchEvents(text, limit));
    if (remote === FAILED) return local;
    const best = new Map<string, EventSearchHit>();
    for (const h of [...remote, ...local]) {
      const seen = best.get(h.event.id);
      if (!seen || h.score > seen.score) best.set(h.event.id, h);
    }
    return [...best.values()].sort((a, b) => b.score - a.score || ms(b.event.at) - ms(a.event.at)).slice(0, limit);
  }

  subscribeEvents(listener: (event: NexusEvent) => void): Unsubscribe { return this.local.subscribeEvents(listener); }
  subscribeApprovals(listener: (approval: ApprovalRequest) => void): Unsubscribe {
    const offLocal = this.local.subscribeApprovals(listener);
    this.approvalListeners.add(listener);
    return () => { offLocal(); this.approvalListeners.delete(listener); };
  }
  subscribeStatus(listener: (status: StatusEvent) => void): Unsubscribe { return this.local.subscribeStatus(listener); }
  status(): Promise<StoreStatus> { return this.local.status(); }

  // ---- outbox ----
  /**
   * Sends the queued writes to the remote, oldest first, removing each from the outbox once the remote has it. Stops at the first
   * failure (that entry and everything after it stay queued and the status goes offline). Safe to repeat: the remote writes are
   * idempotent. Concurrent calls share one run. L2-11 calls this when the connection comes back.
   */
  flushOutbox(): Promise<FlushResult> {
    if (!this.flushing) this.flushing = this.drain();
    return this.flushing;
  }

  /** Resolves once the background flush (if any) has finished. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.flushing) await this.flushing.catch(() => undefined);
  }

  private async drain(): Promise<FlushResult> {
    await null;   // lets flushOutbox record this run before it can finish
    let flushed = 0;
    for (;;) {
      const entries = this.local.pendingOutbox();
      if (entries.length === 0) {
        if (flushed > 0) this.setOnline(true);
        this.flushing = undefined;   // cleared in the same tick as the empty check, so a write cannot slip in between and be stranded
        return { flushed, remaining: 0 };
      }
      for (const entry of entries) {
        try {
          if (await this.deliver(entry)) flushed++;
        } catch {
          this.setOnline(false);
          this.flushing = undefined;
          return { flushed, remaining: this.local.pendingOutbox().length };
        }
      }
    }
  }

  /**
   * Sends one queued write and removes it from the outbox. Throws only for a transient failure (the entry stays queued). A write the
   * remote refuses for good is recorded as a dead letter and removed, so it cannot stall everything behind it. Returns whether it was sent.
   */
  private async deliver(entry: OutboxEntry): Promise<boolean> {
    try {
      const decided = await withBudget(this.send(entry), this.writeBudget);
      // A decision queued while the remote was unreachable lost: the owner's overrides it, anyone else adopts the winner.
      // Done before the ack so a transient failure of the override leaves the entry queued.
      if (decided && !decided.won) await withBudget(this.reconcileAnswer(decided), this.writeBudget);
    } catch (err) {
      if (isTransientError(err)) throw err;
      const code = (err as { code?: unknown } | null)?.code;
      const letter: DeadLetter = { table: entry.table, op: entry.op, key: recordKey(entry.table, entry.record), reason: typeof code === "string" ? code : "refused", at: this.now() };
      this.deadLetterList.push(letter);
      if (this.deadLetterList.length > 100) this.deadLetterList.shift();
      this.local.ackOutbox([entry.id], this.now());
      for (const l of [...this.deadLetterListeners]) safely(() => l({ ...letter }));
      return false;
    }
    this.local.ackOutbox([entry.id], this.now());
    return true;
  }

  /** Writes the remote refused for good and dropped from the queue (this run of the extension). Keys only, never record contents. */
  deadLetters(): DeadLetter[] { return this.deadLetterList.map(d => ({ ...d })); }

  /** Sends just this approval's own queued puts, out of order (the remote has no foreign keys and the writes are idempotent). */
  private async sendPendingApprovalPuts(id: string): Promise<void> {
    for (const entry of this.local.pendingOutbox()) {
      if (entry.table === "approvals" && entry.op === "put" && recordKey(entry.table, entry.record) === id) await this.deliver(entry);
    }
  }

  private send(entry: OutboxEntry): Promise<DecideResult | undefined> {
    const r = entry.record as never;
    switch (entry.table) {
      case "tasks": return this.remote.putTask(r).then(() => undefined);
      case "sessions": return this.remote.putSession(r).then(() => undefined);
      case "agent_events": return this.remote.appendAgentEvent(r).then(() => undefined);
      case "events": return this.remote.putNexusEvent(r).then(() => undefined);
      case "reviews": return this.remote.putReview(r).then(() => undefined);
      case "receipts": return this.remote.putReceipt(r).then(() => undefined);
      case "plans": return this.remote.putPlan(r).then(() => undefined);
      case "approvals": {
        if (entry.op === "put") return this.remote.putApproval(r).then(() => undefined);
        const d = entry.record as { id: string; decision: "approved" | "rejected"; decidedBy: DecidedBy; decidedAt: string };
        return this.remote.decideApproval(d.id, d.decision, d.decidedBy, d.decidedAt);
      }
    }
  }

  /** Background send after a local write. Skipped while offline: a successful read, or L2-11's reconnect, restarts it. */
  private schedule() {
    if (this.online) void this.flushOutbox().catch(() => undefined);
  }

  // ---- approvals: mirroring the remote winner ----
  /** Makes the local copy agree with the remote's answer for an approval. Local changes made here are not re-sent. */
  private async mirrorApproval(winner: ApprovalRequest): Promise<void> {
    const decidedBy = winner.decidedBy, decidedAt = winner.decidedAt, decision = winner.decision;
    const local = await this.local.getApproval(winner.id);
    // Acks only the outbox entries this change created (this approval's own put or decide). Other callers' writes made while
    // it awaits stay queued and still reach the remote.
    const quiet = async (op: "put" | "decide", change: () => Promise<unknown>) => {
      const before = new Set(this.local.pendingOutbox().map(e => e.id));
      await change();
      const fresh = this.local.pendingOutbox()
        .filter(e => !before.has(e.id) && e.table === "approvals" && e.op === op && recordKey(e.table, e.record) === winner.id).map(e => e.id);
      if (fresh.length) this.local.ackOutbox(fresh, this.now());
    };
    if (!local) await quiet("put", () => this.local.putApproval(winner));
    if (!decision || !decidedBy || !decidedAt) return;
    const current = local ?? await this.local.getApproval(winner.id);
    if (current && !current.decision) {
      await quiet("decide", () => this.local.decideApproval(winner.id, decision, decidedBy, decidedAt));
    } else if (current && (current.decision !== decision || current.decidedBy?.userId !== decidedBy.userId || current.decidedBy?.via !== decidedBy.via)) {
      this.corrections.set(winner.id, clone(winner));
      for (const l of [...this.approvalListeners]) safely(() => l(clone(winner)));
    }
  }

  private corrected<T extends ApprovalRequest | undefined>(approval: T): T {
    const fix = approval && this.corrections.get(approval.id);
    return (fix ? clone(fix) : approval) as T;
  }

  // ---- remote access and merging ----
  private setOnline(online: boolean) {
    this.online = online;
    this.local.setOnline(online);
  }

  /** Runs a remote read within the budget. Success marks the store online (and restarts a stalled flush); failure marks it offline. */
  private async tryRemote<T>(fn: () => Promise<T>): Promise<T | typeof FAILED> {
    try {
      const value = await withBudget(fn(), this.readBudget);
      if (!this.online) {
        this.setOnline(true);
        this.schedule();
      }
      return value;
    } catch {
      this.setOnline(false);
      return FAILED;
    }
  }

  private pendingKeys(): Set<string> {
    return new Set(this.local.pendingOutbox().map(e => `${e.table}:${recordKey(e.table, e.record)}`));
  }

  private isDirty(table: OutboxEntry["table"], key: string): boolean {
    return this.pendingKeys().has(`${table}:${key}`);
  }

  /** Union by key, remote first. The local copy wins for a key that has a write still waiting in the outbox (remote is stale for it). */
  private mergeList<T>(table: OutboxEntry["table"], local: T[], remote: T[] | typeof FAILED, key: (item: T) => string, order: (item: T) => number): T[] {
    if (remote === FAILED) return local;
    const dirty = this.pendingKeys();
    const merged = new Map<string, T>();
    for (const item of remote) merged.set(key(item), item);
    for (const item of local) {
      const k = key(item);
      if (!merged.has(k) || dirty.has(`${table}:${k}`)) merged.set(k, item);
    }
    return [...merged.values()].sort((a, b) => order(a) - order(b));
  }
}
