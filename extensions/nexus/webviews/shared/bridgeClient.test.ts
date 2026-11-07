// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
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
});
