// L2-11: applies 003_notify.sql, LISTENs on "nexus" and checks each table's trigger sends its own table name (a hypertable's
// chunk trigger must not leak a _hyper_N_M_chunk name). Skips without TIGER_TEST_URL (a scratch database, not the team service); runs only via the int config.
// Rows are committed (NOTIFY is only delivered on commit) and then deleted by unique id; deletes fire no trigger.
//   TIGER_TEST_URL=... npm run test:int -- sync
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

// A scratch database, never the team's: with 003 applied, these rows would be copied into every running teammate's Nexus.
const url = process.env.TIGER_TEST_URL;
const sql = (f: string) => readFileSync(path.join(__dirname, "../../../sql", f), "utf8");
const tag = `sync_int_${Date.now()}`;

const rows: Array<[table: string, insert: string, key: string, expectedId: string]> = [
  ["events", `INSERT INTO events (id, at, kind, orbit, title, actor_name, actor_kind, target, workspace_id, machine_id) VALUES ('${tag}', now(), 'commit', 'main', 't', 'a', 'human', '{"type":"commit"}', 'w', 'm')`, `id = '${tag}'`, tag],
  ["agent_events", `INSERT INTO agent_events (session_id, seq, at, type, payload) VALUES ('${tag}', 0, now(), 'status', '{}')`, `session_id = '${tag}'`, `${tag}:0`],
  ["model_call_receipts", `INSERT INTO model_call_receipts (call_id, at, role, requested_model, served_model, cost_usd, prune_receipt_id) VALUES ('${tag}', now(), 'agent', 'm', 'm', 0, 'r')`, `call_id = '${tag}'`, tag],
  ["tasks", `INSERT INTO tasks (id, title, brief, source, workspace_id, status, created_at) VALUES ('${tag}', 't', 'b', '{"kind":"manual"}', 'w', 'draft', now())`, `id = '${tag}'`, tag],
  ["sessions", `INSERT INTO sessions (id, task_id, model_provider, model_id, branch, worktree_path, base_commit, status, started_at, machine_id) VALUES ('${tag}', 't', 'p', 'm', 'b', '/w', 'c', 'running', now(), 'm')`, `id = '${tag}'`, tag],
  ["approvals", `INSERT INTO approvals (id, session_id, action, reason, requested_at) VALUES ('${tag}', 's', '{"kind":"commit"}', 'r', now())`, `id = '${tag}'`, tag],
  ["swarm_reviews", `INSERT INTO swarm_reviews (id, session_id, approval_id, swarm_type, status, at) VALUES ('${tag}', 's', 'a', 'CouncilAsAJudge', 'running', now())`, `id = '${tag}'`, tag],
  ["task_plans", `INSERT INTO task_plans (id, source_task_id, swarm_type, status, subtasks, at) VALUES ('${tag}', 't', 'HierarchicalSwarm', 'proposed', '[]', now())`, `id = '${tag}'`, tag],
];

describe.skipIf(!url)("L2-11 notify triggers", () => {
  it("send the real table name for every table", async () => {
    const ssl = { rejectUnauthorized: true };
    const writer = new Client({ connectionString: url, ssl });
    const listener = new Client({ connectionString: url, ssl });
    await writer.connect();
    await listener.connect();
    const got: Array<{ table: string; id: string }> = [];
    listener.on("notification", m => { if (m.payload) { const p = JSON.parse(m.payload) as { table: string; id: string }; if (p.id.startsWith(tag)) got.push(p); } });
    try {
      await writer.query(sql("001_schema.sql"));
      await writer.query(sql("003_notify.sql"));
      await writer.query(sql("003_notify.sql"));   // idempotent
      await listener.query("LISTEN nexus");
      for (const [, insert] of rows) await writer.query(insert);
      await new Promise(r => setTimeout(r, 1500));
      expect(got.map(g => [g.table, g.id]).sort()).toEqual(rows.map(r => [r[0], r[3]]).sort());
    } finally {
      for (const [table, , where] of rows) await writer.query(`DELETE FROM ${table} WHERE ${where}`).catch(() => undefined);
      await listener.end();
      await writer.end();
    }
  }, 60_000);
});
