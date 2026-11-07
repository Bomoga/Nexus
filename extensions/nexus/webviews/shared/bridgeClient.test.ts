// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Envelope } from "../../src/contracts";
import { BridgeError, createBridgeClient } from "./bridgeClient";
import type { Transport } from "./bridgeClient";

/** A transport whose replies the test scripts. */
function scripted(reply: (env: Envelope) => Envelope | undefined) {
  const listeners = new Set<(env: Envelope) => void>();
  const posted: Envelope[] = [];
  const transport: Transport = {
    post(env) {
      posted.push(env);
      const r = reply(env);
      if (r) queueMicrotask(() => listeners.forEach((l) => l(r)));
    },
    listen(h) {
      listeners.add(h);
      return () => listeners.delete(h);
    },
  };
  return { transport, posted, push: (env: Envelope) => listeners.forEach((l) => l(env)) };
}

afterEach(() => vi.useRealTimers());

describe("bridgeClient", () => {
  test("rejects a response that fails the contract schema", async () => {
    const { transport } = scripted((env) => (env.t === "req" ? { t: "res", id: env.id, ok: true, body: { pong: "yes" } } : undefined));
    await expect(createBridgeClient(transport).request("app.ping", {})).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("turns an error response into a BridgeError", async () => {
    const { transport } = scripted((env) => (env.t === "req" ? { t: "res", id: env.id, ok: false, error: { code: "offline", message: "no network" } } : undefined));
    const err = await createBridgeClient(transport).request("app.ping", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err).toMatchObject({ code: "offline", message: "no network" });
  });

  test("applies request defaults before posting", async () => {
    const { transport, posted } = scripted((env) => (env.t === "req" ? { t: "res", id: env.id, ok: true, body: { receipts: [], summary: { calls: 0, costUsd: 0, savedUsd: 0 } } } : undefined));
    await createBridgeClient(transport).request("receipts.list", {});
    expect(posted[0]).toMatchObject({ t: "req", name: "receipts.list", body: { limit: 100 } });
  });

  test("drops invalid events and stops after unsubscribe", () => {
    const { transport, posted, push } = scripted(() => undefined);
    const got: unknown[] = [];
    const stop = createBridgeClient(transport).subscribe("store.subscribe", {}, (e) => got.push(e));
    const id = posted[0].id;
    push({ t: "evt", id, body: { online: true, outboxDepth: 2 } });
    push({ t: "evt", id, body: { online: "maybe" } });
    expect(got).toEqual([{ online: true, outboxDepth: 2 }]);
    stop();
    expect(posted[1]).toEqual({ t: "unsub", id });
    push({ t: "evt", id, body: { online: true, outboxDepth: 3 } });
    expect(got).toHaveLength(1);
  });

  test("times out, rejects with a BridgeError and ignores a late reply", async () => {
    vi.useFakeTimers();
    const { transport, posted, push } = scripted(() => undefined);
    const client = createBridgeClient(transport);
    const result = client.request("app.ping", {}, { timeoutMs: 1000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const err = await result;
    expect(err).toBeInstanceOf(BridgeError);
    expect(err).toMatchObject({ code: "offline" });
    expect(vi.getTimerCount()).toBe(0);
    // The pending entry is gone: a late reply is dropped silently.
    push({ t: "res", id: posted[0].id, ok: true, body: { pong: true, machineId: "m", tPlus: "T" } });
  });

  test("uses a 30 s default timeout", async () => {
    vi.useFakeTimers();
    const { transport } = scripted(() => undefined);
    const result = createBridgeClient(transport).request("app.ping", {}).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeInstanceOf(BridgeError);
  });

  test("answers out of order resolve with their own bodies", async () => {
    const { transport, posted, push } = scripted(() => undefined);
    const client = createBridgeClient(transport);
    const a = client.request("accounts.test", { accountId: "a" });
    const b = client.request("store.status", {});
    push({ t: "res", id: posted[1].id, ok: true, body: { online: false, outboxDepth: 4 } });
    push({ t: "res", id: posted[0].id, ok: true, body: { id: "a", provider: "anthropic", label: "A", status: "connected", dataLeavesMachine: true, dataUse: "unknown" } });
    expect(await b).toEqual({ online: false, outboxDepth: 4 });
    expect(await a).toMatchObject({ id: "a" });
  });

  test("subscribe with an invalid body throws a BridgeError and registers nothing", () => {
    const { transport, posted, push } = scripted(() => undefined);
    const got: unknown[] = [];
    // @ts-expect-error channelIds must be an array
    expect(() => createBridgeClient(transport).subscribe("slack.subscribe", { channelIds: "C1" }, (e) => got.push(e))).toThrow(BridgeError);
    expect(posted).toEqual([]);
    // A schema-valid event: if a dead subscription had been registered, it would deliver this.
    push({ t: "evt", id: "s1", body: { type: "status", status: { connected: true, postsAs: null, userTokenSource: "none", botName: "b" } } });
    expect(got).toEqual([]);
  });

  test("a throwing subscriber does not escape the listener, and dispose clears timers", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { transport, posted, push } = scripted(() => undefined);
    const client = createBridgeClient(transport);
    const seen: number[] = [];
    client.subscribe("store.subscribe", {}, () => {
      throw new Error("view bug");
    });
    client.subscribe("store.subscribe", {}, (e) => seen.push(e.outboxDepth));
    expect(() => push({ t: "evt", id: posted[0].id, body: { online: true, outboxDepth: 1 } })).not.toThrow();
    push({ t: "evt", id: posted[1].id, body: { online: true, outboxDepth: 2 } });
    expect(seen).toEqual([2]);
    expect(errors).toHaveBeenCalled();
    void client.request("app.ping", {}).catch(() => undefined);
    expect(vi.getTimerCount()).toBe(1);
    client.dispose();
    expect(vi.getTimerCount()).toBe(0);
    errors.mockRestore();
  });
});
