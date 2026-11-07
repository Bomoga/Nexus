import { describe, expect, it } from "vitest";
import { fx } from "../contracts/fixtures";
import type { AgentEvent } from "../contracts";
import { NexusBridgeRouter } from "./router";
import type { WebviewTransport } from "./router";
import { BridgeError } from "./types";

type Posted = { t: string; id: string; ok?: boolean; body: { seq?: number; args?: unknown; machineId?: string }; error: { code: string; message: string } };
const tick = () => new Promise<void>(r => setTimeout(r, 0));
const toolCall = (seq: number, args: unknown): AgentEvent => ({ sessionId: "s1", seq, at: fx.task.createdAt, type: "tool_call", tool: "x", args });
const agentEvt = (seq: number): AgentEvent => ({ sessionId: "s1", seq, at: fx.task.createdAt, type: "message", text: `m${seq}` });

function setup(containsSecret: (v: unknown) => boolean = () => false) {
  const logs: unknown[][] = [];
  const router = new NexusBridgeRouter({ containsSecret, log: (...a) => { logs.push(a); } });
  const posted: Posted[] = [];
  const msgListeners = new Set<(m: unknown) => void>();
  const disposeListeners = new Set<() => void>();
  const transport: WebviewTransport = {
    post: m => { posted.push(m as Posted); return Promise.resolve(true); },
    onMessage: cb => { msgListeners.add(cb); return { dispose: () => { msgListeners.delete(cb); } }; },
    onDidDispose: cb => { disposeListeners.add(cb); return { dispose: () => { disposeListeners.delete(cb); } }; },
  };
  const attached = router.attach(transport);
  // postMessage delivers JSON, so round-trip what the webview sends too.
  const send = async (m: unknown) => { for (const l of [...msgListeners]) l(JSON.parse(JSON.stringify(m))); await tick(); };
  const closeWebview = () => { for (const l of [...disposeListeners]) l(); };
  return { router, posted, logs, send, closeWebview, attached, msgListeners };
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

  it("maps handler errors: BridgeError code kept, anything else generic internal with detail only logged", async () => {
    const t = setup();
    t.router.handle("app.ping", () => { throw new BridgeError("unauthorized", "sign in first"); });
    t.router.handle("store.status", () => { throw new Error("pg://user:hunter2@host exploded"); });
    await t.send({ t: "req", id: "1", name: "app.ping", body: {} });
    await t.send({ t: "req", id: "2", name: "store.status", body: {} });
    expect(t.posted[0].error).toEqual({ code: "unauthorized", message: "sign in first" });
    expect(t.posted[1].error).toEqual({ code: "internal", message: "internal error" });
    expect(JSON.stringify(t.posted)).not.toContain("hunter2");
    expect(t.logs.map(l => String(l[1]))).toContain("Error: pg://user:hunter2@host exploded");
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

  it("disposes the subscribe cleanup on unsub and when the webview is disposed", async () => {
    const t = setup();
    let cleaned = 0;
    t.router.onSubscribe("events.subscribe", () => ({ dispose: () => { cleaned++; } }));
    await t.send({ t: "sub", id: "a", name: "events.subscribe", body: {} });
    await t.send({ t: "sub", id: "b", name: "events.subscribe", body: {} });
    await t.send({ t: "unsub", id: "a" });
    expect(cleaned).toBe(1);
    t.closeWebview();
    expect(cleaned).toBe(2);
    expect(t.msgListeners.size).toBe(0);
    t.router.publish("events.subscribe", fx.event);
    await tick();
    expect(t.posted).toEqual([]);
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

  it("serves two webviews independently", async () => {
    const t1 = setup();
    t1.router.onSubscribe("events.subscribe", () => undefined);
    const posted2: unknown[] = [];
    const l2 = new Set<(m: unknown) => void>();
    const d2 = new Set<() => void>();
    t1.router.attach({ post: m => { posted2.push(m); }, onMessage: cb => { l2.add(cb); return { dispose: () => { l2.delete(cb); } }; }, onDidDispose: cb => { d2.add(cb); return { dispose: () => { d2.delete(cb); } }; } });
    await t1.send({ t: "sub", id: "a", name: "events.subscribe", body: {} });
    for (const l of l2) l({ t: "sub", id: "a", name: "events.subscribe", body: {} });
    await tick();
    t1.closeWebview();
    t1.router.publish("events.subscribe", fx.event);
    await tick();
    expect(t1.posted).toEqual([]);
    expect(posted2).toHaveLength(1);
  });
});
