import { describe, expect, it } from "vitest";
import { fx } from "../../contracts/fixtures";
import { demoScenario } from "../../contracts/fixtures/scenario";
import type { AgentEvent, NexusEvent } from "../../contracts";
import { ApprovalNotFoundError, ApprovalUnparseableError, SQL, TigerStore, createTigerPool, isTransientError, queryEventsSql } from "./tiger-store";
import type { PoolConstructor, TigerClient } from "./tiger-store";

const SECRET = "SECRETVAL";
const redact = (t: string) => t.replaceAll(SECRET, "[R]");
/** What a timestamp looks like after a trip through timestamptz: always with milliseconds. */
const ms = <T>(v: T): T => JSON.parse(JSON.stringify(v).replace(/(\d\d:\d\d:\d\d)Z"/g, '$1.000Z"'));
const by = (userId: string) => ({ via: "app" as const, userId });

const PKS: Record<string, string[]> = {
  events: ["id", "at"], agent_events: ["session_id", "seq", "at"], model_call_receipts: ["call_id", "at"],
};

/** An in-memory stand-in for the shared database: it reads each INSERT's column list and casts from the SQL text, so the
 *  statements themselves drive it, and it honours ON CONFLICT DO NOTHING / DO UPDATE and the conditional decision UPDATE. */
class FakePg implements TigerClient {
  tables: Record<string, Map<string, Record<string, unknown>>> = {};
  calls: { text: string; params: unknown[] }[] = [];
  down = false;
  failWith: (Error & { code?: string }) | undefined;

  table(name: string) { return (this.tables[name] ??= new Map()); }
  sqlOf() { return this.calls.map(c => c.text); }
  paramsText() { return JSON.stringify(this.calls.map(c => c.params)); }

  async query(text: string, params: unknown[] = []) {
    this.calls.push({ text, params });
    if (this.down) throw new Error("connection refused");
    if (this.failWith) throw this.failWith;
    const rows = (rs: Record<string, unknown>[]) => ({ rows: rs.map(r => ({ ...r })), rowCount: rs.length });
    const insert = /^INSERT INTO (\w+) \(([^)]+)\)\s*VALUES \((.+?)\)\s*ON CONFLICT/s.exec(text);
    if (insert) return this.insert(insert[1], insert[2].split(",").map(s => s.trim()), insert[3], params, text.includes("DO NOTHING"), text);
    if (text === SQL.overrideDecision) {   // no guard: replaces whatever is there
      const row = this.table("approvals").get(String(params[0]));
      if (!row) return rows([]);
      Object.assign(row, { decision: params[1], decided_by: JSON.parse(String(params[2])), decided_at: new Date(String(params[3])) });
      return rows([row]);
    }
    if (text === SQL.decideApproval) {
      const row = this.table("approvals").get(String(params[0]));
      // the fake evaluates the statement's own guard, so dropping `AND decision IS NULL` from the SQL fails behavioral tests
      const guarded = text.includes("AND decision IS NULL");
      if (!row || (guarded && row.decision != null)) return rows([]);
      Object.assign(row, { decision: params[1], decided_by: JSON.parse(String(params[2])), decided_at: new Date(String(params[3])) });
      return rows([row]);
    }
    const all = (t: string) => [...this.table(t).values()];
    const byId = (t: string) => all(t).filter(r => r.id === params[0]);
    const sortBy = (rs: Record<string, unknown>[], k: string) => [...rs].sort((a, b) => +(a[k] as Date) - +(b[k] as Date));
    switch (text) {
      case SQL.selectTask: return rows(byId("tasks"));
      case SQL.listTasks: return rows(sortBy(all("tasks"), "created_at"));
      case SQL.selectSession: return rows(byId("sessions"));
      case SQL.listSessions: return rows(sortBy(all("sessions"), "started_at"));
      case SQL.selectApproval: return rows(byId("approvals"));
      case SQL.listApprovals: return rows(sortBy(all("approvals"), "requested_at"));
      case SQL.selectPlan: return rows(byId("task_plans"));
      case SQL.agentEvents: {
        const mine = all("agent_events").filter(r => r.session_id === params[0] && (r.seq as number) >= (params[1] as number)).sort((a, b) => (a.seq as number) - (b.seq as number) || +(a.at as Date) - +(b.at as Date));
        return rows(text.includes("DISTINCT ON (seq)") ? mine.filter((r, i) => i === 0 || r.seq !== mine[i - 1].seq) : mine);
      }
      case SQL.reviewForApproval: return rows(sortBy(all("swarm_reviews").filter(r => r.approval_id === params[0]), "at").reverse().slice(0, 1));
      case SQL.listReceipts: return rows(sortBy(all("model_call_receipts").filter(r => params[0] === null || r.session_id === params[0]), "at"));
      case SQL.searchEvents: return rows(this.search(String(params[0]), Number(params[1]), params[2]));
    }
    if (text.startsWith("SELECT * FROM events WHERE at >=")) return rows(this.window(text, params));
    throw new Error(`FakePg: unhandled statement ${text.slice(0, 60)}`);
  }

  private insert(table: string, cols: string[], values: string, params: unknown[], doNothing: boolean, text: string) {
    const row: Record<string, unknown> = {};
    values.split(",").forEach((v, i) => {
      const raw = params[Number(/\$(\d+)/.exec(v)![1]) - 1];
      row[cols[i]] = v.includes("::jsonb") ? (raw === null ? null : JSON.parse(String(raw))) : v.includes("::timestamptz") ? (raw === null ? null : new Date(String(raw))) : raw;
    });
    const pk = (PKS[table] ?? ["id"]).map(c => (row[c] instanceof Date ? (row[c] as Date).toISOString() : String(row[c]))).join("|");
    const existing = this.table(table).get(pk);
    if (existing && doNothing) return { rows: [], rowCount: 0 };
    if (existing) {   // DO UPDATE: every listed column is replaced, except approvals' optional fields (COALESCE) and, once decided, its frozen ones
      const frozen = table === "approvals" && existing.decision != null && text.includes("approvals.decision IS NULL") ? ["session_id", "action", "reason", "requested_at", "diff_preview"] : [];
      for (const c of cols) if (!frozen.includes(c) && !(table === "approvals" && row[c] === null && ["slack_message", "ciba_auth_req_id", "diff_preview"].includes(c))) existing[c] = row[c];
    } else {
      this.table(table).set(pk, row);
    }
    return { rows: [], rowCount: 1 };
  }

  private window(text: string, params: unknown[]) {
    const [from, to] = [new Date(String(params[0])), new Date(String(params[1]))];
    let i = 2;
    const orbits = text.includes("orbit = ANY") ? (params[i++] as string[]) : undefined;
    const kinds = text.includes("kind = ANY") ? (params[i++] as string[]) : undefined;
    const workspace = text.includes("AND workspace_id = $") ? params[i++] : undefined;
    const limit = params[i] as number;
    return [...this.table("events").values()]
      .filter(r => (workspace === undefined || r.workspace_id === workspace) && +(r.at as Date) >= +from && +(r.at as Date) <= +to && (!orbits || orbits.includes(r.orbit as string)) && (!kinds || kinds.includes(r.kind as string)))
      .sort((a, b) => +(a.at as Date) - +(b.at as Date) || String(a.id).localeCompare(String(b.id))).slice(0, limit);
  }

  private search(pattern: string, limit: number, workspace: unknown): Record<string, unknown>[] {
    const q = pattern.slice(1, -1).replace(/!(.)/g, "$1");
    return [...this.table("events").values()].filter(r => r.workspace_id === workspace).map(r => {
      const title = String(r.title).toLowerCase(), sha = String((r.target as { sha?: string }).sha ?? "").toLowerCase();
      const other = `${r.orbit}\n${r.actor_name}`.toLowerCase();
      return { ...r, score: title.includes(q) ? 3 : sha.includes(q) ? 2 : other.includes(q) ? 1 : 0 } as Record<string, unknown> & { score: number };
    }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || +(b.at as Date) - +(a.at as Date)).slice(0, limit);
  }
}

const WS = fx.event.workspaceId;
const make = (fake = new FakePg(), auth0UserId?: string) => ({ fake, store: new TigerStore({ client: fake, redact, auth0UserId, workspaceId: async () => WS }) });
const ALL = { from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z", limit: 5000 };

describe("TigerStore SQL", () => {
  it("writes each record with parameterised SQL (text snapshot per method)", async () => {
    const { fake, store } = make();
    const sqlFor = async (run: () => Promise<unknown>) => { fake.calls.length = 0; await run(); return fake.sqlOf(); };
    expect(await sqlFor(() => store.putNexusEvent(fx.event))).toMatchInlineSnapshot(`
      [
        "INSERT INTO events (id, at, kind, orbit, from_orbit, title, actor_name, actor_kind, target, workspace_id, machine_id, auth0_user_id)
      VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
      ON CONFLICT DO NOTHING",
      ]
    `);
    expect(await sqlFor(() => store.appendAgentEvent(demoScenario.agentEvents[0]))).toMatchInlineSnapshot(`
      [
        "INSERT INTO agent_events (session_id, seq, at, type, payload)
      VALUES ($1, $2, $3::timestamptz, $4, $5::jsonb)
      ON CONFLICT DO NOTHING",
      ]
    `);
    expect(await sqlFor(() => store.putReceipt(fx.receipt))).toMatchInlineSnapshot(`
      [
        "INSERT INTO model_call_receipts (call_id, at, session_id, role, requested_model, served_model, cost_usd, baseline_cost_usd, optimizations, prune_receipt_id)
      VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
      ON CONFLICT DO NOTHING",
      ]
    `);
    expect(await sqlFor(() => store.putTask(fx.task))).toMatchInlineSnapshot(`
      [
        "INSERT INTO tasks (id, title, brief, source, workspace_id, status, session_id, created_at, code_refs, created_by)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::timestamptz, $9::jsonb, $10::jsonb)
      ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, brief = EXCLUDED.brief, source = EXCLUDED.source,
        workspace_id = EXCLUDED.workspace_id, status = EXCLUDED.status, session_id = EXCLUDED.session_id,
        created_at = EXCLUDED.created_at, code_refs = EXCLUDED.code_refs, created_by = EXCLUDED.created_by",
      ]
    `);
    expect(await sqlFor(() => store.putSession(fx.session))).toMatchInlineSnapshot(`
      [
        "INSERT INTO sessions (id, task_id, model_provider, model_id, branch, worktree_path, base_commit, status, started_at, ended_at, machine_id, optimizer, slack_progress)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11, $12::jsonb, $13::jsonb)
      ON CONFLICT (id) DO UPDATE SET task_id = EXCLUDED.task_id, model_provider = EXCLUDED.model_provider, model_id = EXCLUDED.model_id,
        branch = EXCLUDED.branch, worktree_path = EXCLUDED.worktree_path, base_commit = EXCLUDED.base_commit, status = EXCLUDED.status,
        started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at, machine_id = EXCLUDED.machine_id,
        optimizer = EXCLUDED.optimizer, slack_progress = EXCLUDED.slack_progress",
      ]
    `);
    expect(await sqlFor(() => store.putApproval(fx.approval))).toMatchInlineSnapshot(`
      [
        "INSERT INTO approvals (id, session_id, action, reason, requested_at, slack_message, ciba_auth_req_id, diff_preview)
      VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz, $6::jsonb, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        session_id = CASE WHEN approvals.decision IS NULL THEN EXCLUDED.session_id ELSE approvals.session_id END,
        action = CASE WHEN approvals.decision IS NULL THEN EXCLUDED.action ELSE approvals.action END,
        reason = CASE WHEN approvals.decision IS NULL THEN EXCLUDED.reason ELSE approvals.reason END,
        requested_at = CASE WHEN approvals.decision IS NULL THEN EXCLUDED.requested_at ELSE approvals.requested_at END,
        diff_preview = CASE WHEN approvals.decision IS NULL THEN COALESCE(EXCLUDED.diff_preview, approvals.diff_preview) ELSE approvals.diff_preview END,
        slack_message = COALESCE(EXCLUDED.slack_message, approvals.slack_message),
        ciba_auth_req_id = COALESCE(EXCLUDED.ciba_auth_req_id, approvals.ciba_auth_req_id)",
      ]
    `);
    expect(await sqlFor(() => store.decideApproval("apr_01", "approved", by("U_A"), "2026-11-07T04:00:00Z"))).toMatchInlineSnapshot(`
      [
        "UPDATE approvals SET decision = $2, decided_by = $3::jsonb, decided_at = $4::timestamptz
      WHERE id = $1 AND decision IS NULL
      RETURNING *",
      ]
    `);
    expect(await sqlFor(() => store.overrideDecision("apr_01", "approved", by("U_A"), "2026-11-07T04:00:00Z"))).toMatchInlineSnapshot(`
      [
        "UPDATE approvals SET decision = $2, decided_by = $3::jsonb, decided_at = $4::timestamptz
      WHERE id = $1
      RETURNING *",
      ]
    `);
    expect(await sqlFor(() => store.putReview(fx.review))).toMatchInlineSnapshot(`
      [
        "INSERT INTO swarm_reviews (id, session_id, approval_id, swarm_type, status, verdict, summary, judges, at, duration_ms, data_left_machine)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $10, $11)
      ON CONFLICT (id) DO UPDATE SET session_id = EXCLUDED.session_id, approval_id = EXCLUDED.approval_id, swarm_type = EXCLUDED.swarm_type,
        status = EXCLUDED.status, verdict = EXCLUDED.verdict, summary = EXCLUDED.summary, judges = EXCLUDED.judges,
        at = EXCLUDED.at, duration_ms = EXCLUDED.duration_ms, data_left_machine = EXCLUDED.data_left_machine",
      ]
    `);
    expect(await sqlFor(() => store.putPlan(fx.plan))).toMatchInlineSnapshot(`
      [
        "INSERT INTO task_plans (id, source_task_id, swarm_type, status, subtasks, created_task_ids, at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::timestamptz)
      ON CONFLICT (id) DO UPDATE SET source_task_id = EXCLUDED.source_task_id, swarm_type = EXCLUDED.swarm_type, status = EXCLUDED.status,
        subtasks = EXCLUDED.subtasks, created_task_ids = EXCLUDED.created_task_ids, at = EXCLUDED.at",
      ]
    `);
  });

  it("reads with one statement each (text snapshot per method)", async () => {
    const { fake, store } = make();
    const sqlFor = async (run: () => Promise<unknown>) => { fake.calls.length = 0; await run(); return fake.sqlOf(); };
    expect(await sqlFor(() => store.getTask("t"))).toMatchInlineSnapshot(`
      [
        "SELECT * FROM tasks WHERE id = $1",
      ]
    `);
    expect(await sqlFor(() => store.listTasks())).toMatchInlineSnapshot(`
      [
        "SELECT * FROM tasks ORDER BY created_at, id",
      ]
    `);
    expect(await sqlFor(() => store.getSession("s"))).toMatchInlineSnapshot(`
      [
        "SELECT * FROM sessions WHERE id = $1",
      ]
    `);
    expect(await sqlFor(() => store.listSessions())).toMatchInlineSnapshot(`
      [
        "SELECT * FROM sessions ORDER BY started_at, id",
      ]
    `);
    expect(await sqlFor(() => store.agentEvents("s", 3))).toMatchInlineSnapshot(`
      [
        "SELECT DISTINCT ON (seq) * FROM agent_events WHERE session_id = $1 AND seq >= $2 ORDER BY seq, at",
      ]
    `);
    expect(await sqlFor(() => store.getApproval("a"))).toMatchInlineSnapshot(`
      [
        "SELECT * FROM approvals WHERE id = $1",
      ]
    `);
    expect(await sqlFor(() => store.listApprovals())).toMatchInlineSnapshot(`
      [
        "SELECT * FROM approvals ORDER BY requested_at, id",
      ]
    `);
    expect(await sqlFor(() => store.getReviewForApproval("a"))).toMatchInlineSnapshot(`
      [
        "SELECT * FROM swarm_reviews WHERE approval_id = $1 ORDER BY at DESC LIMIT 1",
      ]
    `);
    expect(await sqlFor(() => store.listReceipts("s"))).toMatchInlineSnapshot(`
      [
        "SELECT * FROM model_call_receipts WHERE ($1::text IS NULL OR session_id = $1) ORDER BY at, call_id",
      ]
    `);
    expect(await sqlFor(() => store.getPlan("p"))).toMatchInlineSnapshot(`
      [
        "SELECT * FROM task_plans WHERE id = $1",
      ]
    `);
    expect(await sqlFor(() => store.searchEvents("x", 5))).toMatchInlineSnapshot(`
      [
        "SELECT *, CASE WHEN lower(title) LIKE $1 ESCAPE '!' THEN 3 WHEN lower(target->>'sha') LIKE $1 ESCAPE '!' THEN 2 ELSE 1 END AS score
      FROM events
      WHERE workspace_id = $3 AND (lower(title) LIKE $1 ESCAPE '!' OR lower(target->>'sha') LIKE $1 ESCAPE '!' OR lower(orbit || chr(10) || actor_name) LIKE $1 ESCAPE '!')
      ORDER BY score DESC, at DESC
      LIMIT $2",
      ]
    `);
    expect(await sqlFor(() => store.queryEvents({ ...ALL, orbits: ["main"], kinds: ["commit"] }))).toMatchInlineSnapshot(`
      [
        "SELECT * FROM events WHERE at >= $1::timestamptz AND at <= $2::timestamptz AND orbit = ANY($3::text[]) AND kind = ANY($4::text[]) AND workspace_id = $5 ORDER BY at, id LIMIT $6",
      ]
    `);
    expect([queryEventsSql(false, false), queryEventsSql(true, false), queryEventsSql(false, true)]).toMatchInlineSnapshot(`
      [
        "SELECT * FROM events WHERE at >= $1::timestamptz AND at <= $2::timestamptz AND workspace_id = $3 ORDER BY at, id LIMIT $4",
        "SELECT * FROM events WHERE at >= $1::timestamptz AND at <= $2::timestamptz AND orbit = ANY($3::text[]) AND workspace_id = $4 ORDER BY at, id LIMIT $5",
        "SELECT * FROM events WHERE at >= $1::timestamptz AND at <= $2::timestamptz AND kind = ANY($3::text[]) AND workspace_id = $4 ORDER BY at, id LIMIT $5",
      ]
    `);
  });

  it("limits the events reads to the current workspace (exact SQL and parameters)", async () => {
    const { fake, store } = make();
    await store.queryEvents({ ...ALL, orbits: ["main"], limit: 7 });
    await store.searchEvents("Cart", 5);
    expect(fake.calls.map(c => c.text.includes("workspace_id = $") && c.text)).toEqual([
      "SELECT * FROM events WHERE at >= $1::timestamptz AND at <= $2::timestamptz AND orbit = ANY($3::text[]) AND workspace_id = $4 ORDER BY at, id LIMIT $5",
      expect.stringContaining("WHERE workspace_id = $3 AND (lower(title) LIKE $1"),
    ]);
    expect(fake.calls.map(c => c.params)).toEqual([[ALL.from, ALL.to, ["main"], WS, 7], ["%cart%", 5, WS]]);
  });

  it("returns nothing, without querying, while the workspace id is unknown", async () => {
    for (const workspaceId of [undefined, async () => undefined, async () => "", async (): Promise<string> => { throw new Error("not a repo"); }]) {
      const fake = new FakePg();
      const store = new TigerStore({ client: fake, redact, ...(workspaceId ? { workspaceId } : {}) });
      expect(await store.queryEvents(ALL)).toEqual([]);
      expect(await store.searchEvents("cart", 5)).toEqual([]);
      expect(fake.calls).toEqual([]);
    }
  });

  it("never returns another workspace's events", async () => {
    const { store } = make();
    await store.putNexusEvent({ ...fx.event, id: "mine", title: "cart mine" });
    await store.putNexusEvent({ ...fx.event, id: "other", title: "cart other", workspaceId: "f".repeat(40) });
    expect((await store.queryEvents(ALL)).map(e => e.id)).toEqual(["mine"]);
    expect((await store.searchEvents("cart", 5)).map(h => h.event.id)).toEqual(["mine"]);
  });

  it("never puts a value in the SQL text", async () => {
    const { fake, store } = make();
    const evil = "x'); DROP TABLE events; --";
    await store.putNexusEvent({ ...fx.event, id: "evil", title: evil, orbit: evil });
    await store.searchEvents(evil, 5);
    await store.queryEvents({ ...ALL, orbits: [evil] });
    expect(fake.sqlOf().some(s => s.includes("DROP"))).toBe(false);
    expect(fake.paramsText()).toContain("DROP TABLE");
  });
});

describe("TigerStore round trips", () => {
  it("returns exactly what was written, for every record type", async () => {
    const { store } = make();
    await store.putTask(fx.task);
    await store.putSession(fx.session);
    for (const e of demoScenario.agentEvents) await store.appendAgentEvent(e);
    await store.putApproval(fx.approval);
    await store.putApproval(fx.approvalDecided);   // decision fields are ignored on put
    await store.putReview(fx.review);
    for (const r of demoScenario.receipts) await store.putReceipt(r);
    await store.putPlan(fx.plan);
    for (const e of demoScenario.events.slice(0, 30)) await store.putNexusEvent(e);

    expect(await store.getTask(fx.task.id)).toEqual(ms(fx.task));
    expect(await store.listTasks()).toEqual([ms(fx.task)]);
    expect(await store.getSession(fx.session.id)).toEqual(ms(fx.session));
    expect(await store.listSessions()).toEqual([ms(fx.session)]);
    expect(await store.agentEvents(demoScenario.agentEvents[0].sessionId, 0)).toEqual(ms(demoScenario.agentEvents.filter(e => e.sessionId === demoScenario.agentEvents[0].sessionId)));
    expect(await store.getApproval(fx.approval.id)).toEqual(ms(fx.approval));
    expect(await store.getApproval(fx.approvalDecided.id)).toEqual(ms({ ...fx.approvalDecided, decision: undefined, decidedBy: undefined, decidedAt: undefined }));
    expect(await store.getReviewForApproval(fx.review.approvalId)).toEqual(ms(fx.review));
    expect((await store.listReceipts()).map(r => r.callId)).toEqual(demoScenario.receipts.map(r => r.callId));
    expect(await store.getPlan(fx.plan.id)).toEqual(ms(fx.plan));
    expect(await store.queryEvents(ALL)).toHaveLength(30);
    expect(await store.getTask("missing")).toBeUndefined();
  });

  it("keeps agent events replayable from a sequence number", async () => {
    const { store } = make();
    const evs = demoScenario.agentEvents.filter(e => e.sessionId === demoScenario.agentEvents[0].sessionId);
    for (const e of [...evs].reverse()) await store.appendAgentEvent(e);
    expect((await store.agentEvents(evs[0].sessionId, 2)).map(e => e.seq)).toEqual(evs.map(e => e.seq).filter(s => s >= 2));
  });

  it("filters, orders and limits a window query", async () => {
    const { store } = make();
    const mk = (id: string, at: string, orbit: string, kind: NexusEvent["kind"]): NexusEvent => ({ ...fx.event, id, at, orbit, kind });
    for (const e of [mk("c", "2026-11-07T05:00:00Z", "main", "commit"), mk("a", "2026-11-07T03:00:00Z", "main", "commit"), mk("b", "2026-11-07T04:00:00Z", "lane-1", "merge")]) await store.putNexusEvent(e);
    expect((await store.queryEvents(ALL)).map(e => e.id)).toEqual(["a", "b", "c"]);
    expect((await store.queryEvents({ ...ALL, orbits: ["main"] })).map(e => e.id)).toEqual(["a", "c"]);
    expect((await store.queryEvents({ ...ALL, kinds: ["merge"] })).map(e => e.id)).toEqual(["b"]);
    expect((await store.queryEvents({ ...ALL, limit: 2 })).map(e => e.id)).toEqual(["a", "b"]);
    expect((await store.queryEvents({ ...ALL, from: "2026-11-07T03:30:00Z", to: "2026-11-07T04:30:00Z" })).map(e => e.id)).toEqual(["b"]);
    expect(await store.queryEvents({ ...ALL, from: "nope" })).toEqual([]);
  });

  it("ranks search hits title over sha over orbit and treats wildcards literally", async () => {
    const { store } = make();
    const sha = "ab".repeat(20);
    await store.putNexusEvent({ ...fx.event, id: "t", title: "fix the cart", orbit: "main", at: "2026-11-07T03:00:00Z" });
    await store.putNexusEvent({ ...fx.event, id: "s", title: "other", target: { type: "commit", sha }, at: "2026-11-07T03:01:00Z" });
    await store.putNexusEvent({ ...fx.event, id: "o", title: "zzz", orbit: "cart-lane", at: "2026-11-07T03:02:00Z" });
    await store.putNexusEvent({ ...fx.event, id: "p", title: "100% done", at: "2026-11-07T03:03:00Z" });
    expect((await store.searchEvents("cart", 10)).map(h => [h.event.id, h.score])).toEqual([["t", 3], ["o", 1]]);
    expect((await store.searchEvents("abab", 10)).map(h => [h.event.id, h.score])).toEqual([["s", 2]]);
    expect((await store.searchEvents("%", 10)).map(h => h.event.id)).toEqual(["p"]);
    expect(await store.searchEvents("   ", 10)).toEqual([]);
    expect(await store.searchEvents("cart", 1)).toHaveLength(1);
  });
});

describe("TigerStore shared writes", () => {
  it("stores the same event, agent event and receipt from two machines once", async () => {
    const fake = new FakePg();
    const a = make(fake).store, b = make(fake).store;
    const ev = demoScenario.agentEvents[0];
    for (const s of [a, b]) {
      await s.putNexusEvent(fx.event);
      await s.appendAgentEvent(ev);
      await s.putReceipt(fx.receipt);
    }
    expect([fake.table("events").size, fake.table("agent_events").size, fake.table("model_call_receipts").size]).toEqual([1, 1, 1]);
  });

  it("upserts sessions, tasks, reviews and plans instead of duplicating them", async () => {
    const { fake, store } = make();
    await store.putTask(fx.task);
    await store.putTask({ ...fx.task, status: "done" });
    await store.putSession(fx.session);
    await store.putSession({ ...fx.session, status: "done", endedAt: "2026-11-07T05:00:00Z" });
    await store.putReview({ ...fx.review, status: "running", verdict: undefined });
    await store.putReview(fx.review);
    await store.putPlan(fx.plan);
    await store.putPlan({ ...fx.plan, status: "accepted", createdTaskIds: ["t1", "t2"] });
    expect(["tasks", "sessions", "swarm_reviews", "task_plans"].map(t => fake.table(t).size)).toEqual([1, 1, 1, 1]);
    expect((await store.getTask(fx.task.id))?.status).toBe("done");
    expect((await store.getSession(fx.session.id))?.endedAt).toBe("2026-11-07T05:00:00.000Z");
    expect((await store.getReviewForApproval(fx.review.approvalId))?.verdict).toBe("looks_good");
    expect((await store.getPlan(fx.plan.id))?.createdTaskIds).toEqual(["t1", "t2"]);
  });

  it("carries the writer's ids on events and falls back to the configured Auth0 user", async () => {
    const { fake, store } = make(new FakePg(), "auth0|me");
    await store.putNexusEvent(fx.event);
    await store.putNexusEvent({ ...fx.event, id: "other", auth0UserId: "auth0|them" });
    const rows = [...fake.table("events").values()];
    expect(rows.map(r => [r.machine_id, r.auth0_user_id])).toEqual([[fx.event.machineId, "auth0|me"], [fx.event.machineId, "auth0|them"]]);
  });

  it("redacts free text before it is written", async () => {
    const { fake, store } = make();
    await store.putTask({ ...fx.task, title: `t ${SECRET}`, brief: `b ${SECRET}` });
    await store.putNexusEvent({ ...fx.event, title: `e ${SECRET}` });
    await store.putApproval({ ...fx.approval, reason: SECRET, diffPreview: SECRET, action: { kind: "run_command", command: `echo ${SECRET}` } });
    await store.appendAgentEvent({ sessionId: "s", seq: 0, at: "2026-11-07T03:00:00Z", type: "tool_call", tool: "x", args: { [SECRET]: [SECRET, { k: SECRET }] } } satisfies AgentEvent);
    await store.appendAgentEvent({ sessionId: "s", seq: 1, at: "2026-11-07T03:00:01Z", type: "file_edit", path: SECRET, diff: SECRET });
    await store.putReview({ ...fx.review, summary: SECRET, judges: [{ modelId: "m", verdict: "concerns", notes: SECRET }] });
    await store.putReceipt({ ...fx.receipt, optimizations: [SECRET] });
    await store.putPlan({ ...fx.plan, subtasks: fx.plan.subtasks.map(s => ({ ...s, title: SECRET, brief: SECRET })) });
    expect(fake.paramsText()).not.toContain(SECRET);
    expect(fake.paramsText()).toContain("[R]");
  });
});

describe("TigerStore approvals", () => {
  it("puts never touch the decision, and the first decision wins", async () => {
    const { fake, store } = make();
    await store.putApproval(fx.approval);
    const first = await store.decideApproval("apr_01", "approved", by("U_A"), "2026-11-07T04:00:00Z");
    expect(first.won).toBe(true);
    expect(first.approval).toMatchObject({ decision: "approved", decidedBy: by("U_A"), decidedAt: "2026-11-07T04:00:00.000Z" });
    await store.putApproval({ ...fx.approval, slackMessage: { channelId: "C", ts: "1.2" } });   // later put: the Slack message fills in, decision stays
    expect(await store.getApproval("apr_01")).toMatchObject({ slackMessage: { channelId: "C", ts: "1.2" }, decision: "approved" });
    await store.putApproval(fx.approval);   // the optional fields are not erased by a put that lacks them
    expect((await store.getApproval("apr_01"))?.slackMessage).toEqual({ channelId: "C", ts: "1.2" });
    expect(fake.table("approvals").size).toBe(1);
  });

  it("the conflict path returns the existing winner with won false", async () => {
    const fake = new FakePg();
    const a = make(fake).store, b = make(fake).store;
    await a.putApproval(fx.approval);
    const seen: string[] = [];
    b.subscribeApprovals(ap => seen.push(`${ap.decision}`));
    const win = await a.decideApproval("apr_01", "approved", by("U_A"), "2026-11-07T04:00:00Z");
    const lose = await b.decideApproval("apr_01", "rejected", by("U_B"), "2026-11-07T04:00:01Z");
    expect([win.won, lose.won]).toEqual([true, false]);
    expect(lose.approval).toMatchObject({ decision: "approved", decidedBy: by("U_A") });
    expect(seen).toEqual([]);   // b only publishes its own writes
  });

  it("refuses to decide an approval that does not exist", async () => {
    const { store } = make();
    await expect(store.decideApproval("nope", "approved", by("U_A"), "2026-11-07T04:00:00Z")).rejects.toThrow(/unknown approval/);
  });
});

describe("TigerStore review fixes", () => {
  it("an approval's action and reason are frozen once decided; the Slack message may still arrive", async () => {
    const { store } = make();
    await store.putApproval(fx.approval);
    await store.putApproval({ ...fx.approval, reason: "before", diffPreview: "d1" });
    await store.decideApproval("apr_01", "approved", by("U_A"), "2026-11-07T04:00:00Z");
    await store.putApproval({ ...fx.approval, reason: "after", action: { kind: "commit", message: "changed" }, diffPreview: "d2", slackMessage: { channelId: "C", ts: "1.2" } });
    expect(await store.getApproval("apr_01")).toMatchObject({ reason: "before", action: fx.approval.action, diffPreview: "d1", slackMessage: { channelId: "C", ts: "1.2" }, decision: "approved" });
  });

  it("the decision guard is behavioral: an already-decided approval is never overwritten", async () => {
    const { fake, store } = make();
    await store.putApproval(fx.approval);
    await store.decideApproval("apr_01", "approved", by("U_A"), "2026-11-07T04:00:00Z");
    const lose = await store.decideApproval("apr_01", "rejected", by("U_B"), "2026-11-07T04:00:01Z");
    expect(lose.won).toBe(false);
    expect(fake.table("approvals").get("apr_01")).toMatchObject({ decision: "approved", decided_by: by("U_A") });
  });

  it("tells an approval that does not exist from a row that does not parse", async () => {
    const { fake, store } = make();
    await expect(store.decideApproval("nope", "approved", by("U_A"), "2026-11-07T04:00:00Z")).rejects.toBeInstanceOf(ApprovalNotFoundError);
    await store.putApproval(fx.approval);
    await store.decideApproval("apr_01", "approved", by("U_A"), "2026-11-07T04:00:00Z");
    fake.table("approvals").get("apr_01")!.action = { kind: "bogus" };
    await expect(store.decideApproval("apr_01", "rejected", by("U_B"), "2026-11-07T04:00:01Z")).rejects.toBeInstanceOf(ApprovalUnparseableError);
    await store.putApproval({ ...fx.approval, id: "apr_9" });
    fake.table("approvals").get("apr_9")!.action = { kind: "bogus" };
    await expect(store.decideApproval("apr_9", "approved", by("U_A"), "2026-11-07T04:00:00Z")).rejects.toBeInstanceOf(ApprovalUnparseableError);   // decided, but unreadable
    expect([ApprovalNotFoundError, ApprovalUnparseableError].map(C => isTransientError(new C("x")))).toEqual([false, false]);
  });

  it("overrideDecision replaces an existing decision, and is the only path that can", async () => {
    const { store } = make();
    await store.putApproval(fx.approval);
    await store.decideApproval("apr_01", "rejected", by("U_B"), "2026-11-07T04:00:00Z");
    expect((await store.decideApproval("apr_01", "approved", by("U_A"), "2026-11-07T04:00:01Z")).won).toBe(false);
    const over = await store.overrideDecision("apr_01", "approved", by("U_A"), "2026-11-07T04:00:02Z");
    expect(over).toMatchObject({ decision: "approved", decidedBy: by("U_A") });
    expect(await store.getApproval("apr_01")).toMatchObject({ decision: "approved", decidedBy: by("U_A") });
    await expect(store.overrideDecision("nope", "approved", by("U_A"), "2026-11-07T04:00:02Z")).rejects.toBeInstanceOf(ApprovalNotFoundError);
  });

  it("returns one agent event per seq, ordered, even when two machines wrote different timestamps", async () => {
    const { fake, store } = make();
    const e0 = { sessionId: "s", seq: 0, at: "2026-11-07T03:00:00.000Z", type: "message" as const, text: "first" };
    await store.appendAgentEvent(e0);
    await store.appendAgentEvent({ ...e0, seq: 1, text: "one" });
    await store.appendAgentEvent({ ...e0, at: "2026-11-07T03:00:05.000Z", text: "dup from another machine" });
    expect(fake.table("agent_events").size).toBe(3);
    expect((await store.agentEvents("s", 0)).map(e => [e.seq, (e as { text: string }).text])).toEqual([[0, "first"], [1, "one"]]);
  });

  it("clamps limits to 0..5000", async () => {
    const { fake, store } = make();
    await store.queryEvents({ ...ALL, limit: -1 });
    await store.queryEvents({ ...ALL, limit: 99999 });
    await store.searchEvents("x", 99999);
    expect(fake.calls.map(c => (c.text.startsWith("SELECT *, CASE") ? c.params[1] : c.params.at(-1)))).toEqual([0, 5000, 5000]);
  });

  it("a SQL error is not 'unreachable'; a connection error is", async () => {
    const { fake, store } = make();
    fake.failWith = Object.assign(new Error("value too long"), { code: "22001" });
    await expect(store.putTask(fx.task)).rejects.toThrow("value too long");
    expect((await store.status()).online).toBe(true);
    fake.failWith = Object.assign(new Error("terminating connection"), { code: "57P01" });
    await expect(store.putTask(fx.task)).rejects.toThrow();
    expect((await store.status()).online).toBe(false);
  });

  it("classifies errors", () => {
    const code = (c: string) => Object.assign(new Error("x"), { code: c });
    expect([code("23505"), code("22P02"), new Error("unknown approval a")].map(isTransientError)).toEqual([false, false, false]);
    expect([code("08006"), code("57P01"), code("ECONNRESET"), code("ETIMEDOUT"), new Error("Query read timeout"), new Error("weird")].map(isTransientError)).toEqual([true, true, true, true, true, true]);
  });
});

describe("TigerStore resilience", () => {
  it("skips and counts rows that do not parse", async () => {
    const { fake, store } = make();
    await store.putNexusEvent(fx.event);
    await store.putTask(fx.task);
    [...fake.table("events").values()][0].kind = "bogus";
    expect(await store.queryEvents(ALL)).toEqual([]);
    expect(await store.searchEvents("cart", 5)).toEqual([]);
    [...fake.table("tasks").values()][0].status = "bogus";
    expect(await store.listTasks()).toEqual([]);
    expect(store.skippedRows()).toBe(3);
  });

  it("reports offline after a failed query, back online after a good one, and rethrows the error", async () => {
    const { fake, store } = make();
    const seen: boolean[] = [];
    store.subscribeStatus(s => seen.push(s.online));
    fake.down = true;
    await expect(store.putTask(fx.task)).rejects.toThrow("connection refused");
    expect(await store.status()).toEqual({ online: false, outboxDepth: 0 });
    fake.down = false;
    await store.putTask(fx.task);
    expect(seen).toEqual([false, true]);
  });

  it("publishes its own new events once", async () => {
    const { store } = make();
    const seen: string[] = [];
    store.subscribeEvents(e => seen.push(e.id));
    await store.putNexusEvent(fx.event);
    await store.putNexusEvent(fx.event);
    expect(seen).toEqual([fx.event.id]);
  });
});

describe("createTigerPool", () => {
  const config: unknown[] = [];
  const handlers: string[] = [];
  class FakePool {
    constructor(c: unknown) { config.push(c); }
    on(event: string) { handlers.push(event); return this; }
    async query() { return { rows: [], rowCount: 0 }; }
  }
  const make = (url: string) => createTigerPool(url, FakePool as unknown as PoolConstructor);

  it("verifies certificates, strips url ssl settings and guards idle-connection errors", () => {
    make("postgres://tsdbadmin:pa55word@abc.tsdb.cloud.timescale.com:5432/tsdb?sslmode=require&application_name=nexus");
    const c = config.at(-1) as { connectionString: string; ssl: unknown };
    expect(c.ssl).toEqual({ rejectUnauthorized: true });
    expect(c).toMatchObject({ query_timeout: 10_000, connectionTimeoutMillis: 5000, keepAlive: true });
    expect(c.connectionString).not.toContain("sslmode");
    expect(c.connectionString).toContain("application_name=nexus");
    expect(handlers).toContain("error");
  });

  it("refuses connection strings that would not use TLS, without echoing them", () => {
    for (const url of [
      "postgres://u:pa55word@h/db?sslmode=disable", "postgres://u:pa55word@h/db?sslmode=prefer",
      "postgres://u:pa55word@h/db?ssl=false", "mysql://u:pa55word@h/db", "not a url pa55word",
    ]) {
      let message = "";
      try { make(url); } catch (e) { message = (e as Error).message; }
      expect(message, url).not.toBe("");
      expect(message).not.toContain("pa55word");
    }
  });
});
