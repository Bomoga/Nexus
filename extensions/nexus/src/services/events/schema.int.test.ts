// L2-09: the Tiger Cloud schema applies twice without error and holds one row of every stored table.
// Skips without TIGER_URL; runs only via the int config, never in `npm test`. Inserts happen inside a transaction that is
// rolled back, so the team's shared database is never changed by this test.
//   npm run test:int -- schema
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const url = process.env.TIGER_URL;
const sqlFile = (name: string) => readFileSync(path.join(__dirname, "../../../sql", name), "utf8");
const schema = sqlFile("001_schema.sql");
// 002 to 004 build on 001 (aggregates, notify triggers, the per-workspace aggregate); each is idempotent and transaction-safe (WITH NO DATA).
const later = ["002_aggregates.sql", "003_notify.sql", "004_activity_ws.sql"].map(sqlFile);

const rows: Array<[table: string, sql: string, params: unknown[]]> = [
  ["events", "INSERT INTO events (id, at, kind, orbit, title, actor_name, actor_kind, target, workspace_id, machine_id) VALUES ($1, now(), 'commit', 'main', 't', 'a', 'human', '{\"type\":\"commit\"}', 'w', 'm')", ["evt_schema_test"]],
  ["agent_events", "INSERT INTO agent_events (session_id, seq, at, type, payload) VALUES ($1, 0, now(), 'status', '{}')", ["ses_schema_test"]],
  ["model_call_receipts", "INSERT INTO model_call_receipts (call_id, at, role, requested_model, served_model, cost_usd, prune_receipt_id) VALUES ($1, now(), 'agent', 'm', 'm', 0, 'r')", ["call_schema_test"]],
  ["tasks", "INSERT INTO tasks (id, title, brief, source, workspace_id, status, created_at) VALUES ($1, 't', 'b', '{\"kind\":\"manual\"}', 'w', 'draft', now())", ["tsk_schema_test"]],
  ["sessions", "INSERT INTO sessions (id, task_id, model_provider, model_id, branch, worktree_path, base_commit, status, started_at, machine_id) VALUES ($1, 't', 'p', 'm', 'b', '/w', 'c', 'running', now(), 'm')", ["ses_schema_test"]],
  ["approvals", "INSERT INTO approvals (id, session_id, action, reason, requested_at) VALUES ($1, 's', '{\"kind\":\"commit\"}', 'r', now())", ["apr_schema_test"]],
  ["swarm_reviews", "INSERT INTO swarm_reviews (id, session_id, approval_id, swarm_type, status, at) VALUES ($1, 's', 'a', 'CouncilAsAJudge', 'running', now())", ["rev_schema_test"]],
  ["task_plans", "INSERT INTO task_plans (id, source_task_id, swarm_type, status, subtasks, at) VALUES ($1, 't', 'HierarchicalSwarm', 'proposed', '[]', now())", ["pln_schema_test"]],
];

describe.skipIf(!url)("L2-09 Tiger Cloud schema", () => {
  it("applies twice and round-trips one row per table, leaving no data behind", async () => {
    const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: true } });
    await client.connect();
    try {
      await client.query(schema);
      await client.query(schema);   // idempotent
      await client.query("BEGIN");
      try {
        for (let pass = 0; pass < 2; pass++) for (const file of later) await client.query(file);   // applied twice, rolled back with the rest
        for (const [table, sql, params] of rows) {
          await client.query(sql, params);
          const key = table === "agent_events" ? "session_id" : table === "model_call_receipts" ? "call_id" : "id";
          const found = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${key} = $1`, params);
          expect([table, found.rows[0].n]).toEqual([table, 1]);
        }
        // first answer wins: only an undecided approval can be decided
        const first = await client.query("UPDATE approvals SET decision = 'approved' WHERE id = $1 AND decision IS NULL", ["apr_schema_test"]);
        const second = await client.query("UPDATE approvals SET decision = 'rejected' WHERE id = $1 AND decision IS NULL", ["apr_schema_test"]);
        expect([first.rowCount, second.rowCount]).toEqual([1, 0]);
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      await client.end();
    }
  }, 60_000);
});
