import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fx } from "../../contracts/fixtures";
import type { ApprovalRequest, NexusEvent } from "../../contracts";
import { BridgeError } from "../../bridge/types";
import { ApprovalOfflineError, ApprovalRefusedError, CombinedStore } from "./combined-store";
import type { DeadLetter, DecisionOverridden } from "./combined-store";
import { ApprovalUnparseableError } from "./tiger-store";
import { LocalStore } from "./local-store";
import type { AgentSession, DecidedBy } from "../../contracts";
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
function machine(shared: LocalStore, opts: { readBudgetMs?: number; writeBudgetMs?: number; decideBudgetMs?: number; machineId?: string } = {}) {
  const local = new LocalStore({ dir: tmp(), redact });
  const link = newLink();
  const store = new CombinedStore({ machineId: "m_adrian", local, remote: through(shared, link), readBudgetMs: 50, writeBudgetMs: 500, ...opts });
  return { local, link, store };
}
/** The shared database as a test double: a LocalStore plus what TigerStore adds for owner decisions, and a switch to make an approval's row unparseable. */
type SharedRemote = LocalStore & { overrideDecision: (id: string, d: "approved" | "rejected", by: DecidedBy, at: string) => Promise<ApprovalRequest>; overrides: string[]; unparseable: Set<string> };
function sharedRemote(): SharedRemote {
  const inner = new LocalStore({ dir: tmp(), redact });
  const overlay = new Map<string, ApprovalRequest>();
  const extra = {
    overrides: [] as string[],
    unparseable: new Set<string>(),
    async overrideDecision(id: string, decision: "approved" | "rejected", decidedBy: DecidedBy, decidedAt: string) {
      const current = overlay.get(id) ?? (await inner.getApproval(id));
      if (!current) throw new Error(`unknown approval ${id}`);
      const next = { ...current, decision, decidedBy, decidedAt };
      overlay.set(id, next);
      extra.overrides.push(id);
      return next;
    },
    async getApproval(id: string) { return overlay.get(id) ?? inner.getApproval(id); },
    async listApprovals() { return (await inner.listApprovals()).map(a => overlay.get(a.id) ?? a); },
    async decideApproval(id: string, d: "approved" | "rejected", by2: DecidedBy, at: string) {
      if (extra.unparseable.has(id)) throw new ApprovalUnparseableError(`approval ${id} exists but its row does not parse`);
      const over = overlay.get(id);
      if (over) return { approval: over, won: false };
      return inner.decideApproval(id, d, by2, at);
    },
  };
  return new Proxy(inner, {
    get(target, prop) {
      if (prop in extra) return (extra as Record<string | symbol, unknown>)[prop];
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as SharedRemote;
}
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
    const first = new CombinedStore({ machineId: "m_adrian", local: new LocalStore({ dir, redact }), remote: through(remote, link), readBudgetMs: 50 });
    await first.putTask(fx.task);
    await first.idle();
    link.down = false;
    const second = new CombinedStore({ machineId: "m_adrian", local: new LocalStore({ dir, redact }), remote: through(remote, link), readBudgetMs: 50 });
    expect(await second.flushOutbox()).toEqual({ flushed: 1, remaining: 0 });
    expect(await remote.getTask(fx.task.id)).toEqual(fx.task);
  });
});

describe("CombinedStore approvals", () => {
  const approval: ApprovalRequest = fx.approval;
  const sessionOf = (machineId: string): AgentSession => ({ ...fx.session, machineId });
  const until = async (cond: () => Promise<boolean>, ms = 1500) => { const end = Date.now() + ms; while (!(await cond())) { if (Date.now() > end) throw new Error("condition not reached"); await sleep(5); } };

  /** Two machines, `owner` running the session, both holding the session and approval, everything flushed. */
  async function pair(remote: SharedRemote, owner: "a" | "b", opts: { a?: Parameters<typeof machine>[1]; b?: Parameters<typeof machine>[1] } = {}) {
    const a = machine(remote, { machineId: "m_a", ...opts.a }), b = machine(remote, { machineId: "m_b", ...opts.b });
    for (const m of [a, b]) {
      await m.store.putSession(sessionOf(owner === "a" ? "m_a" : "m_b"));
      await m.store.putApproval(approval);
      await m.store.idle();
    }
    return { a, b };
  }

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
    const { a, b } = await pair(remote, "a");
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

  it("a slow read never turns the next decision local-only (the probe)", async () => {
    const remote = sharedRemote();
    const { a, b } = await pair(remote, "a", { a: { readBudgetMs: 50 } });
    expect((await b.store.decideApproval(approval.id, "rejected", by("U_B"), T1)).won).toBe(true);
    a.link.delays.getApproval = 60;   // A's read misses its 50 ms budget
    await a.store.getApproval(approval.id);
    expect((await a.store.status()).online).toBe(false);
    a.link.delays.getApproval = 0;
    const r = await a.store.decideApproval(approval.id, "approved", by("U_A"), T2);
    expect(r).toMatchObject({ won: false, approval: { decision: "rejected", decidedBy: by("U_B") } });
    expect(await remote.getApproval(approval.id)).toMatchObject({ decision: "rejected" });
  });

  it("a successful online decision restarts the backlog flush", async () => {
    const remote = sharedRemote();
    const m = machine(remote);
    m.link.down = true;
    for (let i = 0; i < 3; i++) await m.store.putNexusEvent(evt(`bk${i}`, "2026-11-07T03:00:00Z"));
    await m.store.putApproval(approval);
    m.link.down = false;   // the cached flag still says offline, so nothing has been sent
    expect((await remote.queryEvents(ALL)).length).toBe(0);
    await m.store.decideApproval(approval.id, "approved", by("U_A"), T1);
    await m.store.idle();
    expect((await remote.queryEvents(ALL)).length).toBe(3);
    expect(m.local.pendingOutbox()).toEqual([]);
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
    const store = new CombinedStore({ machineId: "m_adrian", local, remote: through(remote, link), readBudgetMs: 50, writeBudgetMs: 500 });
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

  describe("when the shared store cannot answer", () => {
    it("the owner decides locally (its agent gets won:true) and the decision reaches Tiger when it flushes", async () => {
      const remote = sharedRemote();
      const { a } = await pair(remote, "a");
      a.link.down = true;
      const r = await a.store.decideApproval(approval.id, "approved", by("U_A"), T1);
      expect(r).toMatchObject({ won: true, approval: { decision: "approved" } });
      expect(await a.store.status()).toMatchObject({ online: false, outboxDepth: 1 });
      expect((await remote.getApproval(approval.id))?.decision).toBeUndefined();
      a.link.down = false;
      expect(await a.store.flushOutbox()).toEqual({ flushed: 1, remaining: 0 });
      expect(await remote.getApproval(approval.id)).toMatchObject({ decision: "approved", decidedBy: by("U_A") });
      expect(remote.overrides).toEqual([]);   // it won, so no override
    });

    it("a non-owner decides nothing: it gets the offline error and no local decision or queued entry", async () => {
      const remote = sharedRemote();
      const { b } = await pair(remote, "a");   // b does not run the session
      b.link.down = true;
      const err = await b.store.decideApproval(approval.id, "approved", by("U_B"), T1).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApprovalOfflineError);
      expect(err).toMatchObject({ code: "offline", message: "Could not reach the shared store in time; the decision may still apply. Only the machine running this agent can decide while offline." });
      expect(err).toBeInstanceOf(BridgeError);
      expect((await b.local.getApproval(approval.id))?.decision).toBeUndefined();
      expect(b.local.pendingOutbox()).toEqual([]);
    });

    it("a fast refusal while online is not called 'unreachable'", async () => {
      const remote = sharedRemote();
      const { b } = await pair(remote, "a");
      b.link.reject = name => name === "decideApproval" ? Object.assign(new Error("duplicate key"), { code: "23505" }) : undefined;
      const err = await b.store.decideApproval(approval.id, "approved", by("U_B"), T1).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BridgeError);
      expect(err).toMatchObject({ code: "conflict", message: "The shared store refused this decision." });
      expect((await b.store.status()).online).toBe(true);
    });

    it("a machine id that cannot tell machines apart never owns anything", async () => {
      for (const id of ["", "   ", "someValue.machineId"]) {
        const remote = sharedRemote();
        const m = machine(remote, { machineId: id });
        await m.store.putSession(sessionOf(id));   // the session carries the same unusable id
        await m.store.putApproval(approval);
        await m.store.idle();
        m.link.down = true;
        await expect(m.store.decideApproval(approval.id, "approved", by("U_A"), T1), `machine id ${JSON.stringify(id)}`).rejects.toBeInstanceOf(ApprovalOfflineError);
        expect((await m.local.getApproval(approval.id))?.decision).toBeUndefined();
      }
      // a usable machine does not own a session recorded with an unusable id either
      const remote = sharedRemote();
      const m = machine(remote, { machineId: "m_real" });
      await m.store.putSession(sessionOf("someValue.machineId"));
      await m.store.putApproval(approval);
      await m.store.idle();
      m.link.down = true;
      await expect(m.store.decideApproval(approval.id, "approved", by("U_A"), T1)).rejects.toBeInstanceOf(ApprovalOfflineError);
    });

    it("a stale second click by the owner is not a win and never writes to Tiger", async () => {
      const remote = sharedRemote();
      const { a } = await pair(remote, "a");
      const sent: string[] = [];
      a.link.reject = (name, args) => { if (name === "decideApproval" || name === "overrideDecision") sent.push(`${name}:${String(args[1])}`); return undefined; };
      a.link.down = true;
      expect(await a.store.decideApproval(approval.id, "approved", by("U_A"), T1)).toMatchObject({ won: true });
      a.link.down = false;   // back online, nothing flushed yet
      const stale = await a.store.decideApproval(approval.id, "rejected", by("U_A"), T2);
      expect(stale).toMatchObject({ won: false, approval: { decision: "approved" } });
      await a.store.flushOutbox();
      expect(sent.filter(x => !x.endsWith(":approved"))).toEqual([]);   // "rejected" was never attempted anywhere
      expect(sent).toContain("decideApproval:approved");
      expect(await remote.getApproval(approval.id)).toMatchObject({ decision: "approved" });
    });

    it("a non-owner whose decision was overridden mirrors the owner's decision and never overrides back", async () => {
      const remote = sharedRemote();
      const { a, b } = await pair(remote, "a");
      a.link.down = true;
      await a.store.decideApproval(approval.id, "approved", by("U_A"), T2);
      await b.store.decideApproval(approval.id, "rejected", by("U_B"), T1);
      a.link.down = false;
      await a.store.flushOutbox();
      expect(remote.overrides).toEqual([approval.id]);
      const again = await b.store.decideApproval(approval.id, "rejected", by("U_B"), T2);
      expect(again).toMatchObject({ won: false, approval: { decision: "approved", decidedBy: by("U_A") } });
      expect(await b.store.getApproval(approval.id)).toMatchObject({ decision: "approved" });
      expect(remote.overrides).toEqual([approval.id]);   // still just the owner's one
      expect(await remote.getApproval(approval.id)).toMatchObject({ decision: "approved" });
    });

    it("an owner override leaves a trace with ids and decisions only", async () => {
      const remote = sharedRemote();
      const { a, b } = await pair(remote, "a");
      const seen: DecisionOverridden[] = [];
      a.store.onOverride(o => seen.push(o));
      a.link.down = true;
      await a.store.decideApproval(approval.id, "approved", by("U_A"), T2);
      await b.store.decideApproval(approval.id, "rejected", by("U_B"), T1);
      a.link.down = false;
      await a.store.flushOutbox();
      expect(seen).toHaveLength(1);
      expect(Object.keys(seen[0]).sort()).toEqual(["approvalId", "at", "from", "to"]);
      expect(seen[0]).toMatchObject({ approvalId: approval.id, from: "rejected", to: "approved" });
    });

    it("an unknown session, or an unknown approval, means not the owner", async () => {
      const remote = sharedRemote();
      const m = machine(remote);
      await m.store.putApproval(approval);   // no session anywhere
      await m.store.idle();
      m.link.down = true;
      await expect(m.store.decideApproval(approval.id, "approved", by("U_A"), T1)).rejects.toBeInstanceOf(ApprovalOfflineError);
      await expect(m.store.decideApproval("nope", "approved", by("U_A"), T1)).rejects.toBeInstanceOf(ApprovalOfflineError);
    });

    it("a row that exists but does not parse: the non-owner refuses, the owner decides locally", async () => {
      const remote = sharedRemote();
      const { a, b } = await pair(remote, "a");
      remote.unparseable.add(approval.id);
      await expect(b.store.decideApproval(approval.id, "approved", by("U_B"), T1)).rejects.toBeInstanceOf(ApprovalRefusedError);
      expect((await b.local.getApproval(approval.id))?.decision).toBeUndefined();
      expect(await a.store.decideApproval(approval.id, "approved", by("U_A"), T1)).toMatchObject({ won: true });
    });

    it("the owner's queued decision that loses is written over Tiger's, so everyone converges on what the agent did", async () => {
      const remote = sharedRemote();
      const { a, b } = await pair(remote, "a");
      a.link.down = true;
      await a.store.decideApproval(approval.id, "approved", by("U_A"), T2);
      expect((await b.store.decideApproval(approval.id, "rejected", by("U_B"), T1)).won).toBe(true);   // the teammate reached Tiger first
      a.link.down = false;
      expect(await a.store.flushOutbox()).toEqual({ flushed: 1, remaining: 0 });
      expect(remote.overrides).toEqual([approval.id]);
      expect(await remote.getApproval(approval.id)).toMatchObject({ decision: "approved", decidedBy: by("U_A") });
      expect(await a.local.getApproval(approval.id)).toMatchObject({ decision: "approved" });
      expect(a.local.pendingOutbox()).toEqual([]);
    });

    it("an owner decision that matches Tiger's is not overridden", async () => {
      const remote = sharedRemote();
      const { a, b } = await pair(remote, "a");
      a.link.down = true;
      await a.store.decideApproval(approval.id, "approved", by("U_A"), T2);
      await b.store.decideApproval(approval.id, "approved", by("U_B"), T1);
      a.link.down = false;
      await a.store.flushOutbox();
      expect(remote.overrides).toEqual([]);
      expect(a.local.pendingOutbox()).toEqual([]);
    });

    it("a second offline click by the owner reports the existing local decision, not a second win", async () => {
      const remote = sharedRemote();
      const { a } = await pair(remote, "a");
      a.link.down = true;
      await a.store.decideApproval(approval.id, "approved", by("U_A"), T1);
      const again = await a.store.decideApproval(approval.id, "rejected", by("U_A"), T2);
      expect(again).toMatchObject({ won: false, approval: { decision: "approved" } });
    });

    for (const owner of ["a", "b"] as const) {
      it(`slow but reachable (A's decide 150 ms vs a 50 ms budget, B's at 80 ms), owner ${owner}: Tiger ends equal to the owner's local decision`, async () => {
        const remote = sharedRemote();
        const { a, b } = await pair(remote, owner, { a: { decideBudgetMs: 50 } });
        a.link.delays.decideApproval = 150;
        const aDecides = a.store.decideApproval(approval.id, "approved", by("U_A"), T1).then(r => r, (e: unknown) => e);
        await sleep(80);
        const bResult = await b.store.decideApproval(approval.id, "rejected", by("U_B"), T2);
        const aResult = await aDecides;
        const owned = owner === "a" ? a : b;
        const ownerResult = owner === "a" ? aResult : bResult;
        expect(ownerResult).toMatchObject({ won: true });   // the owner's agent acts on exactly one decision
        if (owner === "b") expect(aResult).toBeInstanceOf(ApprovalOfflineError);
        // the late UPDATE settles on its own: no flush is triggered
        await until(async () => (await owned.local.getApproval(approval.id))?.decision === (await remote.getApproval(approval.id))?.decision && owned.local.pendingOutbox().length === 0);
        const ownerLocal = await owned.local.getApproval(approval.id);
        expect(await remote.getApproval(approval.id)).toMatchObject({ decision: ownerLocal?.decision });
        expect(ownerLocal?.decision).toBe(owner === "a" ? "approved" : "rejected");
        expect(remote.overrides).toEqual(owner === "a" ? [approval.id] : []);   // override only when the owner lost
        if (owner === "b") {   // the non-owner's late loss is mirrored locally (other machines learn of an override through the L2-11 sync)
          await until(async () => (await a.local.getApproval(approval.id))?.decision === "rejected");
          expect(a.local.pendingOutbox()).toEqual([]);
        }
      });
    }
  });

  describe("dead letters", () => {
    it("tells the listener about a dead-lettered approval put and decision; a code-less refusal is 'refused'", async () => {
      const remote = sharedRemote();
      const m = machine(remote);
      const seen: DeadLetter[] = [];
      m.store.onDeadLetter(l => seen.push(l));
      m.link.down = true;
      await m.store.putSession(sessionOf("m_adrian"));
      await m.store.putApproval(approval);
      await m.store.decideApproval(approval.id, "approved", by("U_A"), T1);
      await m.store.idle();
      m.link.down = false;
      m.link.reject = name => name === "putApproval" ? Object.assign(new Error("value too long"), { code: "22001" }) : name === "decideApproval" ? new Error("unknown approval apr_01") : undefined;
      await m.store.flushOutbox();
      expect(seen.map(l => [l.table, l.op, l.key, l.reason])).toEqual([["approvals", "put", approval.id, "22001"], ["approvals", "decide", approval.id, "refused"]]);
      expect(JSON.stringify(seen)).not.toContain("value too long");
    });
  });
});
