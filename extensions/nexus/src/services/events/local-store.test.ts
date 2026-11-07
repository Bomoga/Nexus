import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fx } from "../../contracts/fixtures";
import { demoScenario } from "../../contracts/fixtures/scenario";
import { scriptedNexusEvents } from "../../contracts/fixtures/stream";
import type { AgentEvent, ApprovalRequest, NexusEvent } from "../../contracts";
import { LocalStore } from "./local-store";

const by = { via: "app" as const, userId: "U_ADRIAN" };
const SECRET = "SECRETVAL";
const redact = (t: string) => t.replaceAll(SECRET, "[R]");
const T1 = "2026-11-07T04:00:00Z", T2 = "2026-11-07T04:05:00Z", T3 = "2026-11-07T04:10:00Z";
const ALL = { from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z", limit: 5000 };
let dir: string;
const open = () => new LocalStore({ dir, redact });
const file = (name: string) => path.join(dir, name);
const allFiles = () => fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
const isRoot = process.getuid?.() === 0;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-store-")); });
afterEach(() => {
  for (const f of fs.readdirSync(dir)) fs.chmodSync(file(f), 0o644);
  fs.rmSync(dir, { recursive: true, force: true });
});

async function seed(s: LocalStore) {
  await s.putTask(fx.task);
  await s.putSession(fx.session);
  for (const e of demoScenario.agentEvents) await s.appendAgentEvent(e);
  await s.putApproval(fx.approval);
  await s.putApproval(fx.approvalDecided);
  await s.decideApproval("apr_01", "approved", by, T1);
  await s.putReview(fx.review);
  for (const r of demoScenario.receipts) await s.putReceipt(r);
  await s.putPlan(fx.plan);
  for (const e of demoScenario.events.slice(0, 50)) await s.putNexusEvent(e);
}

/** Everything observable except the outbox status. */
async function dump(s: LocalStore) {
  return {
    tasks: await s.listTasks(), sessions: await s.listSessions(), approvals: await s.listApprovals(),
    agent: await s.agentEvents("ses_01", 0), review: await s.getReviewForApproval("apr_02"),
    receipts: await s.listReceipts(), plan: await s.getPlan("plan_01"),
    events: await s.queryEvents(ALL), search: await s.searchEvents("change", 20),
  };
}

const ev = (id: string, at: string, title = `event ${id}`): NexusEvent => ({ ...fx.event, id, at, title });
const ae = (seq: number, over: Record<string, unknown> = {}): AgentEvent =>
  ({ sessionId: "ses_x", seq, at: T1, ...(over.type ? {} : { type: "message", text: "hi" }), ...over }) as AgentEvent;

describe("LocalStore", () => {
  it("reopening from disk equals the in-memory state, including decisions", async () => {
    const a = open();
    await seed(a);
    const before = await dump(a);
    expect((await a.getApproval("apr_01"))?.decision).toBe("approved");
    const b = open();
    expect(b.skippedLines()).toBe(0);
    expect(await dump(b)).toEqual(before);
    expect(await b.status()).toEqual(await a.status());
  });

  it("conditional resolve wins once, also across reopen", async () => {
    const a = open();
    await a.putApproval(fx.approval);
    const r1 = await a.decideApproval("apr_01", "approved", by, T1);
    const r2 = await a.decideApproval("apr_01", "rejected", { via: "slack", userId: "U_B" }, T2);
    expect([r1.won, r2.won, r2.approval.decision, r2.approval.decidedBy?.via]).toEqual([true, false, "approved", "app"]);
    const r3 = await open().decideApproval("apr_01", "rejected", by, T3);
    expect([r3.won, r3.approval.decision]).toEqual([false, "approved"]);
  });

  it("putApproval cannot change a decision but still updates other fields", async () => {
    const a = open();
    await a.putApproval(fx.approval);
    await a.decideApproval("apr_01", "approved", by, T1);
    await a.putApproval({ ...fx.approval, decision: "rejected", reason: "new reason", slackMessage: { channelId: "C", ts: "1" } });
    const got = (await a.getApproval("apr_01"))!;
    expect([got.decision, got.reason, got.slackMessage?.ts]).toEqual(["approved", "new reason", "1"]);
    expect(await open().getApproval("apr_01")).toEqual(got);
  });

  describe("redaction", () => {
    const x = SECRET;
    const apr = (over: Partial<ApprovalRequest>): ApprovalRequest => ({ ...fx.approval, ...over });
    const rows: [string, (s: LocalStore) => Promise<void>][] = [
      ["task.title", s => s.putTask({ ...fx.task, title: x })],
      ["task.brief", s => s.putTask({ ...fx.task, brief: x })],
      ["approval.reason", s => s.putApproval(apr({ reason: x }))],
      ["approval.diffPreview", s => s.putApproval(apr({ diffPreview: x }))],
      ["approval.action run_command.command", s => s.putApproval(apr({ action: { kind: "run_command", command: x } }))],
      ["approval.action write_outside_scope.path", s => s.putApproval(apr({ action: { kind: "write_outside_scope", path: x } }))],
      ["approval.action commit.message", s => s.putApproval(apr({ action: { kind: "commit", message: x } }))],
      ["approval.action other.description", s => s.putApproval(apr({ action: { kind: "other", description: x } }))],
      ["event.title", s => s.putNexusEvent(ev("e1", T1, x))],
      ["agent message.text", s => s.appendAgentEvent(ae(0, { text: x }))],
      ["agent tool_call.args value (nested)", s => s.appendAgentEvent(ae(0, { type: "tool_call", tool: "cmd.run", args: { env: [{ k: x }] } }))],
      ["agent tool_call.args key (nested)", s => s.appendAgentEvent(ae(0, { type: "tool_call", tool: "cmd.run", args: { a: { [x]: 1 } } }))],
      ["agent tool_result.summary", s => s.appendAgentEvent(ae(0, { type: "tool_result", tool: "t", ok: true, summary: x }))],
      ["agent file_edit.diff", s => s.appendAgentEvent(ae(0, { type: "file_edit", path: "a.ts", diff: x }))],
      ["agent file_edit.path", s => s.appendAgentEvent(ae(0, { type: "file_edit", path: x, diff: "d" }))],
      ["agent error.message", s => s.appendAgentEvent(ae(0, { type: "error", message: x }))],
      ["agent test_output.command", s => s.appendAgentEvent(ae(0, { type: "test_output", command: x, exitCode: 0, tail: "t" }))],
      ["agent test_output.tail", s => s.appendAgentEvent(ae(0, { type: "test_output", command: "c", exitCode: 0, tail: x }))],
      ["agent receipt.optimizations", s => s.appendAgentEvent(ae(0, { type: "receipt", receipt: { ...fx.receipt, optimizations: [x] } }))],
      ["review.summary", s => s.putReview({ ...fx.review, summary: x })],
      ["review.judges.notes", s => s.putReview({ ...fx.review, judges: [{ modelId: "j", verdict: "looks_good", notes: x }] })],
      ["receipt.optimizations", s => s.putReceipt({ ...fx.receipt, optimizations: [x] })],
      ["plan.subtasks.title", s => s.putPlan({ ...fx.plan, subtasks: fx.plan.subtasks.map((t, i) => (i === 0 ? { ...t, title: x } : t)) })],
      ["plan.subtasks.brief", s => s.putPlan({ ...fx.plan, subtasks: fx.plan.subtasks.map((t, i) => (i === 0 ? { ...t, brief: x } : t)) })],
    ];

    it.each(rows)("%s never reaches memory or disk unredacted", async (_name, write) => {
      const s = open();
      await write(s);
      const memory = JSON.stringify({
        t: await s.listTasks(), a: await s.listApprovals(), g: await s.agentEvents("ses_x", 0),
        r: await s.listReceipts(), v: await s.getReviewForApproval("apr_02"), p: await s.getPlan("plan_01"),
        e: await s.queryEvents(ALL),
      });
      expect(memory).not.toContain(SECRET);
      expect(allFiles()).not.toContain(SECRET);
      expect(allFiles()).toContain("[R]");
      expect(JSON.stringify(open().pendingOutbox())).not.toContain(SECRET);
    });
  });

  describe("time", () => {
    it("orders and windows by instant across mixed UTC offsets", async () => {
      const a = open();
      await a.putNexusEvent(ev("e_minus5", "2026-11-07T10:00:00-05:00"));   // 15:00Z
      await a.putNexusEvent(ev("e_z", "2026-11-07T12:00:00Z"));
      await a.putNexusEvent(ev("e_plus9", "2026-11-07T20:00:00+09:00"));    // 11:00Z
      await a.putNexusEvent(ev("e_out", "2026-11-07T20:00:00-05:00"));      // 01:00Z next day
      const window = { from: "2026-11-07T10:00:00Z", to: "2026-11-07T16:00:00Z", limit: 100 };
      const ids = (xs: NexusEvent[]) => xs.map(e => e.id);
      expect(ids(await a.queryEvents(window))).toEqual(["e_plus9", "e_z", "e_minus5"]);
      expect(ids(await open().queryEvents(window))).toEqual(["e_plus9", "e_z", "e_minus5"]);
      expect((await a.searchEvents("event", 10)).map(h => h.event.id)).toEqual(["e_out", "e_minus5", "e_z", "e_plus9"]);
    });

    it("rejects an unparseable event time without writing", async () => {
      const a = open();
      await expect(a.putNexusEvent(ev("bad", "zzz"))).rejects.toThrow();
      expect(fs.existsSync(file("events.jsonl"))).toBe(false);
    });
  });

  describe("failed writes leave memory unchanged and retries work", () => {
    it.skipIf(isRoot)("event journal", async () => {
      const a = open();
      await a.putNexusEvent(ev("e1", T1));
      fs.chmodSync(file("events.jsonl"), 0o444);
      const seen: string[] = [];
      a.subscribeEvents(e => seen.push(e.id));
      await expect(a.putNexusEvent(ev("e2", T2))).rejects.toThrow();
      expect(seen).toEqual([]);
      expect((await a.queryEvents(ALL)).map(e => e.id)).toEqual(["e1"]);
      fs.chmodSync(file("events.jsonl"), 0o644);
      await a.putNexusEvent(ev("e2", T2));
      expect(seen).toEqual(["e2"]);
      expect(await dump(open())).toEqual(await dump(a));
    });

    it.skipIf(isRoot)("agent event journal", async () => {
      const a = open();
      await a.appendAgentEvent(ae(0));
      fs.chmodSync(file("agent-events.jsonl"), 0o444);
      await expect(a.appendAgentEvent(ae(1))).rejects.toThrow();
      expect((await a.agentEvents("ses_x", 0)).map(e => e.seq)).toEqual([0]);
      fs.chmodSync(file("agent-events.jsonl"), 0o644);
      await a.appendAgentEvent(ae(1));   // not treated as a duplicate
      expect((await a.agentEvents("ses_x", 0)).map(e => e.seq)).toEqual([0, 1]);
      expect((await open().agentEvents("ses_x", 0)).map(e => e.seq)).toEqual([0, 1]);
    });

    it.skipIf(isRoot)("a failed rejection never flips to approved after reopen", async () => {
      const a = open();
      await a.putApproval(fx.approval);
      fs.chmodSync(file("approvals.jsonl"), 0o444);
      await expect(a.decideApproval("apr_01", "rejected", by, T1)).rejects.toThrow();
      expect((await a.getApproval("apr_01"))?.decision).toBeUndefined();
      expect((await open().getApproval("apr_01"))?.decision).toBeUndefined();
      fs.chmodSync(file("approvals.jsonl"), 0o644);
      const r = await a.decideApproval("apr_01", "approved", by, T2);
      expect(r.won).toBe(true);
      expect((await open().getApproval("apr_01"))?.decision).toBe("approved");
    });

    it("refuses a write when a file size cannot be read, so a rollback can never truncate a journal", async () => {
      class Faulty extends LocalStore {
        failing = false;
        protected override fileSize(f: string): number {
          if (this.failing) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
          return super.fileSize(f);
        }
      }
      const s = new Faulty({ dir, redact: x => x });
      await s.putTask(fx.task);
      const before = [fs.readFileSync(file("tasks.jsonl"), "utf8"), fs.readFileSync(file("outbox.jsonl"), "utf8")];
      s.failing = true;
      await expect(s.putTask({ ...fx.task, id: "task_2" })).rejects.toThrow("EIO");
      s.failing = false;
      expect([fs.readFileSync(file("tasks.jsonl"), "utf8"), fs.readFileSync(file("outbox.jsonl"), "utf8")]).toEqual(before);
      expect((await s.listTasks()).map(x => x.id)).toEqual([fx.task.id]);
      await s.putTask({ ...fx.task, id: "task_2" });   // a retry works
      const reopened = new LocalStore({ dir, redact: x => x });
      expect((await reopened.listTasks()).map(x => x.id)).toEqual([fx.task.id, "task_2"]);
      expect(reopened.skippedLines()).toBe(0);
    });

    it("non-serializable values throw before anything is written", async () => {
      const a = open();
      await a.putNexusEvent(ev("e1", T1));
      const sizes = () => fs.readdirSync(dir).map(f => [f, fs.statSync(file(f)).size]);
      const before = sizes();
      await expect(a.appendAgentEvent(ae(0, { type: "tool_call", tool: "t", args: { n: 10n } }))).rejects.toThrow();
      expect(sizes()).toEqual(before);
      expect(await a.agentEvents("ses_x", 0)).toEqual([]);
      await a.appendAgentEvent(ae(0));
      expect((await a.agentEvents("ses_x", 0)).length).toBe(1);
    });
  });

  describe("replay validation", () => {
    it("skips and counts bad lines without poisoning indexes", async () => {
      const good = (r: unknown, op = "put") => JSON.stringify({ op, record: r });
      fs.writeFileSync(file("events.jsonl"), [
        "{}", "[]", '{"op":"put","record":null}',
        good(fx.event),
        good({ ...fx.event, id: "no_title", title: undefined }),
        good({ ...fx.event, id: "bad_at", at: "zzz" }),
        '{"op":"put","record":{"id":"torn","ki',
      ].join("\n"));
      fs.writeFileSync(file("approvals.jsonl"), [
        good(fx.approval),
        '{"op":"decide","record":null}',
        good({ id: "ghost", decision: "approved", decidedBy: by, decidedAt: T1 }, "decide"),   // no such approval
        good({ id: "apr_01", decision: "rejected", decidedBy: by, decidedAt: T2 }, "decide"),
        good({ id: "apr_01", decision: "approved", decidedBy: by, decidedAt: T3 }, "decide"),   // second answer, dropped
      ].join("\n") + "\n");
      const s = open();
      expect(s.skippedLines()).toBe(5 + 1 + 2 + 1);
      expect((await s.queryEvents(ALL)).map(e => e.id)).toEqual([fx.event.id]);
      expect((await s.searchEvents("add cart", 5)).length).toBe(1);
      expect((await s.getApproval("apr_01"))?.decision).toBe("rejected");
      await s.putNexusEvent(ev("after", T1));   // live append heals the torn tail
      expect((await open().queryEvents(ALL)).length).toBe(2);
    });

    it("opens a 20k-event session quickly and in order", async () => {
      const lines = Array.from({ length: 20000 }, (_, i) => JSON.stringify({ op: "put", record: ae(i) })).join("\n") + "\n";
      fs.writeFileSync(file("agent-events.jsonl"), lines);
      const t0 = performance.now();
      const s = open();
      const ms = performance.now() - t0;
      const got = await s.agentEvents("ses_x", 19990);
      expect(got.map(e => e.seq)).toEqual(Array.from({ length: 10 }, (_, i) => 19990 + i));
      expect(ms).toBeLessThan(1500);
    });
  });

  it("heals a torn tail on a live append", async () => {
    const a = open();
    await a.putNexusEvent(ev("e1", T1));
    fs.appendFileSync(file("events.jsonl"), '{"op":"put","record":{"id":"torn');
    await a.putNexusEvent(ev("e2", T2));
    const b = open();
    expect((await b.queryEvents(ALL)).map(e => e.id)).toEqual(["e1", "e2"]);
    expect(b.skippedLines()).toBe(1);
  });

  it("skips a torn last line on open and keeps appending cleanly", async () => {
    const a = open();
    await a.putNexusEvent(fx.event);
    fs.appendFileSync(file("events.jsonl"), '{"op":"put","record":{"id":"torn","ki');
    const b = open();
    expect((await b.searchEvents("add cart", 5)).map(h => h.event.id)).toEqual([fx.event.id]);
    await b.putNexusEvent(ev("second", T1, "second event"));
    const c = open();
    expect((await c.searchEvents("second", 5)).map(h => h.event.id)).toEqual(["second"]);
    expect(await c.searchEvents("add cart", 5)).toHaveLength(1);
  });

  it("queries a window of 10k scripted events written through the store in under 50 ms", { timeout: 120000 }, async () => {
    const all = scriptedNexusEvents({ hours: 36, perHour: 280, seed: 7 });
    expect(all.length).toBeGreaterThan(10000);
    const a = open();
    const w0 = performance.now();
    for (const e of all) await a.putNexusEvent(e);
    console.log(`wrote ${all.length} events via putNexusEvent in ${Math.round(performance.now() - w0)} ms`);
    const b = open();   // rebuilt from disk
    expect(b.skippedLines()).toBe(0);
    for (const store of [a, b]) {
      const query = { from: "2026-11-07T10:00:00Z", to: "2026-11-07T22:00:00Z", limit: 2000 };
      await store.queryEvents(query);   // warm up
      const t0 = performance.now();
      const got = await store.queryEvents(query);
      const ms = performance.now() - t0;
      expect(got.length).toBeGreaterThan(100);
      expect(got.every(e => e.at >= query.from && e.at <= query.to)).toBe(true);
      expect(got.map(e => e.at)).toEqual([...got.map(e => e.at)].sort());
      expect(ms).toBeLessThan(50);
    }
    expect((await b.queryEvents({ ...ALL, limit: 5000 })).length).toBe(5000);
    expect(await b.searchEvents("change", 3)).toHaveLength(3);
  });

  it("opens a reversed journal of 100k events in under 1 s", { timeout: 60000 }, async () => {
    const all = scriptedNexusEvents({ hours: 36, perHour: 280, seed: 7 });
    const many: NexusEvent[] = Array.from({ length: 100000 }, (_, i) => ({ ...all[i % all.length], id: `ws:e:${i}`, at: new Date(Date.parse(T1) + i * 1000).toISOString() }));
    fs.writeFileSync(file("events.jsonl"), many.reverse().map(e => JSON.stringify({ op: "put", record: e })).join("\n") + "\n");
    const t0 = performance.now();
    const s = open();
    const ms = performance.now() - t0;
    console.log(`opened 100k reversed events in ${Math.round(ms)} ms`);
    expect(s.skippedLines()).toBe(0);
    const got = await s.queryEvents({ ...ALL, limit: 3 });
    expect(got.map(e => e.id)).toEqual(["ws:e:0", "ws:e:1", "ws:e:2"]);
    expect(ms).toBeLessThan(1000);
  });

  it("opens a reversed 20k-event agent session quickly", async () => {
    const lines = Array.from({ length: 20000 }, (_, i) => JSON.stringify({ op: "put", record: ae(19999 - i) })).join("\n") + "\n";
    fs.writeFileSync(file("agent-events.jsonl"), lines);
    const t0 = performance.now();
    const s = open();
    expect(performance.now() - t0).toBeLessThan(1500);
    expect((await s.agentEvents("ses_x", 19998)).map(e => e.seq)).toEqual([19998, 19999]);
  });

  it("filters queries by orbit and kind", async () => {
    const a = open();
    for (const e of demoScenario.events) await a.putNexusEvent(e);
    const got = await a.queryEvents({ ...ALL, orbits: ["main"], kinds: ["merge"], limit: 100 });
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
    await a.appendAgentEvent(ae(0)); await a.appendAgentEvent(ae(0));
    await a.putReceipt(fx.receipt); await a.putReceipt(fx.receipt);
    expect([(await a.agentEvents("ses_x", 0)).length, (await a.listReceipts()).length]).toEqual([1, 1]);
  });

  it("keeps agent events ordered when they arrive out of order", async () => {
    const a = open();
    for (const n of [0, 2, 1, 3]) await a.appendAgentEvent(ae(n));
    expect((await a.agentEvents("ses_x", 0)).map(e => e.seq)).toEqual([0, 1, 2, 3]);
    expect((await open().agentEvents("ses_x", 2)).map(e => e.seq)).toEqual([2, 3]);
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

  describe("one gate for live writes and replay", () => {
    it("refuses a decision with a non-ISO time and later accepts a valid one", async () => {
      const a = open();
      await a.putApproval(fx.approval);
      await expect(a.decideApproval("apr_01", "rejected", by, "t1")).rejects.toThrow(/invalid approvals decide/);
      expect((await a.getApproval("apr_01"))?.decision).toBeUndefined();
      expect((await a.status()).outboxDepth).toBe(1);
      const r = await a.decideApproval("apr_01", "approved", by, T1);
      expect(r.won).toBe(true);
      expect((await open().getApproval("apr_01"))?.decision).toBe("approved");
    });

    it("refuses records a replay would drop, and leaves memory untouched", async () => {
      const a = open();
      await expect(a.putNexusEvent(ev("bad", "2026-11-07 10:00:00 -0500"))).rejects.toThrow(/invalid events put/);
      await expect(a.appendAgentEvent(ae(0, { type: "test_output", command: "c", exitCode: null, tail: "" }))).rejects.toThrow(/invalid agent_events/);
      expect(await a.queryEvents(ALL)).toEqual([]);
      expect(await a.agentEvents("ses_x", 0)).toEqual([]);
      expect(a.pendingOutbox()).toEqual([]);
    });

    it("throws when the redactor empties a required field", async () => {
      const a = new LocalStore({ dir, redact: t => (t.includes(SECRET) ? "" : t) });
      await expect(a.putTask({ ...fx.task, title: SECRET })).rejects.toThrow(/invalid tasks put/);
      expect(await a.listTasks()).toEqual([]);
      expect(a.pendingOutbox()).toEqual([]);
    });

    it("round-trips a tool call with no args", async () => {
      const a = open();
      await a.appendAgentEvent(ae(0, { type: "tool_call", tool: "git.status", args: undefined }));
      const b = open();
      expect(b.skippedLines()).toBe(0);
      expect(await b.agentEvents("ses_x", 0)).toEqual(await a.agentEvents("ses_x", 0));
      expect(((await b.agentEvents("ses_x", 0))[0] as { args: unknown }).args).toBeNull();
    });

    it("reopens every stored type with zero skipped lines through an in-text redactor", async () => {
      const inText = (t: string) => t.replaceAll("cart", "[CART]");
      const a = new LocalStore({ dir, redact: inText });
      await seed(a);
      for (const e of demoScenario.events) await a.putNexusEvent(e);
      for (const act of [
        { kind: "write_outside_scope", path: "../cart/x" }, { kind: "commit", message: "cart fix" }, { kind: "other", description: "cart" },
      ] as const) await a.putApproval({ ...fx.approval, id: `apr_${act.kind}`, action: act });
      await a.appendAgentEvent(ae(0, { sessionId: "ses_all", type: "receipt", receipt: fx.receipt }));
      await a.appendAgentEvent(ae(1, { sessionId: "ses_all", type: "error", message: "cart" }));
      expect(JSON.stringify(await a.listTasks())).toContain("[CART]");
      const b = new LocalStore({ dir, redact: inText });
      expect(b.skippedLines()).toBe(0);
      expect(await dump(b)).toEqual(await dump(a));
      expect(await b.agentEvents("ses_all", 0)).toEqual(await a.agentEvents("ses_all", 0));
      expect(await b.listApprovals()).toEqual(await a.listApprovals());
      expect(await b.status()).toEqual(await a.status());
    });
  });

  describe("no ghost outbox entries", () => {
    it.skipIf(isRoot)("a failed approved decide leaves no trace, and a later rejection wins", async () => {
      const a = open();
      await a.putApproval(fx.approval);
      fs.chmodSync(file("approvals.jsonl"), 0o444);
      await expect(a.decideApproval("apr_01", "approved", by, T1)).rejects.toThrow();
      fs.chmodSync(file("approvals.jsonl"), 0o644);
      const r = await a.decideApproval("apr_01", "rejected", by, T2);
      expect([r.won, r.approval.decision]).toEqual([true, "rejected"]);
      const b = open();
      expect(b.skippedLines()).toBe(0);
      expect(b.pendingOutbox()).toEqual(a.pendingOutbox());
      expect(b.pendingOutbox().map(e => [e.op, (e.record as { decision?: string }).decision])).toEqual([["put", undefined], ["decide", "rejected"]]);
      expect((await b.getApproval("apr_01"))?.decision).toBe("rejected");
    });

    it.skipIf(isRoot)("a failed event write that is never retried leaves no outbox entry", async () => {
      const a = open();
      await a.putNexusEvent(ev("e1", T1));
      fs.chmodSync(file("events.jsonl"), 0o444);
      await expect(a.putNexusEvent(ev("e2", T2))).rejects.toThrow();
      fs.chmodSync(file("events.jsonl"), 0o644);
      const b = open();
      expect(b.skippedLines()).toBe(0);
      expect(b.pendingOutbox()).toEqual(a.pendingOutbox());
      expect(b.pendingOutbox().map(e => (e.record as { id: string }).id)).toEqual(["e1"]);
    });

    it("replay drops an outbox entry that has no journal line and heals the file", async () => {
      const a = open();
      await a.putNexusEvent(ev("e1", T1));
      fs.appendFileSync(file("outbox.jsonl"), JSON.stringify({ id: 99, table: "approvals", op: "decide", record: { id: "apr_01", decision: "approved", decidedBy: by, decidedAt: T1 } }) + "\n");
      const b = open();
      expect(b.skippedLines()).toBe(1);
      expect(b.pendingOutbox().map(e => e.table)).toEqual(["events"]);
      expect(open().skippedLines()).toBe(0);
    });

    it("a failed state write after ack cannot resurrect an acked entry", async () => {
      const a = open();
      await a.putNexusEvent(ev("e1", T1));
      await a.putNexusEvent(ev("e2", T2));
      const [first] = a.pendingOutbox();
      fs.mkdirSync(file("state.json.tmp"));   // makes the state write fail
      expect(() => a.ackOutbox([first.id], T3)).toThrow();
      expect(a.pendingOutbox().map(e => e.id)).toEqual([2]);
      expect(open().pendingOutbox().map(e => e.id)).toEqual([2]);
      expect((await a.status()).lastSyncAt).toBeUndefined();
    });
  });

  it("tracks the outbox and lastSyncAt across reopen and ack", async () => {
    const a = open();
    await a.putTask(fx.task);
    await a.putApproval(fx.approval);
    await a.decideApproval("apr_01", "approved", by, T1);
    expect((await a.status()).outboxDepth).toBe(3);
    const b = open();
    const pending = b.pendingOutbox();
    expect(pending.map(e => [e.table, e.op])).toEqual([["tasks", "put"], ["approvals", "put"], ["approvals", "decide"]]);
    b.ackOutbox(pending.slice(0, 2).map(e => e.id), T2);
    const c = open();
    expect(c.pendingOutbox().map(e => e.op)).toEqual(["decide"]);
    expect(await c.status()).toEqual({ online: true, outboxDepth: 1, lastSyncAt: T2 });
    await c.putTask({ ...fx.task, id: "t2" });
    expect(c.pendingOutbox().map(e => e.id)).toEqual([3, 4]);
  });
});
