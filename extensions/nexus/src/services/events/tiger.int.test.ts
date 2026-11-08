// L2-10: TigerStore against the real Tiger Cloud service: one record of every type round-trips and is deleted afterwards.
// Skips without TIGER_TEST_URL (a scratch database, not the team service); runs only via the int config, never in `npm test`. Every id is unique to this run and removed in `finally`.
//   npm run test:int -- tiger.int
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fx } from "../../contracts/fixtures";
import { createTigerPool, TigerStore } from "./tiger-store";

// A scratch database, never the team's: with 003 applied, these rows would be copied into every running teammate's Nexus.
const url = process.env.TIGER_TEST_URL;
const ALL = { from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z", limit: 5000 };

describe.skipIf(!url)("L2-10 TigerStore on Tiger Cloud", () => {
  it("round-trips one of each type, honours first-answer-wins, and cleans up", async () => {
    const run = randomUUID().slice(0, 8);
    const id = (s: string) => `int_${run}_${s}`;
    const client = createTigerPool(url!);
    const store = new TigerStore({ client, redact: t => t, workspaceIds: async () => [fx.event.workspaceId] });   // reads are scoped to the repo
    const sha = "c".repeat(40);
    const task = { ...fx.task, id: id("task") };
    const session = { ...fx.session, id: id("ses"), taskId: task.id, branch: `nexus/agent-${id("ses")}` };
    const approval = { ...fx.approval, id: id("apr"), sessionId: session.id };
    const review = { ...fx.review, id: id("rev"), sessionId: session.id, approvalId: approval.id };
    const plan = { ...fx.plan, id: id("pln"), sourceTaskId: task.id };
    const event = { ...fx.event, id: id("evt"), title: `int test ${run}`, target: { type: "commit" as const, sha } };
    const receipt = { ...fx.receipt, callId: id("call"), sessionId: session.id };
    const agentEvent = { sessionId: session.id, seq: 0, at: "2026-11-07T03:15:00.000Z", type: "message" as const, text: "hello" };
    try {
      await store.putTask(task);
      await store.putSession(session);
      await store.appendAgentEvent(agentEvent);
      await store.putApproval(approval);
      await store.putReview(review);
      await store.putReceipt(receipt);
      await store.putPlan(plan);
      await store.putNexusEvent(event);
      await store.putNexusEvent(event);   // twice: one row

      expect((await store.getTask(task.id))?.id).toBe(task.id);
      expect((await store.getSession(session.id))?.branch).toBe(session.branch);
      expect(await store.agentEvents(session.id, 0)).toHaveLength(1);
      expect((await store.getReviewForApproval(approval.id))?.id).toBe(review.id);
      expect((await store.listReceipts(session.id)).map(r => r.callId)).toEqual([receipt.callId]);
      expect((await store.getPlan(plan.id))?.id).toBe(plan.id);
      expect((await store.queryEvents(ALL)).filter(e => e.id === event.id)).toHaveLength(1);
      expect((await store.searchEvents(`int test ${run}`, 5)).map(h => h.event.id)).toEqual([event.id]);

      const first = await store.decideApproval(approval.id, "approved", { via: "app", userId: "U_INT" }, "2026-11-07T04:00:00Z");
      const second = await store.decideApproval(approval.id, "rejected", { via: "app", userId: "U_OTHER" }, "2026-11-07T04:00:01Z");
      expect([first.won, second.won, second.approval.decision]).toEqual([true, false, "approved"]);
      expect(store.skippedRows()).toBe(0);
    } finally {
      const sql = [
        ["DELETE FROM tasks WHERE id = $1", task.id], ["DELETE FROM sessions WHERE id = $1", session.id],
        ["DELETE FROM agent_events WHERE session_id = $1", session.id], ["DELETE FROM approvals WHERE id = $1", approval.id],
        ["DELETE FROM swarm_reviews WHERE id = $1", review.id], ["DELETE FROM model_call_receipts WHERE call_id = $1", receipt.callId],
        ["DELETE FROM task_plans WHERE id = $1", plan.id], ["DELETE FROM events WHERE id = $1", event.id],
      ] as const;
      for (const [text, param] of sql) await client.query(text, [param]);
      await client.end?.();
    }
  }, 60_000);
});
