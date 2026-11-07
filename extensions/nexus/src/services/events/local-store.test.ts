import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fx } from "../../contracts/fixtures";
import { demoScenario } from "../../contracts/fixtures/scenario";
import { scriptedNexusEvents } from "../../contracts/fixtures/stream";
import type { AgentEvent } from "../../contracts";
import { LocalStore } from "./local-store";

const by = { via: "app" as const, userId: "U_ADRIAN" };
const redact = (t: string) => t.replace(/xox[bp]-[A-Za-z0-9-]+/g, "[REDACTED]");
let dir: string;
const open = () => new LocalStore({ dir, redact });

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-store-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

async function seed(s: LocalStore) {
  await s.putTask(fx.task);
  await s.putSession(fx.session);
  for (const e of demoScenario.agentEvents) await s.appendAgentEvent(e);
  await s.putApproval(fx.approval);
  await s.putApproval(fx.approvalDecided);
  await s.decideApproval("apr_01", "approved", by, "2026-11-07T04:00:00Z");
  await s.putReview(fx.review);
  for (const r of demoScenario.receipts) await s.putReceipt(r);
  await s.putPlan(fx.plan);
  for (const e of demoScenario.events.slice(0, 50)) await s.putNexusEvent(e);
}

async function dump(s: LocalStore) {
  return {
    tasks: await s.listTasks(), sessions: await s.listSessions(), approvals: await s.listApprovals(),
    agent: await s.agentEvents("ses_01", 0), review: await s.getReviewForApproval("apr_02"),
    receipts: await s.listReceipts(), plan: await s.getPlan("plan_01"),
    events: await s.queryEvents({ from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z", limit: 5000 }),
    search: await s.searchEvents("change", 20), status: await s.status(),
  };
}

describe("LocalStore", () => {
  it("reopening from disk equals the in-memory state, including decisions", async () => {
    const a = open();
    await seed(a);
    const before = await dump(a);
    expect((await a.getApproval("apr_01"))?.decision).toBe("approved");
    expect(await dump(open())).toEqual(before);
  });

  it("conditional resolve wins once, also across reopen", async () => {
    const a = open();
    await a.putApproval(fx.approval);
    const r1 = await a.decideApproval("apr_01", "approved", by, "t1");
    const r2 = await a.decideApproval("apr_01", "rejected", { via: "slack", userId: "U_B" }, "t2");
    expect([r1.won, r2.won, r2.approval.decision, r2.approval.decidedBy?.via]).toEqual([true, false, "approved", "app"]);
    const b = open();
    const r3 = await b.decideApproval("apr_01", "rejected", by, "t3");
    expect([r3.won, r3.approval.decision]).toEqual([false, "approved"]);
  });

  it("putApproval cannot change a decision but still updates other fields", async () => {
    const a = open();
    await a.putApproval(fx.approval);
    await a.decideApproval("apr_01", "approved", by, "t1");
    await a.putApproval({ ...fx.approval, decision: "rejected", reason: "new reason", slackMessage: { channelId: "C", ts: "1" } });
    const got = (await a.getApproval("apr_01"))!;
    expect([got.decision, got.reason, got.slackMessage?.ts]).toEqual(["approved", "new reason", "1"]);
    expect((await open().getApproval("apr_01"))).toEqual(got);
  });

  it("passes free text through the injected redact on write, memory and disk", async () => {
    const secret = "xoxp-1234-SECRET-token";
    const a = open();
    await a.putTask({ ...fx.task, brief: `use ${secret}` });
    await a.putApproval({ ...fx.approval, reason: secret, action: { kind: "run_command", command: `curl -H ${secret}` }, diffPreview: secret });
    await a.putNexusEvent({ ...fx.event, title: secret });
    await a.appendAgentEvent({ sessionId: "ses_01", seq: 0, at: fx.task.createdAt, type: "tool_call", tool: "cmd.run", args: { env: [secret] } });
    await a.appendAgentEvent({ sessionId: "ses_01", seq: 1, at: fx.task.createdAt, type: "file_edit", path: "a", diff: secret });
    await a.putReview({ ...fx.review, summary: secret, judges: [{ modelId: "j", verdict: "looks_good", notes: secret }] });
    expect((await a.getTask("task_01"))?.brief).toBe("use [REDACTED]");
    for (const f of fs.readdirSync(dir)) expect(fs.readFileSync(path.join(dir, f), "utf8")).not.toContain("SECRET");
  });

  it("skips a torn last line and keeps appending cleanly", async () => {
    const a = open();
    await a.putNexusEvent(fx.event);
    fs.appendFileSync(path.join(dir, "events.jsonl"), '{"op":"put","record":{"id":"torn","ki');
    const b = open();
    expect((await b.searchEvents("add cart", 5)).map(h => h.event.id)).toEqual([fx.event.id]);
    await b.putNexusEvent({ ...fx.event, id: "second", title: "second event" });
    const c = open();
    expect((await c.searchEvents("event", 5)).map(h => h.event.id)).toEqual(["second"]);
    expect(await c.searchEvents("add cart", 5)).toHaveLength(1);
  });

  it("queries a window of 10k scripted events in under 50 ms", async () => {
    const all = scriptedNexusEvents({ hours: 36, perHour: 280, seed: 7 });
    expect(all.length).toBeGreaterThan(10000);
    const a = open();
    for (const e of all) await a.putNexusEvent(e);
    const b = open();   // rebuilt from disk
    const query = { from: "2026-11-07T10:00:00Z", to: "2026-11-07T22:00:00Z", limit: 2000 };
    await b.queryEvents(query);   // warm up
    const t0 = performance.now();
    const got = await b.queryEvents(query);
    const ms = performance.now() - t0;
    expect(got.length).toBeGreaterThan(100);
    expect(got.every(e => e.at >= query.from && e.at <= query.to)).toBe(true);
    expect(got.map(e => e.at)).toEqual([...got.map(e => e.at)].sort());
    expect(ms).toBeLessThan(50);
  });

  it("filters queries by orbit and kind", async () => {
    const a = open();
    for (const e of demoScenario.events) await a.putNexusEvent(e);
    const got = await a.queryEvents({ from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z", orbits: ["main"], kinds: ["merge"], limit: 100 });
    expect(got.length).toBeGreaterThan(0);
    expect(got.every(e => e.orbit === "main" && e.kind === "merge")).toBe(true);
  });

  it("isolates callers and dedupes events, agent events and receipts", async () => {
    const a = open();
    const input = { ...fx.task };
    await a.putTask(input);
    input.title = "changed";
    const got = (await a.getTask("task_01"))!;
    got.title = "mutated";
    expect((await a.getTask("task_01"))?.title).toBe(fx.task.title);
    const seen: string[] = [];
    a.subscribeEvents(e => seen.push(e.title));
    await a.putNexusEvent(fx.event);
    await a.putNexusEvent({ ...fx.event, title: "overwrite" });
    expect(seen).toEqual([fx.event.title]);
    const ae: AgentEvent = { sessionId: "s", seq: 0, at: fx.task.createdAt, type: "message", text: "hi" };
    await a.appendAgentEvent(ae); await a.appendAgentEvent(ae);
    await a.putReceipt(fx.receipt); await a.putReceipt(fx.receipt);
    expect([(await a.agentEvents("s", 0)).length, (await a.listReceipts()).length]).toEqual([1, 1]);
  });

  it("isolates throwing listeners and honors unsubscribe", async () => {
    const a = open();
    const seen: string[] = [];
    a.subscribeEvents(() => { throw new Error("boom"); });
    a.subscribeApprovals(() => { throw new Error("boom"); });
    a.subscribeStatus(() => { throw new Error("boom"); });
    a.subscribeEvents(e => seen.push(e.id));
    a.subscribeApprovals(x => seen.push(x.id));
    a.subscribeStatus(st => seen.push(`depth${st.outboxDepth}`));
    const off = a.subscribeEvents(e => seen.push("late" + e.id));
    off();
    await a.putNexusEvent(fx.event);
    await a.putApproval(fx.approval);
    expect([...seen].sort()).toEqual(["apr_01", "depth1", "depth2", fx.event.id].sort());
  });

  it("tracks the outbox across reopen and ack", async () => {
    const a = open();
    await a.putTask(fx.task);
    await a.putApproval(fx.approval);
    await a.decideApproval("apr_01", "approved", by, "t1");
    expect((await a.status()).outboxDepth).toBe(3);
    const b = open();
    const pending = b.pendingOutbox();
    expect(pending.map(e => [e.table, e.op])).toEqual([["tasks", "put"], ["approvals", "put"], ["approvals", "decide"]]);
    b.ackOutbox(pending.slice(0, 2).map(e => e.id), "2026-11-07T05:00:00Z");
    const c = open();
    expect(c.pendingOutbox().map(e => e.op)).toEqual(["decide"]);
    await c.putTask({ ...fx.task, id: "t2" });
    expect(c.pendingOutbox().map(e => e.id)).toEqual([3, 4]);
  });
});
