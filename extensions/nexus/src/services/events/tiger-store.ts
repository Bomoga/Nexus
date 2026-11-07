// TigerStore: the shared team EventStore over Tiger Cloud (Postgres + TimescaleDB), columns exactly as sql/001_schema.sql.
// It talks to an injected minimal pg-like client, so unit tests need no network. Production builds the client with
// createTigerPool(), which refuses a connection string that would not use TLS.
//
// Rules: parameterised SQL only (values never reach the SQL text); free text is redacted before it is written (the same
// fields LocalStore redacts); event, agent-event and receipt writes are INSERT ... ON CONFLICT DO NOTHING so the same
// record from two machines is one row; sessions, tasks, reviews and plans are upserts; an approval's decision is only ever
// set by the conditional UPDATE in decideApproval, so the first answer wins. Rows that do not parse against the contract
// schemas are skipped and counted (skippedRows()).
// Live remote changes (LISTEN/NOTIFY) are not here: subscriptions only report this store's own writes.
import {
  AgentEvent as AgentEventSchema, AgentSession as AgentSessionSchema, ApprovalRequest as ApprovalRequestSchema,
  ModelCallReceipt as ReceiptSchema, NexusEvent as NexusEventSchema, SwarmReview as SwarmReviewSchema,
  Task as TaskSchema, TaskPlan as TaskPlanSchema,
} from "../../contracts";
import type {
  AgentEvent, AgentSession, ApprovalRequest, DecidedBy, EventQuery, EventSearchHit, ModelCallReceipt,
  NexusEvent, SwarmReview, Task, TaskPlan,
} from "../../contracts";
import { Pool } from "pg";
import type { z } from "zod";
import type { DecideResult, EventStore, StatusEvent, StoreStatus, Unsubscribe } from "./store";

/** The part of pg.Pool / pg.Client the store uses. */
export interface TigerClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end?(): Promise<void>;
}

export interface TigerStoreOptions {
  client: TigerClient;
  /** Applied to every free-text field before it is written. Required: there is no pass-through default. */
  redact: (text: string) => string;
  /** Fallback Auth0 user id for events written without one. */
  auth0UserId?: string;
}

// ---- SQL (one statement per operation; exported so tests can pin the text) ----
export const SQL = {
  insertEvent: `INSERT INTO events (id, at, kind, orbit, from_orbit, title, actor_name, actor_kind, target, workspace_id, machine_id, auth0_user_id)
VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
ON CONFLICT DO NOTHING`,
  insertAgentEvent: `INSERT INTO agent_events (session_id, seq, at, type, payload)
VALUES ($1, $2, $3::timestamptz, $4, $5::jsonb)
ON CONFLICT DO NOTHING`,
  insertReceipt: `INSERT INTO model_call_receipts (call_id, at, session_id, role, requested_model, served_model, cost_usd, baseline_cost_usd, optimizations, prune_receipt_id)
VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
ON CONFLICT DO NOTHING`,
  upsertTask: `INSERT INTO tasks (id, title, brief, source, workspace_id, status, session_id, created_at, code_refs, created_by)
VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::timestamptz, $9::jsonb, $10::jsonb)
ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, brief = EXCLUDED.brief, source = EXCLUDED.source,
  workspace_id = EXCLUDED.workspace_id, status = EXCLUDED.status, session_id = EXCLUDED.session_id,
  created_at = EXCLUDED.created_at, code_refs = EXCLUDED.code_refs, created_by = EXCLUDED.created_by`,
  upsertSession: `INSERT INTO sessions (id, task_id, model_provider, model_id, branch, worktree_path, base_commit, status, started_at, ended_at, machine_id, optimizer, slack_progress)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11, $12::jsonb, $13::jsonb)
ON CONFLICT (id) DO UPDATE SET task_id = EXCLUDED.task_id, model_provider = EXCLUDED.model_provider, model_id = EXCLUDED.model_id,
  branch = EXCLUDED.branch, worktree_path = EXCLUDED.worktree_path, base_commit = EXCLUDED.base_commit, status = EXCLUDED.status,
  started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at, machine_id = EXCLUDED.machine_id,
  optimizer = EXCLUDED.optimizer, slack_progress = EXCLUDED.slack_progress`,
  // Non-decision fields only; decision, decided_by and decided_at are never touched here. Once decided, what the human
  // saw and decided on (session, action, reason, request time, diff preview) is frozen; the Slack message and CIBA id may
  // still be filled in afterwards (the Slack message is often posted around the decision).
  upsertApproval: `INSERT INTO approvals (id, session_id, action, reason, requested_at, slack_message, ciba_auth_req_id, diff_preview)
VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz, $6::jsonb, $7, $8)
ON CONFLICT (id) DO UPDATE SET
  session_id = CASE WHEN approvals.decision IS NULL THEN EXCLUDED.session_id ELSE approvals.session_id END,
  action = CASE WHEN approvals.decision IS NULL THEN EXCLUDED.action ELSE approvals.action END,
  reason = CASE WHEN approvals.decision IS NULL THEN EXCLUDED.reason ELSE approvals.reason END,
  requested_at = CASE WHEN approvals.decision IS NULL THEN EXCLUDED.requested_at ELSE approvals.requested_at END,
  diff_preview = CASE WHEN approvals.decision IS NULL THEN COALESCE(EXCLUDED.diff_preview, approvals.diff_preview) ELSE approvals.diff_preview END,
  slack_message = COALESCE(EXCLUDED.slack_message, approvals.slack_message),
  ciba_auth_req_id = COALESCE(EXCLUDED.ciba_auth_req_id, approvals.ciba_auth_req_id)`,
  decideApproval: `UPDATE approvals SET decision = $2, decided_by = $3::jsonb, decided_at = $4::timestamptz
WHERE id = $1 AND decision IS NULL
RETURNING *`,
  upsertReview: `INSERT INTO swarm_reviews (id, session_id, approval_id, swarm_type, status, verdict, summary, judges, at, duration_ms, data_left_machine)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $10, $11)
ON CONFLICT (id) DO UPDATE SET session_id = EXCLUDED.session_id, approval_id = EXCLUDED.approval_id, swarm_type = EXCLUDED.swarm_type,
  status = EXCLUDED.status, verdict = EXCLUDED.verdict, summary = EXCLUDED.summary, judges = EXCLUDED.judges,
  at = EXCLUDED.at, duration_ms = EXCLUDED.duration_ms, data_left_machine = EXCLUDED.data_left_machine`,
  upsertPlan: `INSERT INTO task_plans (id, source_task_id, swarm_type, status, subtasks, created_task_ids, at)
VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::timestamptz)
ON CONFLICT (id) DO UPDATE SET source_task_id = EXCLUDED.source_task_id, swarm_type = EXCLUDED.swarm_type, status = EXCLUDED.status,
  subtasks = EXCLUDED.subtasks, created_task_ids = EXCLUDED.created_task_ids, at = EXCLUDED.at`,
  selectTask: `SELECT * FROM tasks WHERE id = $1`,
  listTasks: `SELECT * FROM tasks ORDER BY created_at, id`,
  selectSession: `SELECT * FROM sessions WHERE id = $1`,
  listSessions: `SELECT * FROM sessions ORDER BY started_at, id`,
  // One row per seq (two machines may have written the same event with different timestamps); the earliest wins.
  agentEvents: `SELECT DISTINCT ON (seq) * FROM agent_events WHERE session_id = $1 AND seq >= $2 ORDER BY seq, at`,
  selectApproval: `SELECT * FROM approvals WHERE id = $1`,
  listApprovals: `SELECT * FROM approvals ORDER BY requested_at, id`,
  reviewForApproval: `SELECT * FROM swarm_reviews WHERE approval_id = $1 ORDER BY at DESC LIMIT 1`,
  listReceipts: `SELECT * FROM model_call_receipts WHERE ($1::text IS NULL OR session_id = $1) ORDER BY at, call_id`,
  selectPlan: `SELECT * FROM task_plans WHERE id = $1`,
  // Same ranking as the local index: title match 3, sha match 2, orbit or actor match 1; newest first within a score. "!" escapes LIKE wildcards.
  searchEvents: `SELECT *, CASE WHEN lower(title) LIKE $1 ESCAPE '!' THEN 3 WHEN lower(target->>'sha') LIKE $1 ESCAPE '!' THEN 2 ELSE 1 END AS score
FROM events
WHERE lower(title) LIKE $1 ESCAPE '!' OR lower(target->>'sha') LIKE $1 ESCAPE '!' OR lower(orbit || chr(10) || actor_name) LIKE $1 ESCAPE '!'
ORDER BY score DESC, at DESC
LIMIT $2`,
} as const;

/** The events-in-a-window query; the filters add parameters in a fixed order: from, to, [orbits], [kinds], limit. */
export function queryEventsSql(withOrbits: boolean, withKinds: boolean): string {
  let n = 2;
  const orbits = withOrbits ? ` AND orbit = ANY($${++n}::text[])` : "";
  const kinds = withKinds ? ` AND kind = ANY($${++n}::text[])` : "";
  return `SELECT * FROM events WHERE at >= $1::timestamptz AND at <= $2::timestamptz${orbits}${kinds} ORDER BY at, id LIMIT $${n + 1}`;
}

// ---- helpers ----
const clone = <T>(value: T): T => structuredClone(value);
const clampLimit = (limit: number | undefined, fallback: number) => Math.min(5000, Math.max(0, Math.floor(Number.isFinite(limit) ? (limit as number) : fallback)));

/**
 * True when an error means "the remote could not be reached or did not answer" (so the write stays queued and the store goes
 * offline), false when the remote answered and refused this particular record: data errors (22xxx), constraint violations
 * (23xxx), a row that does not parse, an unknown approval. Anything unrecognised counts as transient, so an odd failure
 * stalls the queue instead of silently dropping a write.
 */
export function isTransientError(err: unknown): boolean {
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  if (/^(22|23)/.test(code)) return false;
  if (err instanceof PermanentStoreError) return false;
  const message = typeof e.message === "string" ? e.message : "";
  return !/^unknown approval /.test(message);
}

/** A failure that retrying cannot fix (a row that does not parse, an approval that does not exist). */
export class PermanentStoreError extends Error {}
const json = (value: unknown): string | null => (value === undefined || value === null ? null : JSON.stringify(value));
const orNull = <T>(value: T | undefined): T | null => (value === undefined ? null : value);

/** timestamptz comes back from pg as a Date; contracts want an ISO string (always with milliseconds). */
function iso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

/** Drops undefined and null keys (a NULL column is an absent optional field). */
function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)) as T;
}

/** pg returns jsonb already parsed; tolerate a client that hands back text. */
function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

export class TigerStore implements EventStore {
  private readonly client: TigerClient;
  private readonly redactText: (text: string) => string;
  private readonly auth0UserId: string | undefined;
  private skipped = 0;
  private online = true;
  private eventListeners = new Set<(event: NexusEvent) => void>();
  private approvalListeners = new Set<(approval: ApprovalRequest) => void>();
  private statusListeners = new Set<(status: StatusEvent) => void>();

  constructor(opts: TigerStoreOptions) {
    this.client = opts.client;
    this.redactText = opts.redact;
    this.auth0UserId = opts.auth0UserId;
  }

  /** How many rows were dropped because they did not parse against their contract schema. */
  skippedRows(): number { return this.skipped; }

  /** Closes the underlying pool, if the client has one. */
  async close(): Promise<void> { await this.client.end?.(); }

  // ---- tasks ----
  async putTask(task: Task) {
    const t = clone(task);
    t.title = this.redactText(t.title);
    t.brief = this.redactText(t.brief);
    await this.run(SQL.upsertTask, [t.id, t.title, t.brief, json(t.source), t.workspaceId, t.status, orNull(t.sessionId), t.createdAt, json(t.codeRefs ?? []), json(t.createdBy)]);
  }
  async getTask(id: string) { return (await this.rowsOf(SQL.selectTask, [id], r => this.taskOf(r)))[0]; }
  async listTasks() { return this.rowsOf(SQL.listTasks, [], r => this.taskOf(r)); }

  // ---- sessions ----
  async putSession(session: AgentSession) {
    const s = clone(session);
    await this.run(SQL.upsertSession, [s.id, s.taskId, s.model.provider, s.model.modelId, s.branch, s.worktreePath, s.baseCommit, s.status, s.startedAt, orNull(s.endedAt), s.machineId, json(s.optimizer), json(s.slackProgress)]);
  }
  async getSession(id: string) { return (await this.rowsOf(SQL.selectSession, [id], r => this.sessionOf(r)))[0]; }
  async listSessions() { return this.rowsOf(SQL.listSessions, [], r => this.sessionOf(r)); }

  // ---- agent events ----
  async appendAgentEvent(event: AgentEvent) {
    const e = this.redactAgentEvent(clone(event));
    const { sessionId, seq, at, type, ...payload } = e;
    await this.run(SQL.insertAgentEvent, [sessionId, seq, at, type, json(payload)]);
  }
  async agentEvents(sessionId: string, fromSeq: number) { return this.rowsOf(SQL.agentEvents, [sessionId, fromSeq], r => this.agentEventOf(r)); }

  // ---- approvals ----
  /** Creates or updates the non-decision fields. Decision fields on the input are ignored: only decideApproval sets them. */
  async putApproval(approval: ApprovalRequest) {
    const a = this.redactApproval(clone(approval));
    await this.run(SQL.upsertApproval, [a.id, a.sessionId, json(a.action), a.reason, a.requestedAt, json(a.slackMessage), orNull(a.cibaAuthReqId), orNull(a.diffPreview)]);
  }
  async getApproval(id: string) { return (await this.rowsOf(SQL.selectApproval, [id], r => this.approvalOf(r)))[0]; }
  async listApprovals() { return this.rowsOf(SQL.listApprovals, [], r => this.approvalOf(r)); }

  /** First answer wins: the conditional UPDATE sets the decision only while undecided; otherwise the existing winner is returned. */
  async decideApproval(id: string, decision: "approved" | "rejected", decidedBy: DecidedBy, at: string): Promise<DecideResult> {
    const res = await this.run(SQL.decideApproval, [id, decision, json(decidedBy), at]);
    if (res.rowCount === 1) {
      const approval = this.approvalOf(res.rows[0]);
      if (!approval) throw new PermanentStoreError(`approval ${id} was decided but its row does not parse`);
      this.emitApproval(approval);
      return { approval, won: true };
    }
    const winner = await this.getApproval(id);
    if (!winner) throw new PermanentStoreError(`unknown approval ${id}`);
    return { approval: winner, won: false };
  }

  // ---- events ----
  async putNexusEvent(event: NexusEvent) {
    const e = clone(event);
    e.title = this.redactText(e.title);
    const res = await this.run(SQL.insertEvent, [e.id, e.at, e.kind, e.orbit, orNull(e.fromOrbit), e.title, e.actor.name, e.actor.kind, json(e.target), e.workspaceId, e.machineId, orNull(e.auth0UserId ?? this.auth0UserId)]);
    if (res.rowCount === 1) for (const l of [...this.eventListeners]) safely(() => l(clone(e)));
  }

  // ---- reviews, receipts, plans ----
  async putReview(review: SwarmReview) {
    const r = clone(review);
    if (r.summary !== undefined) r.summary = this.redactText(r.summary);
    if (r.judges) r.judges = r.judges.map(j => ({ ...j, notes: this.redactText(j.notes) }));
    await this.run(SQL.upsertReview, [r.id, r.sessionId, r.approvalId, r.swarmType, r.status, orNull(r.verdict), orNull(r.summary), json(r.judges), r.at, orNull(r.durationMs), true]);
  }
  async getReviewForApproval(approvalId: string) { return (await this.rowsOf(SQL.reviewForApproval, [approvalId], r => this.reviewOf(r)))[0]; }

  async putReceipt(receipt: ModelCallReceipt) {
    const r = clone(receipt);
    r.optimizations = r.optimizations.map(o => this.redactText(o));
    await this.run(SQL.insertReceipt, [r.callId, r.at, orNull(r.sessionId), r.role, r.requestedModel, r.servedModel, r.costUsd, orNull(r.baselineCostUsd), json(r.optimizations), r.pruneReceiptId]);
  }
  async listReceipts(sessionId?: string) { return this.rowsOf(SQL.listReceipts, [orNull(sessionId)], r => this.receiptOf(r)); }

  async putPlan(plan: TaskPlan) {
    const p = clone(plan);
    p.subtasks = p.subtasks.map(s => ({ ...s, title: this.redactText(s.title), brief: this.redactText(s.brief) }));
    await this.run(SQL.upsertPlan, [p.id, p.sourceTaskId, p.swarmType, p.status, json(p.subtasks), json(p.createdTaskIds), p.at]);
  }
  async getPlan(id: string) { return (await this.rowsOf(SQL.selectPlan, [id], r => this.planOf(r)))[0]; }

  // ---- read side ----
  async queryEvents(query: EventQuery) {
    if (!Number.isFinite(Date.parse(query.from)) || !Number.isFinite(Date.parse(query.to))) return [];
    const params: unknown[] = [query.from, query.to];
    if (query.orbits) params.push(query.orbits);
    if (query.kinds) params.push(query.kinds);
    params.push(clampLimit(query.limit, 2000));
    return this.rowsOf(queryEventsSql(!!query.orbits, !!query.kinds), params, r => this.eventOf(r));
  }

  async searchEvents(text: string, limit: number): Promise<EventSearchHit[]> {
    const q = text.trim().toLowerCase();
    if (!q || !(limit > 0)) return [];
    const pattern = `%${q.replace(/[!%_]/g, "!$&")}%`;
    const res = await this.run(SQL.searchEvents, [pattern, clampLimit(limit, 20)]);
    const hits: EventSearchHit[] = [];
    for (const row of res.rows) {
      const event = this.eventOf(row);
      if (event) hits.push({ event, score: Number(row.score) });
    }
    return hits;
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
  /** Reachability as of the last query; this store queues nothing, so outboxDepth is always 0. */
  async status(): Promise<StoreStatus> { return { online: this.online, outboxDepth: 0 }; }

  // ---- plumbing ----
  private async run(text: string, params: unknown[]) {
    try {
      const res = await this.client.query(text, params);
      this.setOnline(true);
      return res;
    } catch (err) {
      if (isTransientError(err)) this.setOnline(false);   // a SQL error means the database answered
      throw err;
    }
  }

  private setOnline(online: boolean) {
    if (this.online === online) return;
    this.online = online;
    for (const l of [...this.statusListeners]) safely(() => l({ online, outboxDepth: 0 }));
  }

  private async rowsOf<T>(text: string, params: unknown[], map: (row: Record<string, unknown>) => T | undefined): Promise<T[]> {
    const res = await this.run(text, params);
    const out: T[] = [];
    for (const row of res.rows) {
      const v = map(row);
      if (v !== undefined) out.push(v);
    }
    return out;
  }

  private emitApproval(approval: ApprovalRequest) {
    for (const l of [...this.approvalListeners]) safely(() => l(clone(approval)));
  }

  /** Validates a mapped row against its schema; a failure is counted and the row skipped. */
  private check<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> | undefined {
    const result = schema.safeParse(value);
    if (!result.success) { this.skipped++; return undefined; }
    return result.data;
  }

  // ---- row mappers ----
  private taskOf(r: Record<string, unknown>): Task | undefined {
    return this.check(TaskSchema, compact({
      id: r.id, title: r.title, brief: r.brief, source: parsed(r.source), workspaceId: r.workspace_id, status: r.status,
      sessionId: r.session_id, createdAt: iso(r.created_at), codeRefs: parsed(r.code_refs), createdBy: parsed(r.created_by),
    }));
  }
  private sessionOf(r: Record<string, unknown>): AgentSession | undefined {
    return this.check(AgentSessionSchema, compact({
      id: r.id, taskId: r.task_id, model: { provider: r.model_provider, modelId: r.model_id }, branch: r.branch,
      worktreePath: r.worktree_path, baseCommit: r.base_commit, status: r.status, startedAt: iso(r.started_at),
      endedAt: iso(r.ended_at), machineId: r.machine_id, optimizer: parsed(r.optimizer), slackProgress: parsed(r.slack_progress),
    }));
  }
  private agentEventOf(r: Record<string, unknown>): AgentEvent | undefined {
    const payload = parsed(r.payload);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) { this.skipped++; return undefined; }
    return this.check(AgentEventSchema, { ...payload, sessionId: r.session_id, seq: r.seq, at: iso(r.at), type: r.type });
  }
  private approvalOf(r: Record<string, unknown>): ApprovalRequest | undefined {
    return this.check(ApprovalRequestSchema, compact({
      id: r.id, sessionId: r.session_id, action: parsed(r.action), reason: r.reason, requestedAt: iso(r.requested_at),
      decision: r.decision, decidedBy: parsed(r.decided_by), decidedAt: iso(r.decided_at), slackMessage: parsed(r.slack_message),
      cibaAuthReqId: r.ciba_auth_req_id, diffPreview: r.diff_preview,
    }));
  }
  private eventOf(r: Record<string, unknown>): NexusEvent | undefined {
    return this.check(NexusEventSchema, compact({
      id: r.id, kind: r.kind, at: iso(r.at), orbit: r.orbit, fromOrbit: r.from_orbit, title: r.title,
      actor: { name: r.actor_name, kind: r.actor_kind }, target: parsed(r.target), workspaceId: r.workspace_id,
      machineId: r.machine_id, auth0UserId: r.auth0_user_id,
    }));
  }
  private reviewOf(r: Record<string, unknown>): SwarmReview | undefined {
    return this.check(SwarmReviewSchema, compact({
      id: r.id, sessionId: r.session_id, approvalId: r.approval_id, swarmType: r.swarm_type, status: r.status, verdict: r.verdict,
      summary: r.summary, judges: parsed(r.judges), at: iso(r.at), durationMs: r.duration_ms,
    }));
  }
  private receiptOf(r: Record<string, unknown>): ModelCallReceipt | undefined {
    return this.check(ReceiptSchema, compact({
      callId: r.call_id, sessionId: r.session_id, role: r.role, requestedModel: r.requested_model, servedModel: r.served_model,
      costUsd: Number(r.cost_usd), baselineCostUsd: r.baseline_cost_usd === null || r.baseline_cost_usd === undefined ? undefined : Number(r.baseline_cost_usd),
      optimizations: parsed(r.optimizations), pruneReceiptId: r.prune_receipt_id, at: iso(r.at),
    }));
  }
  private planOf(r: Record<string, unknown>): TaskPlan | undefined {
    return this.check(TaskPlanSchema, compact({
      id: r.id, sourceTaskId: r.source_task_id, swarmType: r.swarm_type, status: r.status, subtasks: parsed(r.subtasks),
      createdTaskIds: parsed(r.created_task_ids), at: iso(r.at),
    }));
  }

  // ---- redaction of free text (the same fields LocalStore redacts) ----
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
      case "tool_call": e.args = this.redactDeep(e.args === undefined ? null : e.args); break;   // jsonb has no undefined; the schema needs the key
      case "tool_result": e.summary = this.redactText(e.summary); break;
      case "file_edit": e.path = this.redactText(e.path); e.diff = this.redactText(e.diff); break;
      case "error": e.message = this.redactText(e.message); break;
      case "test_output": e.command = this.redactText(e.command); e.tail = this.redactText(e.tail); break;
      case "receipt": e.receipt = { ...e.receipt, optimizations: e.receipt.optimizations.map(o => this.redactText(o)) }; break;
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
}

function safely(fn: () => void) {
  try { fn(); } catch { /* one throwing subscriber cannot break a write */ }
}

// ---- production client ----
/** The pg.Pool constructor shape createTigerPool needs (injectable for tests). */
export type PoolConstructor = new (config: {
  connectionString: string; ssl: { rejectUnauthorized: boolean }; max: number; connectionTimeoutMillis: number; idleTimeoutMillis: number; query_timeout: number; keepAlive: boolean;
}) => TigerClient & { on(event: "error", listener: (err: Error) => void): unknown };

/**
 * Builds the production client: a pg.Pool that always uses TLS with certificate verification. A connection string that asks for
 * no TLS, or weaker TLS, is refused. The error never contains the connection string.
 */
export function createTigerPool(connectionString: string, PoolCtor: PoolConstructor = Pool as unknown as PoolConstructor): TigerClient {
  let url: URL;
  try { url = new URL(connectionString); } catch { throw new Error("the Tiger Cloud connection string is not a valid postgres URL"); }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("the Tiger Cloud connection string must be a postgres:// URL");
  const mode = url.searchParams.get("sslmode");
  if (mode !== null && !["require", "verify-ca", "verify-full"].includes(mode)) throw new Error("the Tiger Cloud connection string must use TLS (sslmode=require or stronger)");
  const ssl = url.searchParams.get("ssl");
  if (ssl !== null && ["false", "0", "off", "no"].includes(ssl.toLowerCase())) throw new Error("the Tiger Cloud connection string must use TLS");
  // pg lets URL parameters override the ssl option, so TLS settings are removed here and set explicitly below.
  for (const key of ["sslmode", "ssl", "uselibpqcompat", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(key);
  const pool = new PoolCtor({ connectionString: url.toString(), ssl: { rejectUnauthorized: true }, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, query_timeout: 10_000, keepAlive: true });
  pool.on("error", () => { /* an idle connection dropped: the next query reconnects; unhandled, this would crash the extension host */ });
  return pool;
}
