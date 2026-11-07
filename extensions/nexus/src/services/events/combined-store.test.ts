import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fx } from "../../contracts/fixtures";
import type { ApprovalRequest, NexusEvent } from "../../contracts";
import { CombinedStore } from "./combined-store";
import { LocalStore } from "./local-store";
import type { DecidedBy } from "../../contracts";
import type { EventStore } from "./store";

const redact = (t: string) => t.replaceAll("SECRETVAL", "[R]");
const ALL = { from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z", limit: 5000 };
const by = (userId: string) => ({ via: "app" as const, userId });
const T1 = "2026-11-07T04:00:00Z", T2 = "2026-11-07T04:00:05Z";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** How one machine reaches the shared remote: it can be down, slow, or fail after N more calls. */
interface Link { down: boolean; hangMs: number; allow: number; log: string[]; delays: Record<string, number>; reject: (name: string, args: unknown[]) => Error | undefined }
const newLink = (): Link => ({ down: false, hangMs: 0, allow: Infinity, log: [], delays: {}, reject: () => undefined });

/** Wraps the shared remote store so each machine's calls can fail, hang, or be counted. */
function through(inner: EventStore, link: Link): EventStore {
  return new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== "function" || String(prop).startsWith("subscribe")) return value;
      return async (...args: unknown[]) => {
        link.log.push(String(prop));
        if (link.hangMs) await sleep(link.hangMs);
        if (link.delays[String(prop)]) await sleep(link.delays[String(prop)]);
        const refused = link.reject(String(prop), args);
        if (refused) throw refused;
        if (link.down || link.allow <= 0) throw new Error("remote down");
        link.allow--;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

let dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-combined-")); dirs.push(d); return d; };
beforeEach(() => { dirs = []; });
afterEach(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** One machine: its own local store and link, over the shared remote. */
function machine(shared: LocalStore, opts: { readBudgetMs?: number; writeBudgetMs?: number } = {}) {
  const local = new LocalStore({ dir: tmp(), redact });
  const link = newLink();
  const store = new CombinedStore({ local, remote: through(shared, link), readBudgetMs: 50, writeBudgetMs: 500, ...opts });
  return { local, link, store };
}
const sharedRemote = () => new LocalStore({ dir: tmp(), redact });
const evt = (id: string, at: string, orbit = "main"): NexusEvent => ({ ...fx.event, id, at, orbit, title: `event ${id}` });

describe("CombinedStore writes", () => {
  it("writes local first and sends to the remote in the background", async () => {
    const remote = sharedRemote();
    const m = machine(remote);
    await m.store.putTask(fx.task);
    expect(await m.local.getTask(fx.task.id)).toEqual(fx.task);   // local before the remote has been awaited
    await m.store.idle();
    expect(await remote.getTask(fx.task.id)).toEqual(fx.task);
    expect(await m.store.status()).toMatchObject({ online: true, outboxDepth: 0 });
    expect(m.local.pendingOutbox()).toEqual([]);
  });

  it("sends every record type", async () => {
    const remote = sharedRemote();
    const m = machine(remote);
    await m.store.putTask(fx.task);
    await m.store.putSession(fx.session);
    await m.store.appendAgentEvent({ sessionId: "ses_01", seq: 0, at: T1, type: "status", status: "running" });
    await m.store.putApproval(fx.approval);
    await m.store.putNexusEvent(fx.event);
    await m.store.putReview(fx.review);
    await m.store.putReceipt(fx.receipt);
    await m.store.putPlan(fx.plan);
    await m.store.idle();
    expect([await remote.listTasks(), await remote.listSessions(), await remote.agentEvents("ses_01", 0), await remote.listApprovals(), await remote.queryEvents(ALL), await remote.listReceipts()].map(l => l.length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect([(await remote.getReviewForApproval(fx.review.approvalId))?.id, (await remote.getPlan(fx.plan.id))?.id]).toEqual([fx.review.id, fx.plan.id]);
    expect(m.local.pendingOutbox()).toEqual([]);
  });

  it("with the remote down, writes stay queued, the status goes offline, and nothing is retried per write", async () => {
    const remote = sharedRemote();
    const m = machine(remote);
    const seen: string[] = [];
    m.store.subscribeStatus(s => seen.push(`${s.online}:${s.outboxDepth}`));
    m.link.down = true;
    await m.store.putTask(fx.task);
    await m.store.idle();
    expect(await m.store.status()).toMatchObject({ online: false, outboxDepth: 1 });
    await m.store.putNexusEvent(fx.event);
    await m.store.putSession(fx.session);
    await m.store.idle();
    expect(await m.store.status()).toMatchObject({ online: false, outboxDepth: 3 });
    expect(m.link.log).toEqual(["putTask"]);   // offline: later writes do not hammer the remote
    expect(await m.local.getTask(fx.task.id)).toEqual(fx.task);
    expect(await remote.listTasks()).toEqual([]);
    expect(seen).toContain("false:1");
  });

  it("redacts before queueing, so a secret never reaches the remote", async () => {
    const remote = sharedRemote();
    const m = machine(remote);
    await m.store.putTask({ ...fx.task, brief: "key SECRETVAL" });
    await m.store.idle();
    expect((await remote.getTask(fx.task.id))?.brief).toBe("key [R]");
  });
});

describe("CombinedStore reads", () => {
  it("reads the remote, including what teammates wrote, merged with local", async () => {
    const remote = sharedRemote();
    const m = machine(remote);
    await remote.putTask({ ...fx.task, id: "theirs", createdAt: "2026-11-07T03:00:00Z" });
    await remote.putNexusEvent(evt("e_remote", "2026-11-07T03:00:00Z"));
    await m.store.putTask({ ...fx.task, id: "mine", createdAt: "2026-11-07T04:00:00Z" });
    await m.store.putNexusEvent(evt("e_local", "2026-11-07T04:00:00Z"));
    await m.store.idle();
    expect((await m.store.listTasks()).map(t => t.id)).toEqual(["theirs", "mine"]);
    expect((await m.store.queryEvents(ALL)).map(e => e.id)).toEqual(["e_remote", "e_local"]);
    expect((await m.store.searchEvents("event", 10)).map(h => h.event.id).sort()).toEqual(["e_local", "e_remote"]);
    expect((await m.store.getTask("theirs"))?.id).toBe("theirs");
  });

  it("a write still waiting in the outbox is not hidden by a stale remote copy", async () => {
    const remote = sharedRemote();
    const m = machine(remote);
    await m.store.putTask(fx.task);
    await m.store.idle();
    m.link.down = true;
    await m.store.putTask({ ...fx.task, status: "done" });
    await m.store.idle();
    m.link.down = false;
    expect((await remote.getTask(fx.task.id))?.status).toBe("draft");
    // reads succeed again (which also restarts the flush); until it lands, local wins for the dirty key
    const read = await m.store.getTask(fx.task.id);
    expect(read?.status).toBe("done");
    await m.store.idle();
    expect((await remote.getTask(fx.task.id))?.status).toBe("done");
  });

  it("falls back to local inside the budget when the remote hangs, and marks it offline", async () => {
    const remote = sharedRemote();
    const m = machine(remote, { readBudgetMs: 40 });
    await m.store.putNexusEvent(fx.event);
    await m.store.idle();
    await remote.putNexusEvent(evt("only_remote", "2026-11-07T05:00:00Z"));
    m.link.hangMs = 400;
    const started = Date.now();
    const events = await m.store.queryEvents(ALL);
    expect(Date.now() - started).toBeLessThan(300);
    expect(events.map(e => e.id)).toEqual([fx.event.id]);
    expect((await m.store.status()).online).toBe(false);
  });

  it("falls back to local when the remote is down, for every read", async () => {
    const remote = sharedRemote();
    const m = machine(remote);
    await m.store.putTask(fx.task);
    await m.store.putSession(fx.session);
    await m.store.putApproval(fx.approval);
    await m.store.putReceipt(fx.receipt);
    await m.store.putReview(fx.review);
    await m.store.putPlan(fx.plan);
    await m.store.idle();
    m.link.down = true;
    expect((await m.store.getTask(fx.task.id))?.id).toBe(fx.task.id);
    expect(await m.store.listTasks()).toHaveLength(1);
    expect(await m.store.listSessions()).toHaveLength(1);
    expect((await m.store.getSession(fx.session.id))?.id).toBe(fx.session.id);
    expect(await m.store.listApprovals()).toHaveLength(1);
    expect((await m.store.getApproval(fx.approval.id))?.id).toBe(fx.approval.id);
    expect(await m.store.listReceipts()).toHaveLength(1);
    expect((await m.store.getReviewForApproval(fx.review.approvalId))?.id).toBe(fx.review.id);
    expect((await m.store.getPlan(fx.plan.id))?.id).toBe(fx.plan.id);
    expect(await m.store.agentEvents("ses_01", 0)).toEqual([]);
  });

  it("coming back online on a good read flushes what queued meanwhile", async () => {
    const remote = sharedRemote();
    const m = machine(remote);
    m.link.down = true;
    await m.store.putTask(fx.task);
    await m.store.idle();
    expect((await m.store.status()).online).toBe(false);
    m.link.down = false;
    await m.store.listTasks();   // a successful remote read
    await m.store.idle();
    expect(await m.store.status()).toMatchObject({ online: true, outboxDepth: 0 });
    expect(await remote.getTask(fx.task.id)).toEqual(fx.task);
  });
});

describe("CombinedStore.flushOutbox", () => {
  it("drains in order after the remote returns, stops at the first failure, and is idempotent", async () => {
    const remote = sharedRemote();
    const m = machine(remote);
    m.link.down = true;
    await m.store.putTask(fx.task);
    await m.store.putSession(fx.session);
    await m.store.putNexusEvent(fx.event);
    await m.store.idle();
    m.link.log.length = 0;
    m.link.down = false;
    m.link.allow = 1;   // the first send works, the second fails
    expect(await m.store.flushOutbox()).toEqual({ flushed: 1, remaining: 2 });
    expect(m.link.log).toEqual(["putTask", "putSession"]);
    expect(await m.store.status()).toMatchObject({ online: false, outboxDepth: 2 });
    expect(await remote.listSessions()).toEqual([]);   // nothing past the failure was sent
    expect(await remote.getTask(fx.task.id)).toBeDefined();

    m.link.log.length = 0;
    m.link.allow = Infinity;
    expect(await m.store.flushOutbox()).toEqual({ flushed: 2, remaining: 0 });
    expect(m.link.log).toEqual(["putSession", "putNexusEvent"]);
    expect(await m.store.status()).toMatchObject({ online: true, outboxDepth: 0 });
    expect(await m.store.flushOutbox()).toEqual({ flushed: 0, remaining: 0 });

    // a replayed queue changes nothing: the same writes again leave one of each
    m.link.down = true;
    await m.store.putNexusEvent(fx.event);   // already stored locally and remotely
    expect((await remote.queryEvents(ALL)).length).toBe(1);
  });

  it("a write the remote refuses for good is dead-lettered and the queue moves on; a transient failure still stops it", async () => {
    const remote = sharedRemote();
    const m = machine(remote);
    m.link.down = true;
    await m.store.putTask(fx.task);
    await m.store.putNexusEvent(evt("bad", "2026-11-07T03:00:00Z"));
    await m.store.putSession(fx.session);
    await m.store.idle();
    m.link.down = false;
    m.link.reject = (name, args) => name === "putNexusEvent" && (args[0] as NexusEvent).id === "bad" ? Object.assign(new Error("duplicate key SECRETROW"), { code: "23505" }) : undefined;
    expect(await m.store.flushOutbox()).toEqual({ flushed: 2, remaining: 0 });
    expect(m.store.deadLetters()).toMatchObject([{ table: "events", op: "put", key: "bad", reason: "23505" }]);
    expect(JSON.stringify(m.store.deadLetters())).not.toContain("SECRETROW");
    expect(await m.store.status()).toMatchObject({ online: true, outboxDepth: 0 });
    expect(await remote.getSession(fx.session.id)).toBeDefined();

    m.link.reject = () => Object.assign(new Error("reset"), { code: "ECONNRESET" });
    await m.store.putTask({ ...fx.task, id: "later" });
    expect(await m.store.flushOutbox()).toEqual({ flushed: 0, remaining: 1 });
    expect(m.store.deadLetters()).toHaveLength(1);
    expect((await m.store.status()).online).toBe(false);
  });

  it("concurrent calls share one run", async () => {
    const remote = sharedRemote();
    const m = machine(remote);
    m.link.down = true;
    await m.store.putTask(fx.task);
    await m.store.idle();
    m.link.down = false;
    m.link.log.length = 0;
    const [a, b] = await Promise.all([m.store.flushOutbox(), m.store.flushOutbox()]);
    expect([a, b]).toEqual([{ flushed: 1, remaining: 0 }, { flushed: 1, remaining: 0 }]);
    expect(m.link.log).toEqual(["putTask"]);
  });

  it("survives a restart: a reopened local outbox flushes", async () => {
    const remote = sharedRemote();
    const dir = tmp();
    const link = newLink();
    link.down = true;
    const first = new CombinedStore({ local: new LocalStore({ dir, redact }), remote: through(remote, link), readBudgetMs: 50 });
    await first.putTask(fx.task);
    await first.idle();
    link.down = false;
    const second = new CombinedStore({ local: new LocalStore({ dir, redact }), remote: through(remote, link), readBudgetMs: 50 });
    expect(await second.flushOutbox()).toEqual({ flushed: 1, remaining: 0 });
    expect(await remote.getTask(fx.task.id)).toEqual(fx.task);
  });
});

describe("CombinedStore approvals", () => {
  const approval: ApprovalRequest = fx.approval;

  it("online, the decision is made remotely first and mirrored locally without being queued again", async () => {
    const remote = sharedRemote();
    const m = machine(remote);
    await m.store.putApproval(approval);   // not yet flushed: decide must send it first
    const r = await m.store.decideApproval(approval.id, "approved", by("U_A"), T1);
    expect(r).toMatchObject({ won: true, approval: { decision: "approved", decidedBy: by("U_A") } });
    expect(await remote.getApproval(approval.id)).toMatchObject({ decision: "approved" });
    expect(await m.local.getApproval(approval.id)).toMatchObject({ decision: "approved", decidedBy: by("U_A") });
    expect(m.local.pendingOutbox()).toEqual([]);
  });

  it("first answer wins across machines, and the loser's local copy shows the winner", async () => {
    const remote = sharedRemote();
    const a = machine(remote), b = machine(remote);
    await a.store.putApproval(approval);
    await a.store.idle();
    await b.store.putApproval(approval);   // the teammate's copy
    await b.store.idle();
    const seenByB: string[] = [];
    b.store.subscribeApprovals(x => seenByB.push(`${x.decision}:${x.decidedBy?.userId}`));
    const win = await a.store.decideApproval(approval.id, "approved", by("U_A"), T1);
    const lose = await b.store.decideApproval(approval.id, "rejected", by("U_B"), T2);
    expect([win.won, lose.won]).toEqual([true, false]);
    expect(lose.approval).toMatchObject({ decision: "approved", decidedBy: by("U_A") });
    expect(await b.local.getApproval(approval.id)).toMatchObject({ decision: "approved", decidedBy: by("U_A") });
    expect(b.local.pendingOutbox()).toEqual([]);
    expect(seenByB).toEqual(["approved:U_A"]);
  });

  it("offline, it decides locally and queues; a decision that loses remotely is corrected locally and published", async () => {
    const remote = sharedRemote();
    const a = machine(remote), b = machine(remote);
    await a.store.putApproval(approval);
    await a.store.idle();
    await b.store.putApproval(approval);
    await b.store.idle();

    a.link.down = true;
    const seenByA: string[] = [];
    a.store.subscribeApprovals(x => seenByA.push(`${x.decision}:${x.decidedBy?.userId}`));
    const offline = await a.store.decideApproval(approval.id, "approved", by("U_A"), T2);
    expect(offline).toMatchObject({ won: true, approval: { decision: "approved" } });
    expect(await a.store.status()).toMatchObject({ online: false, outboxDepth: 1 });
    seenByA.length = 0;

    const winner = await b.store.decideApproval(approval.id, "rejected", by("U_B"), T1);   // the other machine answers first
    expect(winner.won).toBe(true);

    a.link.down = false;
    expect(await a.store.flushOutbox()).toEqual({ flushed: 1, remaining: 0 });
    expect(seenByA).toEqual(["rejected:U_B"]);
    a.link.down = true;   // read the local copy only
    expect(await a.store.getApproval(approval.id)).toMatchObject({ decision: "rejected", decidedBy: by("U_B") });
    expect((await a.store.listApprovals())[0]).toMatchObject({ decision: "rejected" });
    expect(await remote.getApproval(approval.id)).toMatchObject({ decision: "rejected", decidedBy: by("U_B") });
  });

  it("an offline decision that wins remotely is left as is", async () => {
    const remote = sharedRemote();
    const a = machine(remote);
    await a.store.putApproval(approval);
    await a.store.idle();
    a.link.down = true;
    await a.store.decideApproval(approval.id, "approved", by("U_A"), T1);
    a.link.down = false;
    const seen: string[] = [];
    a.store.subscribeApprovals(x => seen.push(`${x.decision}`));
    expect(await a.store.flushOutbox()).toEqual({ flushed: 1, remaining: 0 });
    expect(seen).toEqual([]);
    expect(await remote.getApproval(approval.id)).toMatchObject({ decision: "approved", decidedBy: by("U_A") });
  });

  it("a slow read never turns the next decision local-only (the probe)", async () => {
    const remote = sharedRemote();
    const a = machine(remote, { readBudgetMs: 50 }), b = machine(remote);
    await a.store.putApproval(approval);
    await a.store.idle();
    await b.store.putApproval(approval);
    await b.store.idle();
    expect((await b.store.decideApproval(approval.id, "rejected", by("U_B"), T1)).won).toBe(true);
    a.link.delays.getApproval = 60;   // A's read misses its 50 ms budget
    await a.store.getApproval(approval.id);
    expect((await a.store.status()).online).toBe(false);
    a.link.delays.getApproval = 0;
    const r = await a.store.decideApproval(approval.id, "approved", by("U_A"), T2);
    expect(r).toMatchObject({ won: false, approval: { decision: "rejected", decidedBy: by("U_B") } });
    expect(await remote.getApproval(approval.id)).toMatchObject({ decision: "rejected" });
  });

  it("a decision does not wait for an unrelated outbox backlog", async () => {
    const remote = sharedRemote();
    const m = machine(remote);
    m.link.down = true;
    for (let i = 0; i < 40; i++) await m.store.putNexusEvent(evt(`bk${i}`, "2026-11-07T03:00:00Z"));
    await m.store.putApproval(approval);
    m.link.down = false;
    m.link.delays.putNexusEvent = 30;   // draining the backlog would take over a second
    const started = Date.now();
    const r = await m.store.decideApproval(approval.id, "approved", by("U_A"), T1);
    expect(r.won).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
    expect(await remote.getApproval(approval.id)).toMatchObject({ decision: "approved" });
  });

  it("mirroring a decision acks only its own outbox entry: concurrent writes still reach the remote", async () => {
    const remote = sharedRemote();
    class SlowLocal extends LocalStore {
      override async decideApproval(id: string, d: "approved" | "rejected", by2: DecidedBy, at: string) {
        const r = await super.decideApproval(id, d, by2, at);
        await sleep(40);   // the window in which other callers write
        return r;
      }
    }
    const local = new SlowLocal({ dir: tmp(), redact });
    const link = newLink();
    const store = new CombinedStore({ local, remote: through(remote, link), readBudgetMs: 50, writeBudgetMs: 500 });
    await store.putApproval(approval);
    await store.idle();
    link.reject = name => name === "putNexusEvent" ? Object.assign(new Error("reset"), { code: "ECONNRESET" }) : undefined;   // the events stay queued while the mirror runs
    const deciding = store.decideApproval(approval.id, "approved", by("U_A"), T1);
    await sleep(15);
    for (let i = 0; i < 50; i++) await store.putNexusEvent(evt(`c${i}`, "2026-11-07T03:00:00Z"));
    await deciding;
    expect(local.pendingOutbox()).toHaveLength(50);
    link.reject = () => undefined;
    await store.flushOutbox();
    await store.idle();
    expect((await remote.queryEvents(ALL)).length).toBe(50);
    expect(local.pendingOutbox()).toEqual([]);
  });

  it("a second offline click after a correction reports the corrected winner", async () => {
    const remote = sharedRemote();
    const a = machine(remote), b = machine(remote);
    for (const m of [a, b]) { await m.store.putApproval(approval); await m.store.idle(); }
    a.link.down = true;
    await a.store.decideApproval(approval.id, "approved", by("U_A"), T2);
    await b.store.decideApproval(approval.id, "rejected", by("U_B"), T1);
    a.link.down = false;
    await a.store.flushOutbox();
    a.link.down = true;
    const again = await a.store.decideApproval(approval.id, "approved", by("U_A"), T2);
    expect(again).toMatchObject({ won: false, approval: { decision: "rejected", decidedBy: by("U_B") } });
  });

  it("with the remote down at decision time it decides locally and queues", async () => {
    const remote = sharedRemote();
    const m = machine(remote);
    await m.store.putApproval(approval);
    await m.store.idle();
    m.link.down = true;
    const r = await m.store.decideApproval(approval.id, "rejected", by("U_A"), T1);
    expect(r.won).toBe(true);
    expect((await m.store.status())).toMatchObject({ online: false, outboxDepth: 1 });
    await expect(m.store.decideApproval("unknown", "approved", by("U_A"), T1)).rejects.toThrow(/unknown approval/);
  });
});
