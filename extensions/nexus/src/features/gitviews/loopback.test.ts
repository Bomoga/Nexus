import { describe, expect, it } from "vitest";
import { NexusBridgeRouter } from "../../bridge/router";
import { BridgeError } from "../../bridge/types";
import { createLoopbackClient } from "./loopback";

function makeRouter(): NexusBridgeRouter {
  return new NexusBridgeRouter({ containsSecret: () => false, log: () => {} });
}

describe("loopback client", () => {
  it("round-trips a request through a real router", async () => {
    const router = makeRouter();
    router.handle("git.commit.show", async ({ sha }) => ({ sha, subject: "s", body: "", author: "a", at: "2026-11-07T00:00:00Z", parents: [], files: [] }));
    const client = createLoopbackClient(router);
    expect(router.sessionCount()).toBe(1);
    const res = await client.request("git.commit.show", { sha: "abc1234" });
    expect(res.subject).toBe("s");
    expect(res.sha).toBe("abc1234");
    client.dispose();
    expect(router.sessionCount()).toBe(0);
  });

  it("rejects with code and message when the handler fails", async () => {
    const router = makeRouter();
    router.handle("git.commit.show", async () => { throw new BridgeError("not_found", "no such commit"); });
    const client = createLoopbackClient(router);
    await expect(client.request("git.commit.show", { sha: "abc1234" })).rejects.toMatchObject({ code: "not_found", message: "no such commit" });
  });

  it("rejects when nothing handles the request", async () => {
    const client = createLoopbackClient(makeRouter());
    await expect(client.request("git.commit.show", { sha: "abc1234" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects when the router refuses to send an invalid body", async () => {
    const router = makeRouter();
    router.handle("git.commit.show", async () => ({ sha: "x" }) as never);
    const client = createLoopbackClient(router);
    await expect(client.request("git.commit.show", { sha: "abc1234" })).rejects.toMatchObject({ code: "internal" });
  });

  it("rejects a response body that fails the client's own validation", async () => {
    const fake = {
      attach: (t: Parameters<NexusBridgeRouter["attach"]>[0]) => {
        t.onMessage(m => { void t.post({ t: "res", id: (m as { id: string }).id, ok: true, body: { sha: 1 } }); });
        return { dispose() {} };
      },
    };
    const client = createLoopbackClient(fake);
    await expect(client.request("git.commit.show", { sha: "abc1234" })).rejects.toThrow(/invalid response/);
  });

  it("times out", async () => {
    const router = makeRouter();
    router.handle("git.commit.show", () => new Promise(() => {}));
    const client = createLoopbackClient(router, { timeoutMs: 20 });
    await expect(client.request("git.commit.show", { sha: "abc1234" })).rejects.toThrow(/timed out/);
  });

  it("refuses requests after dispose", async () => {
    const client = createLoopbackClient(makeRouter());
    client.dispose();
    await expect(client.request("git.commit.show", { sha: "abc1234" })).rejects.toThrow(/disposed/);
  });
});
