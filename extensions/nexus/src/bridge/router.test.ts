import { describe, expect, it } from "vitest";
import { fx } from "../contracts/fixtures";
import type { AgentEvent } from "../contracts";
import { NexusBridgeRouter } from "./router";
import type { RouterOptions, WebviewTransport } from "./router";
import { BridgeError } from "./types";

type Posted = { t: string; id: string; ok?: boolean; body: { seq?: number; args?: unknown; machineId?: string }; error: { code: string; message: string } };
const tick = () => new Promise<void>(r => setTimeout(r, 0));
const toolCall = (seq: number, args: unknown): AgentEvent => ({ sessionId: "s1", seq, at: fx.task.createdAt, type: "tool_call", tool: "x", args });
const agentEvt = (seq: number): AgentEvent => ({ sessionId: "s1", seq, at: fx.task.createdAt, type: "message", text: `m${seq}` });

/** One fake webview. */
function webview(postResult: () => unknown = () => Promise.resolve(true)) {
  const posted: Posted[] = [];
  const msg = new Set<(m: unknown) => void>();
  const disp = new Set<() => void>();
  const vis = new Set<(v: boolean) => void>();
  const transport: WebviewTransport = {
    post: m => { posted.push(m as Posted); return postResult(); },
    onMessage: cb => { msg.add(cb); return { dispose: () => { msg.delete(cb); } }; },
    onDidDispose: cb => { disp.add(cb); return { dispose: () => { disp.delete(cb); } }; },
    onDidChangeVisibility: cb => { vis.add(cb); return { dispose: () => { vis.delete(cb); } }; },
  };
  return {
    transport, posted, msg,
    // postMessage delivers JSON, so round-trip what the webview sends too.
    send: async (m: unknown) => { for (const l of [...msg]) l(JSON.parse(JSON.stringify(m))); await tick(); },
    close: () => { for (const l of [...disp]) l(); },
    setVisible: (v: boolean) => { for (const l of [...vis]) l(v); },
  };
}

function setup(containsSecret: (v: unknown) => boolean = () => false, extra: Partial<RouterOptions> = {}) {
  const logs: unknown[][] = [];
  const router = new NexusBridgeRouter({ containsSecret, log: (...a) => { logs.push(a); }, ...extra });
  const w = webview();
  const attached = router.attach(w.transport);
  return { router, logs, attached, ...w, webview };
}

describe("NexusBridgeRouter requests", () => {
  it("answers a valid request with a validated response", async () => {
    const t = setup();
    t.router.handle("app.ping", () => ({ pong: true, machineId: "m1", tPlus: "T+01" }));
    await t.send({ t: "req", id: "1", name: "app.ping", body: {} });
    expect(t.posted).toEqual([{ t: "res", id: "1", ok: true, body: { pong: true, machineId: "m1", tPlus: "T+01" } }]);
  });

  it("answers invalid_request for a bad body and never calls the handler", async () => {
    const t = setup();
    let called = false;
    t.router.handle("accounts.test", () => { called = true; return fx.providerAccounts[0]; });
    await t.send({ t: "req", id: "1", name: "accounts.test", body: { nope: 1 } });
    expect(called).toBe(false);
    expect(t.posted[0]).toMatchObject({ t: "res", id: "1", ok: false, error: { code: "invalid_request" } });
  });

  it("drops and logs names outside the maps, answers not_found for known unregistered names", async () => {
    const t = setup();
    await t.send({ t: "req", id: "1", name: "no.such", body: {} });
    await t.send({ t: "sub", id: "2", name: "no.such.sub", body: {} });
    await t.send({ t: "req", id: "3", name: "constructor", body: {} });
    expect(t.posted).toEqual([]);
    expect(t.logs).toHaveLength(3);
    await t.send({ t: "req", id: "4", name: "app.ping", body: {} });
    expect(t.posted).toEqual([{ t: "res", id: "4", ok: false, error: { code: "not_found", message: "no handler for app.ping" } }]);
  });

  it("drops malformed envelopes and webview-sent res/evt", async () => {
    const t = setup();
    await t.send({ nonsense: true });
    await t.send({ t: "res", id: "1", ok: true, body: {} });
    expect(t.posted).toEqual([]);
  });

  it("maps handler errors: BridgeError code kept, anything else generic internal", async () => {
    const t = setup();
    t.router.handle("app.ping", () => { throw new BridgeError("unauthorized", "sign in first"); });
    t.router.handle("store.status", () => { throw new Error("pg://user:hunter2@host exploded"); });
    await t.send({ t: "req", id: "1", name: "app.ping", body: {} });
    await t.send({ t: "req", id: "2", name: "store.status", body: {} });
    expect(t.posted[0].error).toEqual({ code: "unauthorized", message: "sign in first" });
    expect(t.posted[1].error).toEqual({ code: "internal", message: "internal error" });
    expect(JSON.stringify(t.posted)).not.toContain("hunter2");
  });

  it("logs unflagged detail, but never a flagged value or its cause chain", async () => {
    const t = setup(v => JSON.stringify(v).includes("hunter2"));
    t.router.handle("store.status", () => { throw new Error("exploded in a harmless way"); });
    t.router.handle("app.ping", () => { throw new Error("outer", { cause: new Error("pg://user:hunter2@host") }); });
    await t.send({ t: "req", id: "1", name: "store.status", body: {} });
    await t.send({ t: "req", id: "2", name: "app.ping", body: {} });
    const logged = JSON.stringify(t.logs.map(l => [l[0], l[1] instanceof Error ? String(l[1]) : l[1]]));
    expect(logged).toContain("harmless");
    expect(logged).not.toContain("hunter2");
    expect(t.logs.some(l => (l[1] as { redacted?: boolean })?.redacted === true)).toBe(true);
    expect(JSON.stringify(t.logs.map(l => [l[0], (l[1] as Error)?.stack]))).not.toContain("hunter2");
  });

  it("suppresses a flagged BridgeError message on requests and subscribes", async () => {
    const t = setup(v => JSON.stringify(v).includes("sk-ant-"));
    t.router.handle("app.ping", () => { throw new BridgeError("provider_error", "key sk-ant-abc rejected"); });
    t.router.onSubscribe("tasks.subscribe", () => { throw new BridgeError("provider_error", "key sk-ant-abc rejected"); });
    await t.send({ t: "req", id: "1", name: "app.ping", body: {} });
    await t.send({ t: "sub", id: "2", name: "tasks.subscribe", body: {} });
    expect(t.posted.map(p => p.error)).toEqual([{ code: "internal", message: "internal error" }, { code: "internal", message: "internal error" }]);
    expect(JSON.stringify(t.logs)).not.toContain("sk-ant-");
  });

  it("turns an invalid BridgeError code into internal", async () => {
    const t = setup();
    t.router.handle("app.ping", () => { throw new BridgeError("made_up" as never, "x"); });
    await t.send({ t: "req", id: "1", name: "app.ping", body: {} });
    expect(t.posted[0].error).toEqual({ code: "internal", message: "internal error" });
  });

  it("survives a throwing log sink and a throwing secret check", async () => {
    const router = new NexusBridgeRouter({ containsSecret: () => { throw new Error("checker broke"); }, log: () => { throw new Error("sink broke"); } });
    const w = webview();
    router.attach(w.transport);
    router.handle("app.ping", () => ({ pong: true, machineId: "m", tPlus: "T+01" }));
    await w.send({ t: "req", id: "1", name: "no.such", body: {} });
    await w.send({ t: "req", id: "2", name: "app.ping", body: {} });
    expect(w.posted).toEqual([{ t: "res", id: "2", ok: false, error: { code: "internal", message: "internal error" } }]);   // fails closed
  });

  it("turns an invalid handler response into internal", async () => {
    const t = setup();
    t.router.handle("app.ping", () => ({ pong: false }) as never);
    await t.send({ t: "req", id: "1", name: "app.ping", body: {} });
    expect(t.posted[0]).toMatchObject({ ok: false, error: { code: "internal", message: "internal error" } });
  });

  it("never posts a body the secret check flags", async () => {
    const t = setup(v => JSON.stringify(v).includes("sk-ant-"));
    t.router.handle("app.ping", () => ({ pong: true, machineId: "sk-ant-abc", tPlus: "T+01" }));
    await t.send({ t: "req", id: "1", name: "app.ping", body: {} });
    expect(t.posted).toEqual([{ t: "res", id: "1", ok: false, error: { code: "internal", message: "internal error" } }]);
    expect(JSON.stringify(t.posted)).not.toContain("sk-ant-");
  });

  it("posts nothing for a response that resolves after the webview was disposed", async () => {
    const t = setup();
    let release: () => void = () => {};
    t.router.handle("app.ping", () => new Promise(r => { release = () => r({ pong: true, machineId: "m", tPlus: "T+01" }); }));
    await t.send({ t: "req", id: "1", name: "app.ping", body: {} });
    t.close();
    release();
    await tick();
    expect(t.posted).toEqual([]);
  });

  it("posts nothing for a response that resolves after the page was hidden", async () => {
    const t = setup();
    let release: () => void = () => {};
    t.router.handle("app.ping", () => new Promise(r => { release = () => r({ pong: true, machineId: "m", tPlus: "T+01" }); }));
    await t.send({ t: "req", id: "1", name: "app.ping", body: {} });
    t.setVisible(false);
    release();
    await tick();
    expect(t.posted).toEqual([]);
  });

  it("logs a postMessage that resolves false", async () => {
    const logs: unknown[][] = [];
    const router = new NexusBridgeRouter({ containsSecret: () => false, log: (...a) => { logs.push(a); } });
    const w = webview(() => Promise.resolve(false));
    router.attach(w.transport);
    router.handle("app.ping", () => ({ pong: true, machineId: "m", tPlus: "T+01" }));
    await w.send({ t: "req", id: "1", name: "app.ping", body: {} });
    expect(logs.some(l => l[0] === "post failed")).toBe(true);
  });

  it("survives non-JSON values in unknown fields", async () => {
    const t = setup();
    t.router.onSubscribe("agent.subscribe", () => undefined);
    await t.send({ t: "sub", id: "a", name: "agent.subscribe", body: { sessionId: "s1" } });
    const cyc: Record<string, unknown> = {}; cyc.self = cyc;
    t.router.publish("agent.subscribe", toolCall(0, { a: undefined, f: () => 1, d: new Date(0), n: NaN }));
    t.router.publish("agent.subscribe", toolCall(1, cyc));
    t.router.publish("agent.subscribe", toolCall(2, 10n));
    await tick();
    // what postMessage's JSON serialization produces: undefined/functions dropped, NaN -> null, Date -> string
    expect(t.posted[0].body.args).toEqual({ d: "1970-01-01T00:00:00.000Z", n: null });
    expect(t.posted).toHaveLength(1);   // cyclic and BigInt events are dropped and logged, not crashes
    expect(t.logs.length).toBeGreaterThanOrEqual(2);
  });
});

describe("NexusBridgeRouter subscriptions", () => {
  it("replays, then delivers live, then stops after unsub", async () => {
    const t = setup();
    t.router.onSubscribe("agent.subscribe", (_r, emit) => { emit(agentEvt(0)); });
    await t.send({ t: "sub", id: "a", name: "agent.subscribe", body: { sessionId: "s1" } });
    t.router.publish("agent.subscribe", agentEvt(1));
    t.router.publish("agent.subscribe", { ...agentEvt(2), sessionId: "other" });
    await t.send({ t: "unsub", id: "a" });
    t.router.publish("agent.subscribe", agentEvt(3));
    await tick();
    expect(t.posted.map(p => [p.t, p.id, p.body.seq])).toEqual([["evt", "a", 0], ["evt", "a", 1]]);
  });

  it("validates replayed events: an invalid emit fails the subscription and posts nothing bad", async () => {
    const t = setup();
    t.router.onSubscribe("agent.subscribe", (_r, emit) => { emit({ sessionId: "s1", seq: -5, junk: true } as never); });
    await t.send({ t: "sub", id: "a", name: "agent.subscribe", body: { sessionId: "s1" } });
    expect(t.posted).toEqual([{ t: "res", id: "a", ok: false, error: { code: "internal", message: "internal error" } }]);
  });

  it("disposes the subscribe cleanup on unsub and when the webview is disposed, and drops the session", async () => {
    const t = setup();
    let cleaned = 0;
    t.router.onSubscribe("events.subscribe", () => ({ dispose: () => { cleaned++; } }));
    await t.send({ t: "sub", id: "a", name: "events.subscribe", body: {} });
    await t.send({ t: "sub", id: "b", name: "events.subscribe", body: {} });
    await t.send({ t: "unsub", id: "a" });
    expect(cleaned).toBe(1);
    t.close();
    expect(cleaned).toBe(2);
    expect(t.msg.size).toBe(0);
    t.router.publish("events.subscribe", fx.event);
    await tick();
    expect(t.posted).toEqual([]);
  });

  it("disposing the attach handle also tears the session down", async () => {
    const t = setup();
    let cleaned = 0;
    t.router.onSubscribe("events.subscribe", () => ({ dispose: () => { cleaned++; } }));
    await t.send({ t: "sub", id: "a", name: "events.subscribe", body: {} });
    t.attached.dispose();
    expect(cleaned).toBe(1);
    expect(t.msg.size).toBe(0);
  });

  it("removes a subscription and reports the error when onSubscribe throws or the id repeats", async () => {
    const t = setup();
    t.router.onSubscribe("tasks.subscribe", () => { throw new Error("secret detail"); });
    await t.send({ t: "sub", id: "a", name: "tasks.subscribe", body: {} });
    expect(t.posted[0]).toEqual({ t: "res", id: "a", ok: false, error: { code: "internal", message: "internal error" } });
    t.router.publish("tasks.subscribe", fx.task);
    await tick();
    expect(t.posted).toHaveLength(1);
    await t.send({ t: "sub", id: "e", name: "events.subscribe", body: {} });
    await t.send({ t: "sub", id: "e", name: "events.subscribe", body: {} });
    expect(t.posted[1]).toMatchObject({ id: "e", ok: false, error: { code: "conflict" } });
  });

  it("rejects invalid subscribe bodies", async () => {
    const t = setup();
    await t.send({ t: "sub", id: "a", name: "agent.subscribe", body: {} });
    expect(t.posted[0]).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("never posts a flagged event, and removes that subscription", async () => {
    const t = setup(v => JSON.stringify(v).includes("sk-ant-"));
    await t.send({ t: "sub", id: "a", name: "agent.subscribe", body: { sessionId: "s1" } });
    t.router.publish("agent.subscribe", { ...agentEvt(0), text: "key sk-ant-xyz" } as AgentEvent);
    t.router.publish("agent.subscribe", agentEvt(1));
    await tick();
    expect(JSON.stringify(t.posted)).not.toContain("sk-ant-");
    expect(t.posted).toEqual([{ t: "res", id: "a", ok: false, error: { code: "internal", message: "internal error" } }]);
  });

  it("isolates webviews: each gets its own events, ids and unsubs", async () => {
    const t1 = setup();
    let cleaned = 0;
    t1.router.onSubscribe("events.subscribe", () => ({ dispose: () => { cleaned++; } }));
    const w2 = webview();
    t1.router.attach(w2.transport);
    await t1.send({ t: "sub", id: "a", name: "events.subscribe", body: {} });
    await w2.send({ t: "sub", id: "a", name: "events.subscribe", body: {} });   // same id in another webview: no conflict
    t1.router.publish("events.subscribe", fx.event);
    await tick();
    expect(t1.posted.map(p => [p.t, p.id])).toEqual([["evt", "a"]]);
    expect(w2.posted.map(p => [p.t, p.id])).toEqual([["evt", "a"]]);
    await w2.send({ t: "unsub", id: "a" });   // must not touch webview 1's "a"
    expect(cleaned).toBe(1);
    t1.router.publish("events.subscribe", fx.event);
    await tick();
    expect(t1.posted).toHaveLength(2);
    expect(w2.posted).toHaveLength(1);
    t1.close();
    t1.router.publish("events.subscribe", fx.event);
    await tick();
    expect(w2.posted).toHaveLength(1);   // w2 unsubscribed earlier; closing w1 changes nothing for it
    expect(t1.posted).toHaveLength(2);
  });

  it("hide then show: old session dropped with cleanup run, same id subscribes again and gets live events", async () => {
    const t = setup();
    const cleanups: number[] = [];
    let n = 0;
    t.router.onSubscribe("agent.subscribe", (_r, emit) => { const my = ++n; emit(agentEvt(0)); return { dispose: () => { cleanups.push(my); } }; });
    await t.send({ t: "sub", id: "a", name: "agent.subscribe", body: { sessionId: "s1" } });
    t.setVisible(false);
    expect(cleanups).toEqual([1]);
    t.router.publish("agent.subscribe", agentEvt(1));   // nobody is listening: not posted to the dead page
    await tick();
    t.setVisible(true);
    await t.send({ t: "sub", id: "a", name: "agent.subscribe", body: { sessionId: "s1", fromSeq: 1 } });
    expect(t.posted.some(p => p.t === "res")).toBe(false);   // no conflict
    t.router.publish("agent.subscribe", agentEvt(2));
    await tick();
    expect(t.posted.map(p => p.body.seq)).toEqual([0, 2]);   // old page's replay, then live 2; seq 0 is below the new fromSeq so not replayed again, and seq 1 went to no one
  });

  it("a stale open that rejects later neither deletes the new id nor reports", async () => {
    const t = setup();
    let rejectFirst: (e: Error) => void = () => {};
    let calls = 0;
    t.router.onSubscribe("events.subscribe", () => {
      calls++;
      return calls === 1 ? new Promise<void>((_, rej) => { rejectFirst = rej; }) : undefined;
    });
    await t.send({ t: "sub", id: "a", name: "events.subscribe", body: {} });   // first open pending
    await t.send({ t: "unsub", id: "a" });
    await t.send({ t: "sub", id: "a", name: "events.subscribe", body: {} });   // second open, live
    rejectFirst(new Error("late failure"));
    await tick();
    expect(t.posted).toEqual([]);   // no error for the abandoned open
    t.router.publish("events.subscribe", fx.event);
    await tick();
    expect(t.posted.map(p => p.t)).toEqual(["evt"]);   // the new subscription still works and still owns the id
    await t.send({ t: "sub", id: "a", name: "events.subscribe", body: {} });
    expect(t.posted[1]).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("enforces caps: id length, subscriptions per webview, held events", async () => {
    const t = setup(() => false, { limits: { maxSubscriptionsPerWebview: 2, maxHeldEvents: 2 } });
    await t.send({ t: "sub", id: "x".repeat(129), name: "events.subscribe", body: {} });
    await t.send({ t: "req", id: "y".repeat(129), name: "app.ping", body: {} });
    expect(t.posted.map(p => p.error.code)).toEqual(["invalid_request", "invalid_request"]);
    t.posted.length = 0;
    await t.send({ t: "sub", id: "1", name: "events.subscribe", body: {} });
    await t.send({ t: "sub", id: "2", name: "events.subscribe", body: {} });
    await t.send({ t: "sub", id: "3", name: "events.subscribe", body: {} });
    expect(t.posted).toEqual([{ t: "res", id: "3", ok: false, error: { code: "invalid_request", message: "too many subscriptions" } }]);
    // held overflow
    const u = setup(() => false, { limits: { maxHeldEvents: 2 } });
    let release: () => void = () => {};
    let cleaned = 0;
    u.router.onSubscribe("events.subscribe", () => new Promise(r => { release = () => r({ dispose: () => { cleaned++; } }); }));
    await u.send({ t: "sub", id: "h", name: "events.subscribe", body: {} });
    for (let i = 0; i < 3; i++) u.router.publish("events.subscribe", { ...fx.event, id: `e${i}` });
    expect(u.posted).toEqual([{ t: "res", id: "h", ok: false, error: { code: "internal", message: "internal error" } }]);
    release();
    await tick();
    expect(cleaned).toBe(1);   // late cleanup disposed
    expect(u.posted).toHaveLength(1);
  });
});
