// Cross-machine live sync (L2-11): pulls what OTHER machines wrote to the shared Tiger Cloud store into this machine's local
// store, which publishes it on its subscriptions (events.subscribe, approvals, agent.subscribe replay from seq).
//
// Two triggers feed one pipeline: NOTIFY on channel "nexus" (sql/003_notify.sql; ids only) fetches the named rows by key, and a
// poll (`WHERE updated_at > $since`, with an overlap window) catches everything else. When LISTEN is absent or fails, polling
// runs every pollMs; while LISTEN is healthy a slow reconcile poll still runs as a safety net. All work is serialised.
//
// Rules: parameterised SQL only; rows written by this machine are skipped; agent events are applied in seq order with gaps
// filled from the remote first; a remote approval decision lands only on a still-undecided local approval (a different local
// decision is never overwritten here); rows that do not parse are skipped and counted; row contents and the connection string
// are never logged. After an outage the outbox is flushed before anything is pulled.
import { isDeepStrictEqual } from "node:util";
import {
  AgentEvent as AgentEventSchema, AgentSession as AgentSessionSchema, ApprovalRequest as ApprovalRequestSchema,
  ModelCallReceipt as ReceiptSchema, NexusEvent as NexusEventSchema, SwarmReview as SwarmReviewSchema,
  Task as TaskSchema, TaskPlan as TaskPlanSchema,
} from "../../contracts";
import type { AgentEvent, ApprovalRequest, DecidedBy } from "../../contracts";
import type { OutboxEntry } from "./local-store";
import type { EventStore } from "./store";

type Row = Record<string, unknown>;

/** The part of a pg client the sync uses. */
export interface SyncClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/** The local store plus its (optional) outbox, which LocalStore has. With it, the sync acks the writes it makes itself. */
export type SyncLocal = EventStore & {
  pendingOutbox?(): OutboxEntry[];
  ackOutbox?(ids: number[], at: string): void;
  /** Sets a decision whatever the local copy says (LocalStore). Used on machines that do not own the session. */
  mirrorDecision?(id: string, decision: "approved" | "rejected", decidedBy: DecidedBy, at: string): Promise<ApprovalRequest | undefined>;
};

/** Opens one dedicated LISTEN connection. `onClose` fires if it later drops. Resolves to an unsubscribe. */
export type ListenFn = (channel: string, onPayload: (payload: string) => void, onClose?: (err?: unknown) => void) => Promise<() => Promise<void>>;

export interface SyncTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SyncDeps {
  client: SyncClient;
  listen?: ListenFn;
  local: SyncLocal;
  machineId: string;
  flushOutbox(): Promise<unknown>;
  setOnline?(online: boolean): void;
  timers?: SyncTimers;
  now?: () => number;
  log?: (message: string) => void;
  /** Poll interval while LISTEN is not working. Default 2000. */
  pollMs?: number;
  /** Safety-net poll interval while LISTEN works. Default 30000. */
  reconcileMs?: number;
  /** Re-read this much before the cursor so a row committed in the same millisecond is not missed. Default 5000. */
  overlapMs?: number;
  /** How long an agent event with a gap before it waits for the missing rows (and at least 3 range fetches must confirm the hole) before it is applied anyway. Default 60000. */
  holdMs?: number;
  /** Where the first pull starts (ISO). Default: the beginning of time. */
  since?: string;
  batchSize?: number;
}

export interface SyncStats { applied: number; skippedRows: number; notifications: number; pulls: number; gapFetches: number }

export interface Sync {
  /** Starts LISTEN (if any) and the first pull. Resolves when that first pull has finished (it never rejects). */
  start(): Promise<void>;
  /** Ends LISTEN, clears timers, waits for work in flight. Nothing is scheduled afterwards. */
  stop(): Promise<void>;
  /** One pull of every table now (serialised with everything else). Rejects only on a remote failure. */
  pullNow(): Promise<void>;
  stats(): SyncStats;
}

// ---- SQL (exported so tests and the fake remote can recognise statements) ----
type TableName = "tasks" | "sessions" | "events" | "approvals" | "agent_events" | "swarm_reviews" | "model_call_receipts" | "task_plans";

/** Pull order: parents before children. */
export const SYNC_TABLES: readonly TableName[] = ["tasks", "sessions", "events", "approvals", "agent_events", "swarm_reviews", "model_call_receipts", "task_plans"];
const KEY_COLUMN: Record<TableName, string> = {
  tasks: "id", sessions: "id", events: "id", approvals: "id", agent_events: "session_id, seq", swarm_reviews: "id", model_call_receipts: "call_id", task_plans: "id",
};
const SINGLE_KEY: Partial<Record<TableName, string>> = {
  tasks: "id", sessions: "id", events: "id", approvals: "id", swarm_reviews: "id", model_call_receipts: "call_id", task_plans: "id",
};
const OUTBOX_TABLE: Record<TableName, OutboxEntry["table"]> = {
  tasks: "tasks", sessions: "sessions", events: "events", approvals: "approvals", agent_events: "agent_events",
  swarm_reviews: "reviews", model_call_receipts: "receipts", task_plans: "plans",
};

/** updated_at in whole milliseconds (what JavaScript can hold); the cursor and the keyset tuple use it, so there is no rounding gap. */
const MS = "floor(extract(epoch from updated_at) * 1000)::bigint";
const FROM_MS = "to_timestamp(($1::bigint / 1000.0)::double precision)";

export const SYNC_SQL = {
  /** Table names come from the fixed list above, never from input. */
  poll: (table: TableName) => `SELECT *, ${MS} AS sync_ms FROM ${table} WHERE updated_at > ${FROM_MS} ORDER BY sync_ms, ${KEY_COLUMN[table]} LIMIT $2`,
  /** Keyset page: strictly after the (millisecond, key) tuple of the previous page's last row, so a full page of rows with one timestamp still advances. */
  pollAfter: (table: TableName) => {
    const keys = table === "agent_events" ? ["session_id", "seq"] : [SINGLE_KEY[table]!];
    const params = keys.map((_, i) => (table === "agent_events" && i === 1 ? `$${i + 2}::int` : `$${i + 2}::text`)).join(", ");
    return `SELECT *, ${MS} AS sync_ms FROM ${table} WHERE updated_at >= ${FROM_MS} AND (${MS}, ${keys.join(", ")}) > ($1::bigint, ${params}) ORDER BY sync_ms, ${KEY_COLUMN[table]} LIMIT $${keys.length + 2}`;
  },
  byKey: (table: TableName) => `SELECT * FROM ${table} WHERE ${SINGLE_KEY[table]} = $1`,
  /** One row per seq (two machines may have written the same event); the earliest wins. */
  agentFrom: `SELECT DISTINCT ON (seq) * FROM agent_events WHERE session_id = $1 AND seq >= $2 ORDER BY seq, at LIMIT $3`,
  agentRange: `SELECT DISTINCT ON (seq) * FROM agent_events WHERE session_id = $1 AND seq >= $2 AND seq < $3 ORDER BY seq, at`,
  probe: `SELECT 1`,
} as const;


class RemoteError extends Error {
  constructor(readonly original: unknown) { super("remote query failed"); }
}

const defaultTimers: SyncTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>) };

// ---- row helpers ----
function iso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}
/** A pulled row's updated_at in ms (sync_ms from the poll SQL when present). */
function updatedMs(r: Row): number {
  if (r.sync_ms !== undefined && r.sync_ms !== null) { const n = Number(r.sync_ms); if (Number.isFinite(n)) return n; }
  return epoch(r.updated_at);
}
function epoch(value: unknown): number {
  const d = value instanceof Date ? value : new Date(String(value));
  const t = d.getTime();
  return Number.isNaN(t) ? 0 : t;
}
function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)) as T;
}
function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}
const errorCode = (err: unknown): string => {
  const e = (err ?? {}) as { code?: unknown; name?: unknown };
  return typeof e.code === "string" ? e.code : typeof e.name === "string" ? e.name : "error";
};

/** The identity of a row inside its table (the same form the outbox uses). */
function rowKey(table: TableName, r: Row): string {
  if (table === "agent_events") return `${String(r.session_id)}:${String(r.seq)}`;
  if (table === "model_call_receipts") return String(r.call_id);
  return String(r.id);
}

interface NotifyPayload { table: TableName; id: string; sessionId?: string }

function parseNotify(payload: string): NotifyPayload | undefined {
  let v: unknown;
  try { v = JSON.parse(payload); } catch { return undefined; }
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.table !== "string" || !(SYNC_TABLES as readonly string[]).includes(o.table) || typeof o.id !== "string" || !o.id) return undefined;
  return { table: o.table as TableName, id: o.id, sessionId: typeof o.session_id === "string" && o.session_id ? o.session_id : undefined };
}

export function createSync(deps: SyncDeps): Sync {
  const { client, local, machineId } = deps;
  const timers = deps.timers ?? defaultTimers;
  const now = deps.now ?? Date.now;
  const log = (m: string) => { try { deps.log?.(m); } catch { /* a logger must not break sync */ } };
  const pollMs = deps.pollMs ?? 2000;
  const reconcileMs = deps.reconcileMs ?? 30_000;
  const overlapMs = deps.overlapMs ?? 5000;
  const holdMs = deps.holdMs ?? 60_000;
  const MIN_HOLD_FETCHES = 3;
  const batch = deps.batchSize ?? 500;

  const stats: SyncStats = { applied: 0, skippedRows: 0, notifications: 0, pulls: 0, gapFetches: 0 };
  const cursor = new Map<TableName, number>();
  const sinceMs = deps.since ? Math.max(0, epoch(deps.since)) : 0;
  for (const t of SYNC_TABLES) cursor.set(t, sinceMs);
  /** key -> updated_at already applied, so the overlap window does not re-apply a row. */
  const seen = new Map<string, number>();
  /** Agent events waiting for missing seqs below them. */
  const held = new Map<string, { rows: Row[]; since: number; fetches: number; pull: number }>();
  /** Agent events that never parse: handled (skipped) so later seqs are not treated as a gap behind them. */
  const badSeqs = new Map<string, Set<number>>();
  const loggedHoles = new Set<string>();
  const pendingAgentNotify = new Set<string>();
  let agentFlushQueued = false;
  const loggedConflicts = new Set<string>();

  let running = false;
  let degraded = false;
  let needFlush = true;
  let onlineReported: boolean | undefined;
  let backoff = 0;
  let pollTimer: unknown;
  let listenTimer: unknown;
  let listening = false;
  let unlisten: (() => Promise<void>) | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let generation = 0;   // bumps on stop() so a late listen() result is discarded

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const report = (online: boolean) => {
    if (onlineReported === online) return;
    onlineReported = online;
    try { deps.setOnline?.(online); } catch { /* ignore */ }
  };

  async function q(text: string, params: unknown[] = []): Promise<Row[]> {
    try { return (await client.query(text, params)).rows; } catch (err) { throw new RemoteError(err); }
  }

  // ---- local writes that must not echo back to the remote ----
  async function quiet(table: TableName, key: string, op: "put" | "decide", change: () => Promise<unknown>): Promise<void> {
    if (!local.pendingOutbox || !local.ackOutbox) { await change(); return; }
    const before = new Set(local.pendingOutbox().map(e => e.id));
    await change();
    // Exactly one entry: the first one this change created for the key. Another writer's entry for the same key must stay queued.
    const fresh = local.pendingOutbox()
      .filter(e => !before.has(e.id) && e.table === OUTBOX_TABLE[table] && e.op === op && outboxKey(e) === key)
      .sort((a, b) => a.id - b.id);
    if (fresh.length) local.ackOutbox([fresh[0].id], new Date(now()).toISOString());
  }
  function outboxKey(e: OutboxEntry): string {
    const r = (e.record ?? {}) as Record<string, unknown>;
    if (e.table === "agent_events") return `${String(r.sessionId)}:${String(r.seq)}`;
    if (e.table === "receipts") return String(r.callId);
    return String(r.id);
  }
  /** True when this machine has a write for the key that the remote has not confirmed yet (the local copy is newer). */
  function dirty(table: TableName, key: string): boolean {
    return !!local.pendingOutbox?.().some(e => e.table === OUTBOX_TABLE[table] && outboxKey(e) === key);
  }
  /** Keys with an unconfirmed local write right now; taken before a query so a flush that lands while the query runs cannot let a stale row through. */
  function dirtySnapshot(): Set<string> {
    const out = new Set<string>();
    for (const e of local.pendingOutbox?.() ?? []) out.add(`${e.table}:${outboxKey(e)}`);
    return out;
  }
  const usableId = (id: string | undefined): id is string => !!id && id.trim() !== "" && !/^somevalue/i.test(id.trim());
  /** True when this machine runs the session (it is the authority for its approvals). An unknown session is not owned. */
  async function ownsSession(sessionId: string): Promise<boolean> {
    const ses = await local.getSession(sessionId);
    return !!ses && usableId(ses.machineId) && usableId(machineId) && ses.machineId === machineId;
  }

  // ---- row -> contract ----
  function check<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, value: unknown): T | undefined {
    const r = schema.safeParse(value);
    if (!r.success) { stats.skippedRows++; return undefined; }
    return r.data;
  }
  const mappers = {
    tasks: (r: Row) => check(TaskSchema, compact({
      id: r.id, title: r.title, brief: r.brief, source: parsed(r.source), workspaceId: r.workspace_id, status: r.status,
      sessionId: r.session_id, createdAt: iso(r.created_at), codeRefs: parsed(r.code_refs), createdBy: parsed(r.created_by),
    })),
    sessions: (r: Row) => check(AgentSessionSchema, compact({
      id: r.id, taskId: r.task_id, model: { provider: r.model_provider, modelId: r.model_id }, branch: r.branch,
      worktreePath: r.worktree_path, baseCommit: r.base_commit, status: r.status, startedAt: iso(r.started_at),
      endedAt: iso(r.ended_at), machineId: r.machine_id, optimizer: parsed(r.optimizer), slackProgress: parsed(r.slack_progress),
    })),
    events: (r: Row) => check(NexusEventSchema, compact({
      id: r.id, kind: r.kind, at: iso(r.at), orbit: r.orbit, fromOrbit: r.from_orbit, title: r.title,
      actor: { name: r.actor_name, kind: r.actor_kind }, target: parsed(r.target), workspaceId: r.workspace_id,
      machineId: r.machine_id, auth0UserId: r.auth0_user_id,
    })),
    approvals: (r: Row) => check(ApprovalRequestSchema, compact({
      id: r.id, sessionId: r.session_id, action: parsed(r.action), reason: r.reason, requestedAt: iso(r.requested_at),
      decision: r.decision, decidedBy: parsed(r.decided_by), decidedAt: iso(r.decided_at), slackMessage: parsed(r.slack_message),
      cibaAuthReqId: r.ciba_auth_req_id, diffPreview: r.diff_preview,
    })),
    agent_events: (r: Row) => {
      const payload = parsed(r.payload);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) { stats.skippedRows++; return undefined; }
      return check(AgentEventSchema, { ...payload, sessionId: r.session_id, seq: r.seq, at: iso(r.at), type: r.type });
    },
    swarm_reviews: (r: Row) => check(SwarmReviewSchema, compact({
      id: r.id, sessionId: r.session_id, approvalId: r.approval_id, swarmType: r.swarm_type, status: r.status, verdict: r.verdict,
      summary: r.summary, judges: parsed(r.judges), at: iso(r.at), durationMs: r.duration_ms,
    })),
    model_call_receipts: (r: Row) => check(ReceiptSchema, compact({
      callId: r.call_id, sessionId: r.session_id, role: r.role, requestedModel: r.requested_model, servedModel: r.served_model,
      costUsd: Number(r.cost_usd), baselineCostUsd: r.baseline_cost_usd === null || r.baseline_cost_usd === undefined ? undefined : Number(r.baseline_cost_usd),
      optimizations: parsed(r.optimizations), pruneReceiptId: r.prune_receipt_id, at: iso(r.at),
    })),
    task_plans: (r: Row) => check(TaskPlanSchema, compact({
      id: r.id, sourceTaskId: r.source_task_id, swarmType: r.swarm_type, status: r.status, subtasks: parsed(r.subtasks),
      createdTaskIds: parsed(r.created_task_ids), at: iso(r.at),
    })),
  };

  // ---- applying rows ----
  async function applyApproval(a: ApprovalRequest): Promise<void> {
    const current = await local.getApproval(a.id);
    if (!current || !dirty("approvals", a.id)) {
      await quiet("approvals", a.id, "put", () => local.putApproval(a));   // decision fields are ignored by put
    }
    if (!a.decision || !a.decidedBy || !a.decidedAt) return;
    const cur = await local.getApproval(a.id);
    if (!cur) return;
    if (!cur.decision) {
      await quiet("approvals", a.id, "decide", () => local.decideApproval(a.id, a.decision!, a.decidedBy!, a.decidedAt!));
    } else if (cur.decision !== a.decision || cur.decidedBy?.userId !== a.decidedBy.userId || cur.decidedBy?.via !== a.decidedBy.via) {
      if (!(await ownsSession(a.sessionId)) && local.mirrorDecision) {
        await local.mirrorDecision(a.id, a.decision, a.decidedBy, a.decidedAt);   // the owner's agent acted on the shared decision
        stats.applied++;
      } else if (!loggedConflicts.has(a.id)) {
        loggedConflicts.add(a.id);
        log(`sync: approval ${a.id} was decided differently on another machine; this machine owns the session, so the local decision is kept`);
      }
    }
  }

  /**
   * The seqs this machine already has for a session, read from the local copy once and then kept up to date as events are
   * applied, so a NOTIFY never copies a long session's whole event log again.
   */
  const seqCache = new Map<string, { have: Set<number>; max: number }>();
  async function seqsOf(sessionId: string): Promise<{ have: Set<number>; max: number }> {
    let c = seqCache.get(sessionId);
    if (!c) {
      const have = new Set((await local.agentEvents(sessionId, 0)).map(e => e.seq));
      let max = -1;
      for (const n of have) if (n > max) max = n;
      c = seqCache.get(sessionId) ?? { have, max };   // another caller may have loaded it meanwhile
      seqCache.set(sessionId, c);
    }
    return c;
  }

  async function applyAgentRows(sessionId: string, rows: Row[]): Promise<void> {
    const known = await seqsOf(sessionId);
    const have = known.have;
    const bad = badSeqs.get(sessionId) ?? new Set<number>();
    badSeqs.set(sessionId, bad);
    for (const n of bad) have.add(n);
    let max = known.max;
    const bySeq = new Map<number, Row>();
    for (const r of rows) bySeq.set(Number(r.seq), r);
    const prev = held.get(sessionId);
    if (prev) for (const r of prev.rows) if (!bySeq.has(Number(r.seq))) bySeq.set(Number(r.seq), r);
    const ordered = [...bySeq.values()].sort((a, b) => Number(a.seq) - Number(b.seq));
    const heldSince = prev?.since ?? now();
    let fetches = prev?.fetches ?? 0;

    const apply = async (r: Row): Promise<void> => {
      const seq = Number(r.seq);
      if (have.has(seq)) return;
      const e = mappers.agent_events(r);
      if (!e) { bad.add(seq); have.add(seq); if (seq > max) { max = seq; known.max = Math.max(known.max, seq); } return; }   // counted once; never a gap behind it
      await quiet("agent_events", `${sessionId}:${seq}`, "put", () => local.appendAgentEvent(e as AgentEvent));
      have.add(seq);
      if (seq > max) { max = seq; known.max = Math.max(known.max, seq); }
      stats.applied++;
    };

    for (let i = 0; i < ordered.length; i++) {
      const r = ordered[i];
      const seq = Number(r.seq);
      if (have.has(seq)) continue;
      if (seq > max + 1 || (max === -1 && seq > 0)) {
        // A gap (or an unknown start): fetch what lies between before applying, so a replay never has holes.
        stats.gapFetches++;
        const from = max + 1;
        const fill = (await q(SYNC_SQL.agentRange, [sessionId, from, seq])).sort((a, b) => Number(a.seq) - Number(b.seq));
        const hadAny = max !== -1;
        for (const f of fill) await apply(f);
        // Every session's seq starts at 0 (the contracts' fixtures and the runtime both number from 0), so with nothing local
        // the run must still be contiguous from 0: a missing seq 0 is a hole like any other.
        const lo = hadAny ? from : 0;
        let hole = false;
        for (let n = lo; n < seq; n++) if (!have.has(n)) { hole = true; break; }
        if (hole) {
          fetches++;
          if (now() - heldSince < holdMs || fetches < MIN_HOLD_FETCHES) {
            held.set(sessionId, { rows: ordered.slice(i), since: heldSince, fetches, pull: stats.pulls });   // retried on the next pull
            return;
          }
          if (!loggedHoles.has(sessionId)) {
            loggedHoles.add(sessionId);
            log(`sync: session ${sessionId} is missing events below seq ${seq}; applying anyway`);
          }
        }
      }
      await apply(r);
    }
    held.delete(sessionId);
  }

  async function applyRows(table: TableName, rows: Row[], snap: Set<string>): Promise<void> {
    const agentBySession = new Map<string, Row[]>();
    for (const r of rows) {
      const updated = updatedMs(r);
      const key = `${table}:${rowKey(table, r)}`;
      if (seen.has(key) && seen.get(key)! >= updated) continue;
      if (table === "agent_events") {
        const sid = String(r.session_id);
        if (!agentBySession.has(sid)) agentBySession.set(sid, []);
        agentBySession.get(sid)!.push(r);
      } else {
        await applyOne(table, r, snap);
        seen.set(key, updated);
      }
    }
    // Marked seen only after the local append succeeded; a failure leaves the rows to be pulled again.
    for (const [sid, list] of agentBySession) {
      await applyAgentRows(sid, list);
      for (const r of list) seen.set(`agent_events:${rowKey("agent_events", r)}`, updatedMs(r));
    }
  }

  async function applyOne(table: TableName, r: Row, snap: Set<string>): Promise<void> {
    const stale = (t: TableName, key: string) => dirty(t, key) || snap.has(`${OUTBOX_TABLE[t]}:${key}`);
    switch (table) {
      case "events": {
        if (r.machine_id === machineId) return;
        const e = mappers.events(r);
        if (!e) return;
        await quiet("events", e.id, "put", () => local.putNexusEvent(e));
        stats.applied++;
        return;
      }
      case "sessions": {
        if (r.machine_id === machineId) return;
        const s = mappers.sessions(r);
        if (!s || stale("sessions", s.id)) return;
        const cur = await local.getSession(s.id);
        if (cur && isDeepStrictEqual(cur, s)) return;
        await quiet("sessions", s.id, "put", () => local.putSession(s));
        stats.applied++;
        return;
      }
      case "tasks": {
        const t = mappers.tasks(r);
        if (!t || stale("tasks", t.id)) return;
        const cur = await local.getTask(t.id);
        if (cur && isDeepStrictEqual(cur, t)) return;
        await quiet("tasks", t.id, "put", () => local.putTask(t));
        stats.applied++;
        return;
      }
      case "approvals": {
        const a = mappers.approvals(r);
        if (!a) return;
        await applyApproval(a);
        stats.applied++;
        return;
      }
      case "swarm_reviews": {
        const v = mappers.swarm_reviews(r);
        if (!v || stale("swarm_reviews", v.id)) return;
        const cur = await local.getReviewForApproval(v.approvalId);
        if (cur && cur.id === v.id && (isDeepStrictEqual(cur, v) || cur.at > v.at)) return;   // never regress to an older version
        await quiet("swarm_reviews", v.id, "put", () => local.putReview(v));
        stats.applied++;
        return;
      }
      case "model_call_receipts": {
        const v = mappers.model_call_receipts(r);
        if (!v) return;
        await quiet("model_call_receipts", v.callId, "put", () => local.putReceipt(v));
        stats.applied++;
        return;
      }
      case "task_plans": {
        const p = mappers.task_plans(r);
        if (!p || stale("task_plans", p.id)) return;
        const cur = await local.getPlan(p.id);
        if (cur && (isDeepStrictEqual(cur, p) || cur.at > p.at)) return;   // never regress to an older version
        await quiet("task_plans", p.id, "put", () => local.putPlan(p));
        stats.applied++;
        return;
      }
      case "agent_events": return;   // handled per session
    }
  }

  // ---- pulling ----
  async function pullTable(table: TableName): Promise<void> {
    // Keyset paging within a cycle: the overlap applies to the first page only; later pages continue after the previous
    // page's last (millisecond, key) tuple and stop only on a short page, so any number of rows with one timestamp are read.
    let after: { ms: number; keys: unknown[] } | undefined;
    for (;;) {
      const snap = dirtySnapshot();
      const rows = after
        ? await q(SYNC_SQL.pollAfter(table), [after.ms, ...after.keys, batch])
        : await q(SYNC_SQL.poll(table), [Math.max(0, cursor.get(table)! - overlapMs), batch]);
      await applyRows(table, rows, snap);
      if (rows.length) {
        const last = rows[rows.length - 1];
        after = { ms: updatedMs(last), keys: table === "agent_events" ? [String(last.session_id), Number(last.seq)] : [rowKey(table, last)] };
        if (after.ms > cursor.get(table)!) cursor.set(table, after.ms);
      }
      if (rows.length < batch) break;
    }
    trimSeen();
  }

  function trimSeen(): void {
    if (seen.size < 20_000) return;
    const floor = Math.min(...SYNC_TABLES.map(t => cursor.get(t)!)) - overlapMs * 2;
    for (const [k, v] of seen) if (v < floor) seen.delete(k);
  }

  async function retryHeld(): Promise<void> {
    for (const [sid, h] of [...held]) if (h.pull !== stats.pulls) await applyAgentRows(sid, []);   // not the ones this very cycle just held
  }

  /** The body of one cycle: recover if needed, then pull everything. Throws RemoteError on a remote failure. */
  async function cycle(): Promise<void> {
    stats.pulls++;
    if (degraded) await q(SYNC_SQL.probe);   // still down? throws before anything else
    if (needFlush) {
      try {
        const result = await deps.flushOutbox();
        const remaining = (result as { remaining?: unknown } | null | undefined)?.remaining;
        needFlush = typeof remaining === "number" && remaining > 0;   // still queued: try again next cycle
      } catch {
        log("sync: flushing the outbox failed; retrying next cycle");   // needFlush stays true
      }
    }
    for (const t of SYNC_TABLES) await pullTable(t);
    await retryHeld();
    if (degraded) log("sync: connection restored");
    degraded = false;
    backoff = 0;
    report(true);
  }

  function onFailure(err: unknown): void {
    if (err instanceof RemoteError) {
      if (!degraded) log(`sync: remote unreachable (${errorCode(err.original)}); polling with backoff`);
      degraded = true;
      needFlush = true;
      backoff = backoff ? Math.min(30_000, backoff * 2) : 2000;
      report(false);
    } else {
      log(`sync: could not apply remote rows (${errorCode(err)}); will retry`);
      backoff = backoff ? Math.min(30_000, backoff * 2) : 2000;
    }
  }

  async function runCycle(): Promise<void> {
    try { await cycle(); } catch (err) { onFailure(err); }
  }

  function schedulePoll(): void {
    if (!running) return;
    if (pollTimer !== undefined) timers.clearTimeout(pollTimer);
    const delay = backoff > 0 ? backoff : listening ? reconcileMs : pollMs;
    pollTimer = timers.setTimeout(() => {
      pollTimer = undefined;
      if (!running) return;
      void serial(runCycle).then(schedulePoll);
    }, delay);
  }

  // ---- NOTIFY ----
  async function handleNotify(n: NotifyPayload): Promise<void> {
    if (degraded) return;   // the next poll cycle recovers and pulls everything
    try {
      const snap = dirtySnapshot();
      const rows = await q(SYNC_SQL.byKey(n.table as Exclude<TableName, "agent_events">), [n.id]);
      await applyRows(n.table, rows, snap);
    } catch (err) {
      onFailure(err);
      schedulePoll();
    }
  }

  /** One fetch per session per tick, however many NOTIFYs arrived; sessions this machine runs are already local. */
  async function syncSession(sid: string): Promise<void> {
    if (await ownsSession(sid)) return;
    let from = (await seqsOf(sid)).max + 1;
    for (;;) {
      const rows = await q(SYNC_SQL.agentFrom, [sid, from, batch]);
      if (rows.length) await applyAgentRows(sid, rows);
      if (rows.length < batch) break;
      from = Number(rows[rows.length - 1].seq) + 1;
    }
  }

  function queueAgentNotify(sid: string): void {
    pendingAgentNotify.add(sid);
    if (agentFlushQueued) return;
    agentFlushQueued = true;
    void serial(async () => {
      agentFlushQueued = false;
      const sids = [...pendingAgentNotify];
      pendingAgentNotify.clear();
      if (degraded || !running) return;
      try {
        for (const sid of sids) await syncSession(sid);
      } catch (err) {
        onFailure(err);
        schedulePoll();
      }
    });
  }

  function onPayload(payload: string): void {
    const n = parseNotify(payload);
    if (!n || !running) return;
    stats.notifications++;
    if (n.table === "agent_events") {
      const sid = n.sessionId ?? n.id.slice(0, Math.max(0, n.id.lastIndexOf(":")));
      if (sid) queueAgentNotify(sid);
      return;
    }
    void serial(() => handleNotify(n));
  }

  async function connectListen(catchUp: boolean): Promise<void> {
    if (!deps.listen || !running || listening) return;
    const gen = generation;
    try {
      const off = await deps.listen("nexus", onPayload, () => {
        if (gen !== generation) return;
        listening = false;
        unlisten = undefined;
        log("sync: LISTEN connection dropped; polling");
        scheduleListenRetry();
        schedulePoll();
      });
      if (!running || gen !== generation) { await off().catch(() => undefined); return; }
      unlisten = off;
      listening = true;
      if (catchUp) void serial(runCycle).then(schedulePoll);   // anything missed while not listening
    } catch (err) {
      listening = false;
      log(`sync: LISTEN unavailable (${errorCode(err)}); polling every ${pollMs} ms`);
      scheduleListenRetry();
    }
  }

  let listenBackoff = 0;
  function scheduleListenRetry(): void {
    if (!running || !deps.listen || listenTimer !== undefined) return;
    listenBackoff = listenBackoff ? Math.min(30_000, listenBackoff * 2) : 2000;
    listenTimer = timers.setTimeout(() => {
      listenTimer = undefined;
      void connectListen(true);
    }, listenBackoff);
  }

  return {
    async start() {
      if (running) return;
      running = true;
      generation++;
      await connectListen(false);
      await serial(runCycle);
      schedulePoll();
    },
    async stop() {
      running = false;
      generation++;
      if (pollTimer !== undefined) { timers.clearTimeout(pollTimer); pollTimer = undefined; }
      if (listenTimer !== undefined) { timers.clearTimeout(listenTimer); listenTimer = undefined; }
      const off = unlisten;
      unlisten = undefined;
      listening = false;
      if (off) await off().catch(() => undefined);
      await chain;
      // a cycle that finished during the wait may have scheduled again; make sure nothing is left
      if (pollTimer !== undefined) { timers.clearTimeout(pollTimer); pollTimer = undefined; }
    },
    pullNow: () => serial(async () => {
      try { await cycle(); } catch (err) { onFailure(err); throw err instanceof RemoteError ? err.original : err; }
    }),
    stats: () => ({ ...stats }),
  };
}
