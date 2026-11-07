import { describe, expect, it } from "vitest";
import { fx } from "../../contracts/fixtures";
import { demoScenario } from "../../contracts/fixtures/scenario";
import { FakeEventStore } from "./fake-store";

const by = { via: "app" as const, userId: "U_ADRIAN" };

describe("FakeEventStore", () => {
  it("putApproval never erases a decision", async () => {
    const s = new FakeEventStore();
    await s.decideApproval("apr_01", "approved", by, "2026-11-07T04:00:00Z");
    const seen: string[] = [];
    s.subscribeApprovals(a => seen.push(a.id));
    await s.putApproval(fx.approval);   // stale undecided copy
    expect((await s.getApproval("apr_01"))?.decision).toBe("approved");
    expect(seen).toEqual([]);
  });

  it("putApproval cannot set a decision", async () => {
    const s = new FakeEventStore({ seed: false });
    const decided = { ...fx.approval, decision: "approved" as const, decidedBy: by, decidedAt: "2026-11-07T04:00:00Z" };
    await s.putApproval(decided);   // first insert
    const stored = (await s.getApproval(fx.approval.id))!;
    expect([stored.decision, stored.decidedBy, stored.decidedAt]).toEqual([undefined, undefined, undefined]);
    await s.putApproval(decided);   // over an undecided record
    expect((await s.getApproval(fx.approval.id))?.decision).toBeUndefined();
    const first = await s.decideApproval(fx.approval.id, "rejected", by, "t1");
    expect(first.won).toBe(true);   // the conditional path is still open
  });

  it("putApproval cannot change a decision but still updates other fields", async () => {
    const s = new FakeEventStore({ seed: false });
    await s.putApproval(fx.approval);
    await s.decideApproval(fx.approval.id, "approved", by, "t1");
    const other = { via: "slack" as const, userId: "U_OTHER" };
    await s.putApproval({ ...fx.approval, decision: "rejected", decidedBy: other, decidedAt: "t2", slackMessage: { channelId: "C1", ts: "1.2" } });
    const stored = (await s.getApproval(fx.approval.id))!;
    expect([stored.decision, stored.decidedBy, stored.decidedAt]).toEqual(["approved", by, "t1"]);
    expect(stored.slackMessage).toEqual({ channelId: "C1", ts: "1.2" });
  });

  it("does not alias the caller's decidedBy", async () => {
    const s = new FakeEventStore({ seed: false });
    await s.putApproval(fx.approval);
    const mine = { via: "app" as const, userId: "U_ME" };
    await s.decideApproval(fx.approval.id, "approved", mine, "t1");
    mine.userId = "U_TAMPERED";
    expect((await s.getApproval(fx.approval.id))?.decidedBy?.userId).toBe("U_ME");
  });

  it("first decision wins", async () => {
    const s = new FakeEventStore();
    const a = await s.decideApproval("apr_01", "approved", by, "t1");
    const b = await s.decideApproval("apr_01", "rejected", by, "t2");
    expect([a.won, b.won, b.approval.decision]).toEqual([true, false, "approved"]);
  });

  it("isolates callers from the store and the fixture", async () => {
    const s = new FakeEventStore();
    const t = (await s.getTask("task_01"))!;
    t.title = "mutated";
    (await s.listTasks())[0].title = "mutated";
    expect((await s.getTask("task_01"))?.title).toBe(fx.task.title);
    const input = { ...fx.task, id: "task_x" };
    await s.putTask(input);
    input.title = "changed after put";
    expect((await s.getTask("task_x"))?.title).toBe(fx.task.title);
    expect(demoScenario.task.title).toBe(fx.task.title);
  });

  it("putNexusEvent is append-only and silent on duplicates", async () => {
    const s = new FakeEventStore({ seed: false });
    const seen: string[] = [];
    s.subscribeEvents(e => seen.push(e.title));
    await s.putNexusEvent(fx.event);
    await s.putNexusEvent({ ...fx.event, title: "overwrite attempt" });
    const hits = await s.searchEvents("add cart", 10);
    expect(hits.map(h => h.event.title)).toEqual(["add cart module"]);
    expect(seen).toEqual(["add cart module"]);
  });

  it("a throwing subscriber does not break writes or starve others", async () => {
    const s = new FakeEventStore({ seed: false });
    const seen: string[] = [];
    s.subscribeEvents(() => { throw new Error("boom"); });
    s.subscribeEvents(e => seen.push(e.id));
    s.subscribeApprovals(() => { throw new Error("boom"); });
    s.subscribeApprovals(a => seen.push(a.id));
    s.subscribeStatus(() => { throw new Error("boom"); });
    s.subscribeStatus(st => seen.push(String(st.outboxDepth)));
    await s.putNexusEvent(fx.event);
    await s.putApproval(fx.approval);
    s.setStatus({ outboxDepth: 3 });
    expect(seen).toEqual([fx.event.id, fx.approval.id, "3"]);
  });

  it("unsubscribe stops delivery", async () => {
    const s = new FakeEventStore({ seed: false });
    const seen: string[] = [];
    const off = s.subscribeEvents(e => seen.push(e.id));
    off();
    await s.putNexusEvent(fx.event);
    expect(seen).toEqual([]);
  });
});
