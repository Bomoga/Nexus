import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fx } from "../../contracts/fixtures";
import type { AgentEvent, DecidedBy, NexusEvent } from "../../contracts";
import { LocalStore } from "./local-store";
import { createSync, SYNC_SQL, SYNC_TABLES } from "./sync";
import type { ListenFn, Sync, SyncClient } from "./sync";

type Row = Record<string, unknown>;
const ME = "m_a", OTHER = "m_b";
const byA: DecidedBy = { via: "app", userId: "U_A" };
const byB: DecidedBy = { via: "slack", userId: "U_B" };
const D = (s: string) => new Date(s);
const T = (n: number) => new Date(Date.UTC(2026, 10, 7, 4, 0, n)).toISOString();

const ALL = { from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z", limit: 100 };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

/** An in-memory stand-in for Tiger Cloud that understands exactly the statements the sync issues. */
class FakeRemote implements SyncClient {
  tables = Object.fromEntries(SYNC_TABLES.map(t => [t, [] as Row[]])) as Record<string, Row[]>;
  down = false;
  log: string[] = [];
  onPoll?: (table: string) => void;
  hidden = new Set<string>();   // "agent_events:ses:seq" rows not yet visible (uncommitted)
  private keyOf(t: string, r: Row): string { return t === "agent_events" ? `${r.session_id}:${r.seq}` : String(t === "model_call_receipts" ? r.call_id : r.id); }

  put(table: string, row: Row, updatedAt: string) {
    const list = this.tables[table];
    const i = list.findIndex(r => this.keyOf(table, r) === this.keyOf(table, row));
    const full = { ...row, updated_at: D(updatedAt) };
    if (i >= 0) list[i] = full; else list.push(full);
  }

  async query(text: string, params: unknown[] = []) {
    this.log.push(text === SYNC_SQL.probe ? "probe" : text);
    if (this.down) throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    if (text === SYNC_SQL.probe) return { rows: [], rowCount: 0 };
    for (const t of SYNC_TABLES) {
      if (text === SYNC_SQL.poll(t) || text === SYNC_SQL.pollAfter(t)) {
        const after = text === SYNC_SQL.pollAfter(t);
        const ms = Number(params[0]);
        const limit = Number(params[params.length - 1]);
        const tuple = (r: Row): [number, string, number] => [(r.updated_at as Date).getTime(), t === "agent_events" ? String(r.session_id) : this.keyOf(t, r), t === "agent_events" ? Number(r.seq) : 0];
        const cmp = (x: [number, string, number], y: [number, string, number]) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) || x[2] - y[2];
        const bound: [number, string, number] = [ms, String(params[1] ?? ""), Number(params[2] ?? 0)];
        const rows = this.visible(t).filter(r => (after ? cmp(tuple(r), bound) > 0 : (r.updated_at as Date).getTime() > ms))
          .sort((a, b) => cmp(tuple(a), tuple(b))).slice(0, limit).map(r => ({ ...r, sync_ms: String((r.updated_at as Date).getTime()) }));
        this.onPoll?.(t);
        return { rows, rowCount: rows.length };
      }
      if (t !== "agent_events" && text === SYNC_SQL.byKey(t)) {
        const rows = this.visible(t).filter(r => this.keyOf(t, r) === params[0]);
        return { rows, rowCount: rows.length };
      }
    }
    if (text === SYNC_SQL.agentFrom) {
      const rows = this.visible("agent_events").filter(r => r.session_id === params[0] && Number(r.seq) >= Number(params[1])).sort((a, b) => Number(a.seq) - Number(b.seq)).slice(0, Number(params[2]));
      return { rows, rowCount: rows.length };
    }
    if (text === SYNC_SQL.agentRange) {
      const rows = this.visible("agent_events").filter(r => r.session_id === params[0] && Number(r.seq) >= Number(params[1]) && Number(r.seq) < Number(params[2])).sort((a, b) => Number(a.seq) - Number(b.seq));
      return { rows, rowCount: rows.length };
    }
    throw new Error(`unexpected SQL: ${text}`);
  }
  private visible(t: string) { return this.tables[t].filter(r => !this.hidden.has(`${t}:${this.keyOf(t, r)}`)); }
}

class FakeTimers {
  private items: { id: number; fn: () => void; ms: number }[] = [];
  private next = 1;
  setTimeout = (fn: () => void, ms: number) => { const id = this.next++; this.items.push({ id, fn, ms }); return id; };
  clearTimeout = (h: unknown) => { this.items = this.items.filter(i => i.id !== h); };
  pending() { return this.items.length; }
  delays() { return this.items.map(i => i.ms); }
  async fire() { const it = this.items.shift(); expect(it, "a timer was pending").toBeTruthy(); it!.fn(); await settle(); }
}

// ---- row builders: what machine B's TigerStore would have written ----
const agentRow = (e: AgentEvent): Row => { const { sessionId, seq, at, type, ...payload } = e; return { session_id: sessionId, seq, at: D(at), type, payload }; };
const eventRow = (e: NexusEvent): Row => ({ id: e.id, at: D(e.at), kind: e.kind, orbit: e.orbit, from_orbit: null, title: e.title, actor_name: e.actor.name, actor_kind: e.actor.kind, target: e.target, workspace_id: e.workspaceId, machine_id: e.machineId, auth0_user_id: null });
const sessionRow = (machine: string, id = "ses_b"): Row => ({
  id, task_id: "task_01", model_provider: "anthropic", model_id: "claude-sonnet-4-5", branch: `nexus/agent-${id}`, worktree_path: "/tmp/w",
  base_commit: fx.session.baseCommit, status: "running", started_at: D(T(1)), ended_at: null, machine_id: machine, optimizer: null, slack_progress: null,
});
const approvalRow = (id: string, decision?: "approved" | "rejected", by?: DecidedBy): Row => ({
  id, session_id: "ses_b", action: { kind: "run_command", command: "npm test" }, reason: "need tests (model-written)", requested_at: D(T(2)),
  decision: decision ?? null, decided_by: by ?? null, decided_at: decision ? D(T(30)) : null, slack_message: null, ciba_auth_req_id: null, diff_preview: null,
});
const msg = (sessionId: string, seq: number): AgentEvent => ({ sessionId, seq, at: T(seq), type: "message", text: `m${seq}` });

let dir: string, local: LocalStore, remote: FakeRemote, timers: FakeTimers, flushes: string[], logs: string[], online: boolean[], sync: Sync;
let listenFn: ListenFn | undefined, notify: ((p: string) => void) | undefined, onClose: ((e?: unknown) => void) | undefined, unlistened: number;

let flushImpl: () => Promise<unknown> = async () => undefined;
function make(opts: { listen?: "ok" | "fail" | "none"; since?: string; batchSize?: number; holdMs?: number; local?: LocalStore } = {}) {
  const mode = opts.listen ?? "none";
  listenFn = mode === "none" ? undefined : async (_c, onPayload, close) => {
    if (mode === "fail") throw new Error("no listen");
    notify = onPayload; onClose = close;
    return async () => { unlistened++; };
  };
  sync = createSync({
    client: remote, listen: listenFn, local: opts.local ?? local, machineId: ME, timers, since: opts.since, batchSize: opts.batchSize, holdMs: opts.holdMs,
    flushOutbox: async () => { flushes.push("flush"); remote.log.push("flush"); return flushImpl(); },
    setOnline: o => online.push(o), log: m => logs.push(m), pollMs: 2000, reconcileMs: 30_000,
  });
  return sync;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sync-"));
  local = new LocalStore({ dir, redact: t => t });
  remote = new FakeRemote(); timers = new FakeTimers();
  flushImpl = async () => undefined; flushes = []; logs = []; online = []; unlistened = 0; notify = undefined; onClose = undefined;
});
afterEach(async () => { await sync?.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("sync: pulling what other machines wrote", () => {
  it("shows machine B's agent events on machine A, in order with seq intact", async () => {
    for (const seq of [0, 1, 2, 3]) remote.put("agent_events", agentRow(msg("ses_b", seq)), T(10 + seq));
    remote.put("sessions", sessionRow(OTHER), T(9));
    await make().start();
    expect((await local.agentEvents("ses_b", 0)).map(e => e.seq)).toEqual([0, 1, 2, 3]);
    expect((await local.agentEvents("ses_b", 2)).map(e => e.seq)).toEqual([2, 3]);
    expect((await local.getSession("ses_b"))?.machineId).toBe(OTHER);
    expect(local.pendingOutbox()).toEqual([]);   // pulled rows are not queued back to the remote
  });

  it("fills a gap with a range fetch before applying the event after it", async () => {
    for (const seq of [0, 1]) remote.put("agent_events", agentRow(msg("ses_b", seq)), T(10));
    await make().start();
    // seq 2 was committed earlier than the cursor can see; only seq 3 shows up in the next poll
    remote.put("agent_events", agentRow(msg("ses_b", 2)), "2020-01-01T00:00:00.000Z");
    remote.put("agent_events", agentRow(msg("ses_b", 3)), T(40));
    await sync.pullNow();
    expect((await local.agentEvents("ses_b", 0)).map(e => e.seq)).toEqual([0, 1, 2, 3]);
    expect(sync.stats().gapFetches).toBe(1);
    expect(remote.log.some(l => l === SYNC_SQL.agentRange)).toBe(true);
  });

  it("holds an event whose predecessor is not visible yet, and never exposes a gap", async () => {
    for (const seq of [0, 1, 3]) remote.put("agent_events", agentRow(msg("ses_b", seq)), T(10 + seq));
    await make().start();
    expect((await local.agentEvents("ses_b", 0)).map(e => e.seq)).toEqual([0, 1]);
    remote.put("agent_events", agentRow(msg("ses_b", 2)), T(50));   // now committed
    await sync.pullNow();
    expect((await local.agentEvents("ses_b", 0)).map(e => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it("holds a session's events while its seq 0 is not visible yet", async () => {
    for (const seq of [1, 2]) remote.put("agent_events", agentRow(msg("ses_c", seq)), T(10 + seq));
    await make().start();
    expect((await local.agentEvents("ses_c", 0)).map(e => e.seq)).toEqual([]);
    remote.put("agent_events", agentRow(msg("ses_c", 0)), T(50));
    await sync.pullNow();
    expect((await local.agentEvents("ses_c", 0)).map(e => e.seq)).toEqual([0, 1, 2]);
  });

  it("skips this machine's own rows and publishes the others on the subscriptions", async () => {
    const mine = { ...fx.event, id: "ws:commit:mine", machineId: ME, title: "mine" };
    const theirs = { ...fx.event, id: "ws:commit:theirs", machineId: OTHER, title: "theirs" };
    remote.put("events", eventRow(mine), T(5)); remote.put("events", eventRow(theirs), T(6));
    remote.put("sessions", sessionRow(ME, "ses_mine"), T(5));
    const got: string[] = [];
    local.subscribeEvents(e => got.push(e.id));
    await make().start();
    expect(got).toEqual(["ws:commit:theirs"]);
    expect(await local.getSession("ses_mine")).toBeUndefined();
  });

  it("does not overwrite a newer local write that is still queued", async () => {
    await local.putTask({ ...fx.task, title: "local edit" });
    remote.put("tasks", { id: fx.task.id, title: "old remote", brief: fx.task.brief, source: fx.task.source, workspace_id: fx.task.workspaceId, status: fx.task.status, session_id: null, created_at: D(fx.task.createdAt), code_refs: [], created_by: null }, T(3));
    await make().start();
    expect((await local.getTask(fx.task.id))?.title).toBe("local edit");
  });

  it("skips and counts rows that do not parse", async () => {
    remote.put("events", { ...eventRow(fx.event), id: "bad", kind: "nonsense", machine_id: OTHER }, T(2));
    await make().start();
    expect(sync.stats().skippedRows).toBe(1);
    expect(await local.queryEvents(ALL)).toEqual([]);
  });
});

describe("sync: approvals", () => {
  it("lands a remote decision on the owning machine's undecided approval and wakes subscribers", async () => {
    await local.putApproval({ ...fx.approval, id: "apr_x", sessionId: "ses_b" });
    const woke: (string | undefined)[] = [];
    local.subscribeApprovals(a => woke.push(a.decision));
    remote.put("approvals", approvalRow("apr_x", "approved", byB), T(31));
    await make().start();
    const a = await local.getApproval("apr_x");
    expect(a?.decision).toBe("approved");
    expect(a?.decidedBy?.userId).toBe("U_B");
    expect(woke).toContain("approved");
  });

  it("creates an approval it has never seen, then applies its decision", async () => {
    remote.put("approvals", approvalRow("apr_new", "rejected", byB), T(31));
    await make().start();
    expect((await local.getApproval("apr_new"))?.decision).toBe("rejected");
  });

  it("the session's owner keeps a different local decision, and says so once", async () => {
    await local.putSession({ ...fx.session, id: "ses_b", machineId: ME });
    await local.putApproval({ ...fx.approval, id: "apr_y", sessionId: "ses_b" });
    await local.decideApproval("apr_y", "rejected", byA, T(20));
    remote.put("approvals", approvalRow("apr_y", "approved", byB), T(31));
    await make().start();
    expect((await local.getApproval("apr_y"))?.decision).toBe("rejected");
    remote.put("approvals", { ...approvalRow("apr_y", "approved", byB), reason: "edited (model-written)" }, T(60));
    await sync.pullNow();
    expect((await local.getApproval("apr_y"))?.decision).toBe("rejected");
    expect(logs.filter(l => l.includes("apr_y"))).toHaveLength(1);
  });
});

describe("sync: approvals and ownership", () => {
  it("a machine that does not own the session converges to the shared decision", async () => {
    await local.putSession({ ...fx.session, id: "ses_b", machineId: OTHER });
    await local.putApproval({ ...fx.approval, id: "apr_n", sessionId: "ses_b" });
    await local.decideApproval("apr_n", "rejected", byA, T(20));
    remote.put("approvals", approvalRow("apr_n", "approved", byB), T(31));
    await make().start();
    const a = await local.getApproval("apr_n");
    expect([a?.decision, a?.decidedBy?.userId]).toEqual(["approved", "U_B"]);
  });

  it("an unknown session, or an unusable machine id, is not owned", async () => {
    await local.putApproval({ ...fx.approval, id: "apr_u", sessionId: "ses_unknown" });
    await local.decideApproval("apr_u", "rejected", byA, T(20));
    await local.putSession({ ...fx.session, id: "ses_blank", machineId: "  " });
    await local.putApproval({ ...fx.approval, id: "apr_v", sessionId: "ses_blank" });
    await local.decideApproval("apr_v", "rejected", byA, T(20));
    remote.put("approvals", { ...approvalRow("apr_u", "approved", byB), session_id: "ses_unknown" }, T(31));
    remote.put("approvals", { ...approvalRow("apr_v", "approved", byB), session_id: "ses_blank" }, T(31));
    await make().start();
    expect([(await local.getApproval("apr_u"))?.decision, (await local.getApproval("apr_v"))?.decision]).toEqual(["approved", "approved"]);
  });
});

describe("sync: paging", () => {
  it("reads 7 rows that share one timestamp with a batch size of 3", async () => {
    for (let i = 0; i < 7; i++) remote.put("events", eventRow({ ...fx.event, id: `ws:commit:s${i}`, machineId: OTHER }), T(5));
    await make({ batchSize: 3 }).start();
    expect((await local.queryEvents(ALL)).map(e => e.id).sort()).toEqual([0, 1, 2, 3, 4, 5, 6].map(i => `ws:commit:s${i}`));
  });

  it("still polls newer rows after a full page that sits inside the overlap window", async () => {
    for (let i = 0; i < 3; i++) remote.put("events", eventRow({ ...fx.event, id: `ws:commit:f${i}`, machineId: OTHER }), T(5));
    await make({ batchSize: 3 }).start();
    remote.put("events", eventRow({ ...fx.event, id: "ws:commit:newer", machineId: OTHER }), T(6));
    await sync.pullNow();
    expect((await local.queryEvents(ALL)).map(e => e.id)).toContain("ws:commit:newer");
  });
});

describe("sync: not losing or regressing local writes", () => {
  it("leaves a subscriber's writes made during an apply in the outbox", async () => {
    let wrote = false;
    local.subscribeApprovals(a => {
      if (a.id !== "apr_s" || wrote) return;
      wrote = true;
      void local.putApproval({ ...fx.approval, id: "apr_other", sessionId: "ses_b" });
      void local.putApproval({ ...a, reason: "edited by the user (model-written)" });   // same key, same op
    });
    remote.put("approvals", approvalRow("apr_s"), T(31));
    await make().start();
    const queued = local.pendingOutbox().map(e => `${e.table}:${e.op}:${(e.record as { id: string; reason?: string }).id}:${(e.record as { reason?: string }).reason?.slice(0, 6)}`).sort();
    expect(queued).toEqual(["approvals:put:apr_other:Need t", "approvals:put:apr_s:edited"]);
  });

  it("does not let a stale row regress a task whose local write was flushed while the query ran", async () => {
    await local.putTask({ ...fx.task, title: "v2 local" });
    remote.put("tasks", { id: fx.task.id, title: "v1 old", brief: fx.task.brief, source: fx.task.source, workspace_id: fx.task.workspaceId, status: fx.task.status, session_id: null, created_at: D(fx.task.createdAt), code_refs: [], created_by: null }, T(3));
    remote.onPoll = t => { if (t === "tasks") local.ackOutbox(local.pendingOutbox().map(e => e.id), T(4)); };   // the flush lands mid-query
    await make().start();
    expect((await local.getTask(fx.task.id))?.title).toBe("v2 local");
  });

  it("does not regress a review or a plan to an older version", async () => {
    await local.putReview({ ...fx.review, at: T(50), summary: "newer (model-written)" });
    local.ackOutbox(local.pendingOutbox().map(e => e.id), T(51));
    const r = fx.review;
    remote.put("swarm_reviews", { id: r.id, session_id: r.sessionId, approval_id: r.approvalId, swarm_type: r.swarmType, status: r.status, verdict: r.verdict, summary: "older (model-written)", judges: r.judges, at: D(T(10)), duration_ms: 1 }, T(11));
    await make().start();
    expect((await local.getReviewForApproval(r.approvalId))?.summary).toBe("newer (model-written)");
  });
});

describe("sync: agent event edge cases", () => {
  it("does not stall a session behind an event that never parses", async () => {
    remote.put("agent_events", agentRow(msg("ses_b", 0)), T(10));
    remote.put("agent_events", { ...agentRow(msg("ses_b", 1)), type: "bogus" }, T(11));
    remote.put("agent_events", agentRow(msg("ses_b", 2)), T(12));
    await make().start();
    expect((await local.agentEvents("ses_b", 0)).map(e => e.seq)).toEqual([0, 2]);
    expect(sync.stats().skippedRows).toBe(1);
    expect(sync.stats().gapFetches).toBe(0);
    remote.put("agent_events", agentRow(msg("ses_b", 3)), T(13));
    await sync.pullNow();
    expect((await local.agentEvents("ses_b", 0)).map(e => e.seq)).toEqual([0, 2, 3]);
    expect(sync.stats().skippedRows).toBe(1);
  });

  it("retries an event whose local append failed", async () => {
    for (const seq of [0, 1]) remote.put("agent_events", agentRow(msg("ses_b", seq)), T(10 + seq));
    const real = local.appendAgentEvent.bind(local);
    let failed = false;
    local.appendAgentEvent = async e => { if (!failed && e.seq === 1) { failed = true; throw new Error("disk full"); } return real(e); };
    await make().start();
    expect((await local.agentEvents("ses_b", 0)).map(e => e.seq)).toEqual([0]);
    await sync.pullNow();
    expect((await local.agentEvents("ses_b", 0)).map(e => e.seq)).toEqual([0, 1]);
  });

  it("applies past a hole only after the hold time and 3 range fetches, logging once", async () => {
    for (const seq of [0, 3]) remote.put("agent_events", agentRow(msg("ses_b", seq)), T(10 + seq));
    let clock = 1_000_000;
    sync = createSync({ client: remote, local, machineId: ME, timers, flushOutbox: async () => undefined, holdMs: 100, now: () => clock, log: m => logs.push(m) });
    await sync.start();
    expect((await local.agentEvents("ses_b", 0)).map(e => e.seq)).toEqual([0]);   // fetch 1
    clock += 500;
    await sync.pullNow();                                                          // fetch 2: time is up, count is not
    expect((await local.agentEvents("ses_b", 0)).map(e => e.seq)).toEqual([0]);
    await sync.pullNow();                                                          // fetch 3
    expect((await local.agentEvents("ses_b", 0)).map(e => e.seq)).toEqual([0, 3]);
    await sync.pullNow();
    expect(logs.filter(l => l.includes("missing events"))).toHaveLength(1);
  });

  it("makes one query for 100 NOTIFYs about one session, and none for a session this machine owns", async () => {
    await local.putSession({ ...fx.session, id: "ses_mine", machineId: ME });
    await make({ listen: "ok" }).start();
    remote.log.length = 0;
    remote.put("agent_events", agentRow(msg("ses_n", 0)), T(70));
    for (let i = 0; i < 100; i++) notify!(JSON.stringify({ table: "agent_events", id: "ses_n:0", session_id: "ses_n" }));
    for (let i = 0; i < 20; i++) notify!(JSON.stringify({ table: "agent_events", id: "ses_mine:0", session_id: "ses_mine" }));
    await settle();
    expect(remote.log.filter(l => l === SYNC_SQL.agentFrom)).toHaveLength(1);
    expect((await local.agentEvents("ses_n", 0)).map(e => e.seq)).toEqual([0]);
  });
});

describe("sync: flush retry", () => {
  it("retries a failed outbox flush on the next cycle", async () => {
    let calls = 0;
    flushImpl = async () => { calls++; if (calls === 1) throw new Error("still down"); return { flushed: 0, remaining: 0 }; };
    await make().start();
    expect(calls).toBe(1);
    await timers.fire();
    expect(calls).toBe(2);
    await timers.fire();
    expect(calls).toBe(2);   // flushed, so not again
  });

  it("keeps flushing while the combined store reports entries remaining", async () => {
    let calls = 0;
    flushImpl = async () => { calls++; return { flushed: 0, remaining: calls < 3 ? 2 : 0 }; };
    await make().start();
    await timers.fire(); await timers.fire(); await timers.fire();
    expect(calls).toBe(3);
  });
});

describe("sync: NOTIFY and polling", () => {
  it("applies a NOTIFY by fetching just the named rows", async () => {
    await make({ listen: "ok" }).start();
    remote.log.length = 0;
    const ev = { ...fx.event, id: "ws:commit:n1", machineId: OTHER };
    remote.put("events", eventRow(ev), T(70));
    notify!(JSON.stringify({ table: "events", id: ev.id, session_id: null }));
    await settle();
    expect((await local.queryEvents(ALL)).map(e => e.id)).toEqual([ev.id]);
    expect(remote.log).toEqual([SYNC_SQL.byKey("events")]);

    for (const seq of [0, 1]) remote.put("agent_events", agentRow(msg("ses_n", seq)), T(71));
    notify!(JSON.stringify({ table: "agent_events", id: "ses_n:1", session_id: "ses_n" }));
    await settle();
    expect((await local.agentEvents("ses_n", 0)).map(e => e.seq)).toEqual([0, 1]);
  });

  it("ignores malformed or unknown notifications", async () => {
    await make({ listen: "ok" }).start();
    remote.log.length = 0;
    for (const p of ["not json", JSON.stringify({ table: "pg_user", id: "x" }), JSON.stringify({ table: "events" }), "{}"]) notify!(p);
    await settle();
    expect(remote.log).toEqual([]);
  });

  it("polls every pollMs when LISTEN is absent", async () => {
    await make().start();
    expect(timers.delays()).toEqual([2000]);
    remote.put("events", eventRow({ ...fx.event, id: "ws:commit:p1", machineId: OTHER }), T(80));
    await timers.fire();
    expect((await local.queryEvents(ALL)).map(e => e.id)).toEqual(["ws:commit:p1"]);
    expect(timers.delays()).toEqual([2000]);
  });

  it("polling takes over when LISTEN fails, and LISTEN is retried", async () => {
    await make({ listen: "fail" }).start();
    expect(logs.some(l => l.includes("LISTEN unavailable"))).toBe(true);
    expect(timers.delays().sort()).toEqual([2000, 2000]);   // the poll and the LISTEN retry
    remote.put("events", eventRow({ ...fx.event, id: "ws:commit:p2", machineId: OTHER }), T(81));
    await timers.fire();   // the LISTEN retry (fails again)
    await timers.fire();   // the poll
    expect((await local.queryEvents(ALL)).map(e => e.id)).toContain("ws:commit:p2");
  });

  it("falls back to fast polling when an established LISTEN connection drops", async () => {
    await make({ listen: "ok" }).start();
    expect(timers.delays()).toEqual([30_000]);
    onClose!(new Error("dropped"));
    expect(timers.delays().sort()).toEqual([2000, 2000]);
  });

  it("does not re-apply a row it already has when the overlap window re-reads it", async () => {
    remote.put("events", eventRow({ ...fx.event, id: "ws:commit:o1", machineId: OTHER }), T(90));
    const got: string[] = [];
    local.subscribeEvents(e => got.push(e.id));
    await make().start();
    await sync.pullNow(); await sync.pullNow();
    expect(got).toEqual(["ws:commit:o1"]);
  });
});

describe("sync: outages", () => {
  it("backs off 2s to 30s, reports offline, and flushes the outbox before pulling once back", async () => {
    await make().start();
    flushes.length = 0;
    remote.down = true;
    for (const expected of [2000, 4000, 8000, 16_000, 30_000, 30_000]) {
      await timers.fire();
      expect(timers.delays()).toEqual([expected]);
    }
    expect(online).toEqual([true, false]);
    remote.down = false;
    remote.put("events", eventRow({ ...fx.event, id: "ws:commit:r1", machineId: OTHER }), T(95));
    remote.log.length = 0;
    await timers.fire();
    expect(online).toEqual([true, false, true]);
    const flushAt = remote.log.indexOf("flush");
    const firstPull = remote.log.findIndex(l => l.startsWith("SELECT *, floor"));
    expect(flushAt).toBeGreaterThanOrEqual(0);
    expect(flushAt).toBeLessThan(firstPull);
    expect(remote.log[0]).toBe("probe");
    expect(timers.delays()).toEqual([2000]);
    expect((await local.queryEvents(ALL)).map(e => e.id)).toEqual(["ws:commit:r1"]);
  });
});

describe("sync: stop", () => {
  it("ends LISTEN, leaves no timers, and does nothing afterwards", async () => {
    await make({ listen: "fail" }).start();
    await sync.stop();
    expect(timers.pending()).toBe(0);
    const s = make({ listen: "ok" }); await s.start();
    expect(timers.pending()).toBe(1);
    await s.stop();
    expect(unlistened).toBe(1);
    expect(timers.pending()).toBe(0);
    remote.log.length = 0;
    notify?.(JSON.stringify({ table: "events", id: "x" }));
    await settle();
    expect(remote.log).toEqual([]);
  });

  it("stop during a slow pull leaves nothing scheduled", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const slow = new FakeRemote();
    const orig = slow.query.bind(slow);
    slow.query = async (t, p) => { await gate; return orig(t, p); };
    sync = createSync({ client: slow, local, machineId: ME, timers, flushOutbox: async () => undefined });
    const started = sync.start();
    await settle();
    const stopped = sync.stop();
    release();
    await Promise.all([started, stopped]);
    expect(timers.pending()).toBe(0);
  });
});
