// LocalStore: the on-disk EventStore. One append-only JSONL file per record kind in a per-workspace
// directory, plus outbox.jsonl of writes not yet confirmed remotely. Indexes live in memory and are
// rebuilt on open by replaying the files through the same rules live writes use.
// No vscode import: the directory is passed in.
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentEvent, AgentSession, ApprovalRequest, DecidedBy, EventQuery, EventSearchHit, ModelCallReceipt,
  NexusEvent, SwarmReview, Task, TaskPlan,
} from "../../contracts";
import { EventSearchIndex } from "./search";
import type { DecideResult, EventStore, StatusEvent, StoreStatus, Unsubscribe } from "./store";

const clone = <T>(value: T): T => structuredClone(value);
const cloneAll = <T>(values: T[]): T[] => values.map(clone);

/** Runs a listener so one throwing subscriber cannot break a write or starve the rest. */
function safely(fn: () => void) {
  try { fn(); } catch { /* ignored */ }
}

export type Table = "tasks" | "sessions" | "agent_events" | "approvals" | "events" | "reviews" | "receipts" | "plans";

/** A write not yet confirmed remotely. `decide` carries only the decision fields. */
export interface OutboxEntry {
  id: number;
  table: Table;
  op: "put" | "decide";
  record: unknown;
}

export interface LocalStoreOptions {
  /** The per-workspace directory; created if missing. */
  dir: string;
  /** Applied to every free-text field before it is stored or queued. Required: there is no pass-through default. */
  redact: (text: string) => string;
}

interface Journal { op: "put" | "decide"; record: unknown }

type DecideRecord = { id: string; decision: "approved" | "rejected"; decidedBy: DecidedBy; decidedAt: string };

const FILES: Record<Table, string> = {
  tasks: "tasks.jsonl",
  sessions: "sessions.jsonl",
  agent_events: "agent-events.jsonl",
  approvals: "approvals.jsonl",
  events: "events.jsonl",
  reviews: "reviews.jsonl",
  receipts: "receipts.jsonl",
  plans: "plans.jsonl",
};
const OUTBOX_FILE = "outbox.jsonl";

export class LocalStore implements EventStore {
  private readonly dir: string;
  private readonly redactText: (text: string) => string;

  private tasks = new Map<string, Task>();
  private sessions = new Map<string, AgentSession>();
  private agentLog = new Map<string, AgentEvent[]>();
  private agentSeqs = new Map<string, Set<number>>();
  private approvals = new Map<string, ApprovalRequest>();
  private eventsById = new Map<string, NexusEvent>();
  private eventsByTime: NexusEvent[] = [];        // ascending by `at`, stable for ties
  private searchIndex = new EventSearchIndex();
  private reviews: SwarmReview[] = [];
  private receipts = new Map<string, ModelCallReceipt>();
  private plans = new Map<string, TaskPlan>();

  private outboxEntries: OutboxEntry[] = [];
  private nextOutboxId = 1;
  private online = true;
  private lastSyncAt: string | undefined;

  private eventListeners = new Set<(event: NexusEvent) => void>();
  private approvalListeners = new Set<(approval: ApprovalRequest) => void>();
  private statusListeners = new Set<(status: StatusEvent) => void>();

  constructor(opts: LocalStoreOptions) {
    this.dir = opts.dir;
    this.redactText = opts.redact;
    fs.mkdirSync(this.dir, { recursive: true });
    this.replay();
  }

  // ---- tasks ----
  async putTask(task: Task) {
    const next = this.redactTask(clone(task));
    this.tasks.set(next.id, next);
    this.record("tasks", "put", next);
  }
  async getTask(id: string) { const t = this.tasks.get(id); return t && clone(t); }
  async listTasks() { return cloneAll([...this.tasks.values()]); }

  // ---- sessions ----
  async putSession(session: AgentSession) {
    const next = clone(session);
    this.sessions.set(next.id, next);
    this.record("sessions", "put", next);
  }
  async getSession(id: string) { const s = this.sessions.get(id); return s && clone(s); }
  async listSessions() { return cloneAll([...this.sessions.values()]); }

  // ---- agent events ----
  async appendAgentEvent(event: AgentEvent) {
    const next = this.redactAgentEvent(clone(event));
    if (!this.applyAgentEvent(next)) return;   // same event never stored twice
    this.record("agent_events", "put", next);
  }
  async agentEvents(sessionId: string, fromSeq: number) {
    return cloneAll((this.agentLog.get(sessionId) ?? []).filter(e => e.seq >= fromSeq));
  }

  // ---- approvals ----
  async putApproval(approval: ApprovalRequest) {
    const next = this.redactApproval(clone(approval));
    const merged = this.applyApprovalPut(next);
    if (!merged) return;   // no change, no write, no notification
    this.record("approvals", "put", stripDecision(next));
    this.emitApproval(merged);
  }
  async getApproval(id: string) { const a = this.approvals.get(id); return a && clone(a); }
  async listApprovals() { return cloneAll([...this.approvals.values()]); }
  async decideApproval(id: string, decision: "approved" | "rejected", decidedBy: DecidedBy, at: string): Promise<DecideResult> {
    const current = this.approvals.get(id);
    if (!current) throw new Error(`unknown approval ${id}`);
    if (current.decision) return { approval: clone(current), won: false };   // first answer wins
    const rec: DecideRecord = { id, decision, decidedBy: clone(decidedBy), decidedAt: at };
    const approval = this.applyDecide(rec)!;
    this.record("approvals", "decide", rec);
    this.emitApproval(approval);
    return { approval: clone(approval), won: true };
  }

  // ---- events ----
  async putNexusEvent(event: NexusEvent) {
    if (this.eventsById.has(event.id)) return;   // append-only
    const next = clone(event);
    next.title = this.redactText(next.title);
    this.applyEvent(next);
    this.record("events", "put", next);
    for (const l of [...this.eventListeners]) safely(() => l(clone(next)));
  }

  // ---- reviews, receipts, plans ----
  async putReview(review: SwarmReview) {
    const next = clone(review);
    if (next.summary !== undefined) next.summary = this.redactText(next.summary);
    next.judges = next.judges?.map(j => ({ ...j, notes: this.redactText(j.notes) }));
    if (next.judges === undefined) delete next.judges;
    this.reviews.push(next);
    this.record("reviews", "put", next);
  }
  async getReviewForApproval(approvalId: string) {
    const mine = this.reviews.filter(r => r.approvalId === approvalId);
    return mine.length ? clone(mine.reduce((a, b) => (b.at >= a.at ? b : a))) : undefined;
  }

  async putReceipt(receipt: ModelCallReceipt) {
    if (this.receipts.has(receipt.callId)) return;
    const next = clone(receipt);
    this.receipts.set(next.callId, next);
    this.record("receipts", "put", next);
  }
  async listReceipts(sessionId?: string) {
    return cloneAll([...this.receipts.values()].filter(r => !sessionId || r.sessionId === sessionId).sort((a, b) => a.at.localeCompare(b.at)));
  }

  async putPlan(plan: TaskPlan) {
    const next = clone(plan);
    next.subtasks = next.subtasks.map(s => ({ ...s, title: this.redactText(s.title), brief: this.redactText(s.brief) }));
    this.plans.set(next.id, next);
    this.record("plans", "put", next);
  }
  async getPlan(id: string) { const p = this.plans.get(id); return p && clone(p); }

  // ---- read side ----
  async queryEvents(query: EventQuery) {
    const from = Date.parse(query.from), to = Date.parse(query.to);
    const list = this.eventsByTime;
    let lo = 0, hi = list.length;                       // first index with at >= from
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (Date.parse(list[mid].at) < from) lo = mid + 1; else hi = mid;
    }
    const limit = query.limit ?? 2000;
    const out: NexusEvent[] = [];
    for (let i = lo; i < list.length && out.length < limit; i++) {
      const e = list[i];
      if (Date.parse(e.at) > to) break;
      if (query.orbits && !query.orbits.includes(e.orbit)) continue;
      if (query.kinds && !query.kinds.includes(e.kind)) continue;
      out.push(clone(e));
    }
    return out;
  }

  async searchEvents(text: string, limit: number): Promise<EventSearchHit[]> {
    return this.searchIndex.search(text, limit).map(h => ({ event: clone(h.event), score: h.score }));
  }

  subscribeEvents(listener: (event: NexusEvent) => void): Unsubscribe {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }
  subscribeApprovals(listener: (approval: ApprovalRequest) => void): Unsubscribe {
    this.approvalListeners.add(listener);
    return () => { this.approvalListeners.delete(listener); };
  }
  subscribeStatus(listener: (status: StatusEvent) => void): Unsubscribe {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }
  async status(): Promise<StoreStatus> {
    const s: StoreStatus = { online: this.online, outboxDepth: this.outboxEntries.length };
    if (this.lastSyncAt) s.lastSyncAt = this.lastSyncAt;
    return s;
  }

  // ---- outbox (used by the remote sync, later) ----
  /** Writes not yet confirmed remotely, oldest first. */
  pendingOutbox(): OutboxEntry[] { return cloneAll(this.outboxEntries); }

  /** Removes confirmed entries (by id) and records the sync time. */
  ackOutbox(ids: number[], at: string): void {
    const done = new Set(ids);
    this.outboxEntries = this.outboxEntries.filter(e => !done.has(e.id));
    this.lastSyncAt = at;
    this.rewriteOutbox();
    this.emitStatus();
  }

  /** Marks the remote reachable or not. */
  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    this.emitStatus();
  }

  // ---- journaling ----
  private record(table: Table, op: "put" | "decide", record: unknown) {
    const line = JSON.stringify({ op, record } satisfies Journal) + "\n";
    fs.appendFileSync(path.join(this.dir, FILES[table]), line);
    const entry: OutboxEntry = { id: this.nextOutboxId++, table, op, record: clone(record) };
    this.outboxEntries.push(entry);
    fs.appendFileSync(path.join(this.dir, OUTBOX_FILE), JSON.stringify(entry) + "\n");
    this.emitStatus();
  }

  private rewriteOutbox() {
    const file = path.join(this.dir, OUTBOX_FILE);
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, this.outboxEntries.map(e => JSON.stringify(e) + "\n").join(""));
    fs.renameSync(tmp, file);
  }

  /** Reads a JSONL file, skipping unparseable lines (a torn last line after a crash). Heals a missing final newline. */
  private readLines<T>(file: string): T[] {
    const full = path.join(this.dir, file);
    if (!fs.existsSync(full)) return [];
    const raw = fs.readFileSync(full, "utf8");
    if (raw.length > 0 && !raw.endsWith("\n")) fs.appendFileSync(full, "\n");   // never glue the next record onto a torn one
    const out: T[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object") out.push(parsed as T);
      } catch { /* torn line: skip */ }
    }
    return out;
  }

  private replay() {
    for (const j of this.readLines<Journal>(FILES.tasks)) this.tasks.set((j.record as Task).id, j.record as Task);
    for (const j of this.readLines<Journal>(FILES.sessions)) this.sessions.set((j.record as AgentSession).id, j.record as AgentSession);
    for (const j of this.readLines<Journal>(FILES.agent_events)) this.applyAgentEvent(j.record as AgentEvent);
    for (const j of this.readLines<Journal>(FILES.approvals)) {
      if (j.op === "decide") this.applyDecide(j.record as DecideRecord);
      else this.applyApprovalPut(j.record as ApprovalRequest);
    }
    const events = this.readLines<Journal>(FILES.events).map(j => j.record as NexusEvent);
    for (const e of events) {
      if (this.eventsById.has(e.id)) continue;
      this.eventsById.set(e.id, e);
      this.eventsByTime.push(e);
      this.searchIndex.add(e);
    }
    this.eventsByTime.sort((a, b) => a.at.localeCompare(b.at));   // stable
    for (const j of this.readLines<Journal>(FILES.reviews)) this.reviews.push(j.record as SwarmReview);
    for (const j of this.readLines<Journal>(FILES.receipts)) {
      const r = j.record as ModelCallReceipt;
      if (!this.receipts.has(r.callId)) this.receipts.set(r.callId, r);
    }
    for (const j of this.readLines<Journal>(FILES.plans)) this.plans.set((j.record as TaskPlan).id, j.record as TaskPlan);

    const outbox = this.readLines<OutboxEntry>(OUTBOX_FILE).filter(e => typeof e.id === "number");
    this.outboxEntries = outbox;
    this.nextOutboxId = outbox.reduce((m, e) => Math.max(m, e.id), 0) + 1;
  }

  // ---- apply rules, shared by live writes and replay ----
  private applyAgentEvent(event: AgentEvent): boolean {
    const seqs = this.agentSeqs.get(event.sessionId) ?? new Set<number>();
    if (seqs.has(event.seq)) return false;
    seqs.add(event.seq);
    this.agentSeqs.set(event.sessionId, seqs);
    const log = this.agentLog.get(event.sessionId) ?? [];
    log.push(event);
    log.sort((a, b) => a.seq - b.seq);
    this.agentLog.set(event.sessionId, log);
    return true;
  }

  /** Stores the approval with any existing decision preserved; returns the stored value, or undefined when nothing changed. */
  private applyApprovalPut(incoming: ApprovalRequest): ApprovalRequest | undefined {
    const existing = this.approvals.get(incoming.id);
    const next = stripDecision(clone(incoming));
    if (existing?.decision) {
      next.decision = existing.decision;
      if (existing.decidedBy) next.decidedBy = clone(existing.decidedBy);
      if (existing.decidedAt) next.decidedAt = existing.decidedAt;
    }
    if (existing && JSON.stringify(existing) === JSON.stringify(next)) return undefined;
    this.approvals.set(next.id, next);
    return next;
  }

  private applyDecide(rec: DecideRecord): ApprovalRequest | undefined {
    const current = this.approvals.get(rec.id);
    if (!current || current.decision) return undefined;
    const approval: ApprovalRequest = { ...current, decision: rec.decision, decidedBy: clone(rec.decidedBy), decidedAt: rec.decidedAt };
    this.approvals.set(rec.id, approval);
    return approval;
  }

  private applyEvent(event: NexusEvent) {
    this.eventsById.set(event.id, event);
    const list = this.eventsByTime;
    let lo = 0, hi = list.length;                       // upper bound keeps ties in insertion order
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid].at.localeCompare(event.at) <= 0) lo = mid + 1; else hi = mid;
    }
    list.splice(lo, 0, event);
    this.searchIndex.add(event);
  }

  // ---- redaction of free text ----
  private redactTask(t: Task): Task { t.title = this.redactText(t.title); t.brief = this.redactText(t.brief); return t; }

  private redactApproval(a: ApprovalRequest): ApprovalRequest {
    a.reason = this.redactText(a.reason);
    if (a.diffPreview !== undefined) a.diffPreview = this.redactText(a.diffPreview);
    const act = a.action;
    if (act.kind === "run_command") act.command = this.redactText(act.command);
    else if (act.kind === "write_outside_scope") act.path = this.redactText(act.path);
    else if (act.kind === "commit") act.message = this.redactText(act.message);
    else act.description = this.redactText(act.description);
    return a;
  }

  private redactAgentEvent(e: AgentEvent): AgentEvent {
    switch (e.type) {
      case "message": e.text = this.redactText(e.text); break;
      case "tool_call": e.args = this.redactDeep(e.args); break;
      case "tool_result": e.summary = this.redactText(e.summary); break;
      case "file_edit": e.diff = this.redactText(e.diff); break;
      case "error": e.message = this.redactText(e.message); break;
      case "test_output": e.command = this.redactText(e.command); e.tail = this.redactText(e.tail); break;
      default: break;
    }
    return e;
  }

  private redactDeep(value: unknown): unknown {
    if (typeof value === "string") return this.redactText(value);
    if (Array.isArray(value)) return value.map(v => this.redactDeep(v));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.redactDeep(v)]));
    }
    return value;
  }

  // ---- notifications ----
  private emitApproval(approval: ApprovalRequest) {
    for (const l of [...this.approvalListeners]) safely(() => l(clone(approval)));
  }
  private emitStatus() {
    const s: StatusEvent = { online: this.online, outboxDepth: this.outboxEntries.length };
    for (const l of [...this.statusListeners]) safely(() => l({ ...s }));
  }
}

function stripDecision(a: ApprovalRequest): ApprovalRequest {
  delete a.decision; delete a.decidedBy; delete a.decidedAt;
  return a;
}
