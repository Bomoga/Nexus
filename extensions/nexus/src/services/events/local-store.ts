// LocalStore: the on-disk EventStore. One append-only JSONL file per record kind in a per-workspace
// directory, plus outbox.jsonl of writes not yet confirmed remotely. Indexes live in memory and are
// rebuilt on open by replaying the files through the same rules live writes use.
// No vscode import: the directory is passed in.
//
// Write order for every mutation (all synchronous, so each method is atomic on the event loop):
//   1. validate the exact (redacted, JSON round-tripped) record against its contract schema and build
//      every line -- a throw here writes nothing; live writes and replay accept exactly the same records;
//   2. append to outbox.jsonl, then to the record's journal -- if either fails, both files are truncated
//      back to their sizes before the write, so no ghost outbox entry survives (a ghost decide would let
//      the remote store apply a decision this machine never recorded);
//   3. apply to memory; 4. notify listeners.
// A crash between the two appends can still leave an outbox entry with no journal line. Replay drops
// such entries (counted in skippedLines) and rewrites the outbox.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AgentEvent as AgentEventSchema, AgentSession as AgentSessionSchema, ApprovalRequest as ApprovalRequestSchema,
  DecidedBy as DecidedBySchema, ModelCallReceipt as ReceiptSchema, NexusEvent as NexusEventSchema,
  SwarmReview as SwarmReviewSchema, Task as TaskSchema, TaskPlan as TaskPlanSchema,
} from "../../contracts";
import type {
  AgentEvent, AgentSession, ApprovalRequest, DecidedBy, EventQuery, EventSearchHit, ModelCallReceipt,
  NexusEvent, SwarmReview, Task, TaskPlan,
} from "../../contracts";
import { z } from "zod";
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

const DecideRecordSchema = z.object({
  id: z.string().min(1), decision: z.enum(["approved", "rejected"]), decidedBy: DecidedBySchema, decidedAt: z.string().datetime({ offset: true }),
}).strict();

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
const STATE_FILE = "state.json";
const TABLES = new Set<string>(Object.keys(FILES));

/** Replay gates: a record must match its contract schema; the original (not the parsed copy) is kept. */
const SCHEMAS: Record<Table, z.ZodType> = {
  tasks: TaskSchema, sessions: AgentSessionSchema, agent_events: AgentEventSchema, approvals: ApprovalRequestSchema,
  events: NexusEventSchema, reviews: SwarmReviewSchema, receipts: ReceiptSchema, plans: TaskPlanSchema,
};

interface TimedEvent { ms: number; event: NexusEvent }

export class LocalStore implements EventStore {
  private readonly dir: string;
  private readonly redactText: (text: string) => string;

  private tasks = new Map<string, Task>();
  private sessions = new Map<string, AgentSession>();
  private agentLog = new Map<string, AgentEvent[]>();
  private agentSeqs = new Map<string, Set<number>>();
  private approvals = new Map<string, ApprovalRequest>();
  private eventsById = new Map<string, NexusEvent>();
  private eventsByTime: TimedEvent[] = [];        // ascending by epoch ms, stable for ties
  private searchIndex = new EventSearchIndex();
  private reviews: SwarmReview[] = [];
  private receipts = new Map<string, ModelCallReceipt>();
  private plans = new Map<string, TaskPlan>();

  private outboxEntries: OutboxEntry[] = [];
  private nextOutboxId = 1;
  private online = true;
  private lastSyncAt: string | undefined;
  private skipped = 0;

  private eventListeners = new Set<(event: NexusEvent) => void>();
  private approvalListeners = new Set<(approval: ApprovalRequest) => void>();
  private statusListeners = new Set<(status: StatusEvent) => void>();

  constructor(opts: LocalStoreOptions) {
    this.dir = opts.dir;
    this.redactText = opts.redact;
    fs.mkdirSync(this.dir, { recursive: true });
    this.replay();
  }

  /** How many lines were dropped on open (torn, malformed, failing their schema, or orphaned decisions). For the caller to log. */
  skippedLines(): number { return this.skipped; }

  // ---- tasks ----
  async putTask(task: Task) {
    const next = this.persist("tasks", "put", this.redactTask(clone(task))) as Task;
    this.tasks.set(next.id, next);
    this.emitStatus();
  }
  async getTask(id: string) { const t = this.tasks.get(id); return t && clone(t); }
  async listTasks() { return cloneAll([...this.tasks.values()]); }

  // ---- sessions ----
  async putSession(session: AgentSession) {
    const next = this.persist("sessions", "put", clone(session)) as AgentSession;
    this.sessions.set(next.id, next);
    this.emitStatus();
  }
  async getSession(id: string) { const s = this.sessions.get(id); return s && clone(s); }
  async listSessions() { return cloneAll([...this.sessions.values()]); }

  // ---- agent events ----
  async appendAgentEvent(event: AgentEvent) {
    if (this.agentSeqs.get(event.sessionId)?.has(event.seq)) return;   // same event never stored twice
    const next = this.persist("agent_events", "put", this.redactAgentEvent(clone(event))) as AgentEvent;
    this.applyAgentEvent(next);
    this.emitStatus();
  }
  async agentEvents(sessionId: string, fromSeq: number) {
    return cloneAll((this.agentLog.get(sessionId) ?? []).filter(e => e.seq >= fromSeq));
  }

  // ---- approvals ----
  async putApproval(approval: ApprovalRequest) {
    const stripped = stripDecision(this.redactApproval(clone(approval)));
    const merged = this.mergeApproval(this.check("approvals", "put", stripped) as ApprovalRequest);
    if (!merged) return;   // no change, no write, no notification
    this.persist("approvals", "put", stripped);
    this.approvals.set(merged.id, merged);
    this.emitApproval(merged);
    this.emitStatus();
  }
  async getApproval(id: string) { const a = this.approvals.get(id); return a && clone(a); }
  async listApprovals() { return cloneAll([...this.approvals.values()]); }
  async decideApproval(id: string, decision: "approved" | "rejected", decidedBy: DecidedBy, at: string): Promise<DecideResult> {
    const current = this.approvals.get(id);
    if (!current) throw new Error(`unknown approval ${id}`);
    if (current.decision) return { approval: clone(current), won: false };   // first answer wins
    const rec = this.persist("approvals", "decide", { id, decision, decidedBy: clone(decidedBy), decidedAt: at }) as DecideRecord;
    const approval = this.applyDecide(rec)!;
    this.emitApproval(approval);
    this.emitStatus();
    return { approval: clone(approval), won: true };
  }

  // ---- events ----
  async putNexusEvent(event: NexusEvent) {
    if (this.eventsById.has(event.id)) return;   // append-only
    const draft = clone(event);
    draft.title = this.redactText(draft.title);
    const next = this.persist("events", "put", draft) as NexusEvent;
    this.applyEvent(next);
    for (const l of [...this.eventListeners]) safely(() => l(clone(next)));
    this.emitStatus();
  }

  // ---- reviews, receipts, plans ----
  async putReview(review: SwarmReview) {
    const draft = clone(review);
    if (draft.summary !== undefined) draft.summary = this.redactText(draft.summary);
    if (draft.judges) draft.judges = draft.judges.map(j => ({ ...j, notes: this.redactText(j.notes) }));
    const next = this.persist("reviews", "put", draft) as SwarmReview;
    this.reviews.push(next);
    this.emitStatus();
  }
  async getReviewForApproval(approvalId: string) {
    const mine = this.reviews.filter(r => r.approvalId === approvalId);
    return mine.length ? clone(mine.reduce((a, b) => (b.at >= a.at ? b : a))) : undefined;
  }

  async putReceipt(receipt: ModelCallReceipt) {
    if (this.receipts.has(receipt.callId)) return;
    const next = this.persist("receipts", "put", this.redactReceipt(clone(receipt))) as ModelCallReceipt;
    this.receipts.set(next.callId, next);
    this.emitStatus();
  }
  async listReceipts(sessionId?: string) {
    return cloneAll([...this.receipts.values()].filter(r => !sessionId || r.sessionId === sessionId).sort((a, b) => a.at.localeCompare(b.at)));
  }

  async putPlan(plan: TaskPlan) {
    const draft = clone(plan);
    draft.subtasks = draft.subtasks.map(s => ({ ...s, title: this.redactText(s.title), brief: this.redactText(s.brief) }));
    const next = this.persist("plans", "put", draft) as TaskPlan;
    this.plans.set(next.id, next);
    this.emitStatus();
  }
  async getPlan(id: string) { const p = this.plans.get(id); return p && clone(p); }

  // ---- read side ----
  async queryEvents(query: EventQuery) {
    const from = Date.parse(query.from), to = Date.parse(query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
    const list = this.eventsByTime;
    let lo = 0, hi = list.length;                       // first index with ms >= from
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid].ms < from) lo = mid + 1; else hi = mid;
    }
    const limit = query.limit ?? 2000;
    const out: NexusEvent[] = [];
    for (let i = lo; i < list.length && out.length < limit; i++) {
      const { ms, event } = list[i];
      if (ms > to) break;
      if (query.orbits && !query.orbits.includes(event.orbit)) continue;
      if (query.kinds && !query.kinds.includes(event.kind)) continue;
      out.push(clone(event));
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

  /** Removes confirmed entries (by id) and records the sync time, which survives reopen. */
  ackOutbox(ids: number[], at: string): void {
    const done = new Set(ids);
    const remaining = this.outboxEntries.filter(e => !done.has(e.id));
    this.rewrite(OUTBOX_FILE, remaining.map(e => JSON.stringify(e) + "\n").join(""));
    this.outboxEntries = remaining;   // before the state write, so a failed state write cannot resurrect an acked entry
    try {
      this.rewrite(STATE_FILE, JSON.stringify({ lastSyncAt: at }));
      this.lastSyncAt = at;
    } finally {
      this.emitStatus();
    }
  }

  /** Marks the remote reachable or not. */
  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    this.emitStatus();
  }

  // ---- journaling ----
  /**
   * Validates and returns the canonical form of a record: exactly what replay would read back
   * (JSON round trip), checked against the same schema replay uses. Throws before anything is written.
   */
  private check(table: Table, op: "put" | "decide", record: unknown): unknown {
    const canonical: unknown = JSON.parse(JSON.stringify(record));
    const schema = op === "decide" ? DecideRecordSchema : SCHEMAS[table];
    const result = schema.safeParse(canonical);
    if (!result.success) throw new Error(`refusing to store invalid ${table} ${op} record: ${result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return canonical;
  }

  /** Steps 1 and 2 of the write order. Returns the canonical record to apply to memory; throws before touching memory. */
  private persist(table: Table, op: "put" | "decide", record: unknown): unknown {
    const canonical = this.check(table, op, record);
    const journalLine = JSON.stringify({ op, record: canonical } satisfies Journal) + "\n";
    const entry: OutboxEntry = { id: this.nextOutboxId, table, op, record: canonical };
    const outboxLine = JSON.stringify(entry) + "\n";
    this.nextOutboxId++;   // burned even if an append below fails, so ids never repeat on disk
    const journalFile = FILES[table];
    const sizes: [string, number][] = [[OUTBOX_FILE, this.sizeOf(OUTBOX_FILE)], [journalFile, this.sizeOf(journalFile)]];
    try {
      this.appendLine(OUTBOX_FILE, outboxLine);
      this.appendLine(journalFile, journalLine);
    } catch (err) {
      for (const [f, size] of sizes) {
        try { fs.truncateSync(path.join(this.dir, f), size); } catch { /* best effort */ }
      }
      throw err;
    }
    this.outboxEntries.push(clone(entry));
    return canonical;
  }

  /** 0 only for a missing file. Any other failure rethrows before a byte is written, so a rollback can never truncate to a wrong size. */
  private sizeOf(file: string): number {
    try { return this.fileSize(path.join(this.dir, file)); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw err;
    }
  }

  protected fileSize(file: string): number { return fs.statSync(file).size; }

  /** Appends one line, first closing a torn tail (no final newline) so a good record never glues onto torn bytes. */
  private appendLine(file: string, line: string) {
    const fd = fs.openSync(path.join(this.dir, file), "a+");
    try {
      const size = fs.fstatSync(fd).size;
      let prefix = "";
      if (size > 0) {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = "\n";
      }
      const bytes = Buffer.from(prefix + line);
      const written = fs.writeSync(fd, bytes);
      // A short write fails (not retried): the caller truncates both files back, so memory and disk stay in step.
      if (written !== bytes.length) throw new Error(`short write to ${file}: ${written} of ${bytes.length} bytes`);
    } finally {
      fs.closeSync(fd);
    }
  }

  private rewrite(file: string, content: string) {
    const full = path.join(this.dir, file);
    const tmp = full + ".tmp";
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, full);
  }

  /** Reads a JSONL file; unparseable or non-object lines (a torn tail, junk) are skipped and counted. */
  private readLines(file: string): Record<string, unknown>[] {
    const full = path.join(this.dir, file);
    if (!fs.existsSync(full)) return [];
    const out: Record<string, unknown>[] = [];
    for (const line of fs.readFileSync(full, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed as Record<string, unknown>);
        else this.skipped++;
      } catch { this.skipped++; }
    }
    return out;
  }

  private replay() {
    const journalKeys = new Set<string>();   // every well-formed journal line, to detect outbox entries with no journal line
    const journalOf = (table: Table, accept: (j: Journal) => boolean = () => true): Journal[] =>
      this.readLines(FILES[table]).filter((j): j is Record<string, unknown> & Journal => {
        const ok = (j.op === "put" || j.op === "decide") && j.record !== null && typeof j.record === "object" && accept(j as unknown as Journal);
        if (!ok) this.skipped++;
        else journalKeys.add(`${table}\0${JSON.stringify({ op: j.op, record: j.record })}`);
        return ok;
      });
    const valid = (table: Table, record: unknown): boolean => {
      const ok = SCHEMAS[table].safeParse(record).success;
      if (!ok) this.skipped++;
      return ok;
    };

    for (const j of journalOf("tasks", x => x.op === "put")) if (valid("tasks", j.record)) this.tasks.set((j.record as Task).id, j.record as Task);
    for (const j of journalOf("sessions", x => x.op === "put")) if (valid("sessions", j.record)) this.sessions.set((j.record as AgentSession).id, j.record as AgentSession);
    for (const j of journalOf("agent_events", x => x.op === "put")) if (valid("agent_events", j.record)) this.applyAgentEvent(j.record as AgentEvent, false);
    for (const log of this.agentLog.values()) log.sort((a, b) => a.seq - b.seq);   // once, not per line
    for (const j of journalOf("approvals")) {
      if (j.op === "decide") {
        if (!DecideRecordSchema.safeParse(j.record).success || !this.applyDecide(j.record as DecideRecord)) this.skipped++;
      } else if (valid("approvals", j.record)) {
        const merged = this.mergeApproval(j.record as ApprovalRequest);
        if (merged) this.approvals.set(merged.id, merged);
      }
    }
    for (const j of journalOf("events", x => x.op === "put")) {
      const e = j.record as NexusEvent;
      if (!valid("events", e)) continue;
      if (!Number.isFinite(Date.parse(e.at))) { this.skipped++; continue; }
      if (this.eventsById.has(e.id)) continue;
      this.eventsById.set(e.id, e);
      this.eventsByTime.push({ ms: Date.parse(e.at), event: e });
      this.searchIndex.add(e);
    }
    this.eventsByTime.sort((a, b) => a.ms - b.ms);   // stable
    for (const j of journalOf("reviews", x => x.op === "put")) if (valid("reviews", j.record)) this.reviews.push(j.record as SwarmReview);
    for (const j of journalOf("receipts", x => x.op === "put")) {
      const r = j.record as ModelCallReceipt;
      if (valid("receipts", r) && !this.receipts.has(r.callId)) this.receipts.set(r.callId, r);
    }
    for (const j of journalOf("plans", x => x.op === "put")) if (valid("plans", j.record)) this.plans.set((j.record as TaskPlan).id, j.record as TaskPlan);

    let ghosts = false;
    for (const e of this.readLines(OUTBOX_FILE)) {
      const ok = typeof e.id === "number" && Number.isInteger(e.id) && typeof e.table === "string" && TABLES.has(e.table)
        && (e.op === "put" || e.op === "decide") && e.record !== null && typeof e.record === "object";
      if (!ok) { this.skipped++; continue; }
      const entry = e as unknown as OutboxEntry;
      if (!journalKeys.has(`${entry.table}\0${JSON.stringify({ op: entry.op, record: entry.record })}`)) { this.skipped++; ghosts = true; continue; }   // crash between the two appends
      this.outboxEntries.push(entry);
    }
    if (ghosts) {
      try { this.rewrite(OUTBOX_FILE, this.outboxEntries.map(e => JSON.stringify(e) + "\n").join("")); } catch { /* counted again next open */ }
    }
    this.nextOutboxId = this.outboxEntries.reduce((m, e) => Math.max(m, e.id), 0) + 1;
    try {
      const state: unknown = JSON.parse(fs.readFileSync(path.join(this.dir, STATE_FILE), "utf8"));
      const at = (state as { lastSyncAt?: unknown } | null)?.lastSyncAt;
      if (typeof at === "string") this.lastSyncAt = at;
    } catch { /* no state yet */ }
  }

  // ---- apply rules, shared by live writes and replay ----
  private applyAgentEvent(event: AgentEvent, ordered = true): void {
    const seqs = this.agentSeqs.get(event.sessionId) ?? new Set<number>();
    if (seqs.has(event.seq)) return;
    seqs.add(event.seq);
    this.agentSeqs.set(event.sessionId, seqs);
    const log = this.agentLog.get(event.sessionId) ?? [];
    if (!ordered || log.length === 0 || log[log.length - 1].seq < event.seq) {
      log.push(event);                                  // the usual in-order case
    } else {
      let lo = 0, hi = log.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (log[mid].seq < event.seq) lo = mid + 1; else hi = mid;
      }
      log.splice(lo, 0, event);
    }
    this.agentLog.set(event.sessionId, log);
  }

  /** The approval as it would be stored (existing decision preserved), or undefined when nothing would change. Pure. */
  private mergeApproval(incoming: ApprovalRequest): ApprovalRequest | undefined {
    const existing = this.approvals.get(incoming.id);
    const next = stripDecision(clone(incoming));
    if (existing?.decision) {
      next.decision = existing.decision;
      if (existing.decidedBy) next.decidedBy = clone(existing.decidedBy);
      if (existing.decidedAt) next.decidedAt = existing.decidedAt;
    }
    if (existing && JSON.stringify(existing) === JSON.stringify(next)) return undefined;
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
    const ms = Date.parse(event.at);
    this.eventsById.set(event.id, event);
    const list = this.eventsByTime;
    let lo = 0, hi = list.length;                       // upper bound keeps ties in insertion order
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid].ms <= ms) lo = mid + 1; else hi = mid;
    }
    list.splice(lo, 0, { ms, event });
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

  private redactReceipt(r: ModelCallReceipt): ModelCallReceipt {
    r.optimizations = r.optimizations.map(o => this.redactText(o));
    return r;
  }

  private redactAgentEvent(e: AgentEvent): AgentEvent {
    switch (e.type) {
      case "message": e.text = this.redactText(e.text); break;
      case "tool_call": e.args = this.redactDeep(e.args === undefined ? null : e.args); break;   // JSON drops undefined; the schema requires the key
      case "tool_result": e.summary = this.redactText(e.summary); break;
      case "file_edit": e.path = this.redactText(e.path); e.diff = this.redactText(e.diff); break;
      case "error": e.message = this.redactText(e.message); break;
      case "test_output": e.command = this.redactText(e.command); e.tail = this.redactText(e.tail); break;
      case "receipt": e.receipt = this.redactReceipt(e.receipt); break;
      default: break;
    }
    return e;
  }

  /** Redacts string values and object keys, at any depth. */
  private redactDeep(value: unknown): unknown {
    if (typeof value === "string") return this.redactText(value);
    if (Array.isArray(value)) return value.map(v => this.redactDeep(v));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [this.redactText(k), this.redactDeep(v)]));
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
