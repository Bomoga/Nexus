import { describe, expect, it } from "vitest";
import { FakeBridgeServer } from "../../bridge/fake-bridge-server";
import { registerOpenTarget } from "./open-target";

const SHA = "a".repeat(40);

function setup(fail?: Error) {
  const b = new FakeBridgeServer();
  const calls: unknown[][] = [];
  registerOpenTarget(b, { executeCommand: async (...a) => { calls.push(a); if (fail) throw fail; return undefined; } });
  return { b, calls };
}

describe("ui.openTarget", () => {
  it("routes each target type to exactly its command with exactly the validated argument", async () => {
    const { b, calls } = setup();
    expect(await b.call("ui.openTarget", { type: "commit", sha: SHA })).toEqual({});
    expect(await b.call("ui.openTarget", { type: "session", sessionId: "s-1" })).toEqual({});
    expect(await b.call("ui.openTarget", { type: "thread", channelId: "C0123ABCD", threadTs: "1762485300.000100" })).toEqual({});
    expect(calls).toEqual([
      ["nexus.openCommit", SHA],
      ["nexus.openSession", "s-1"],
      ["nexus.openSlack", { channelId: "C0123ABCD", threadTs: "1762485300.000100" }],
    ]);
  });

  it("refuses malformed fields without calling anything", async () => {
    const { b, calls } = setup();
    const bad = [
      { type: "commit", sha: "ABC" }, { type: "commit", sha: "A".repeat(40) }, { type: "commit", sha: `${SHA}\n--flag` },
      { type: "session", sessionId: "" },
      { type: "thread", channelId: "c1", threadTs: "1762485300.000100" },
      { type: "thread", channelId: "C1; rm", threadTs: "1762485300.000100" },
      { type: "thread", channelId: "C1", threadTs: "not-a-ts" },
      { type: "thread", channelId: "C1", threadTs: "1762485300.000100 x" },
      { type: "other", x: 1 },
    ];
    for (const t of bad) await expect(b.call("ui.openTarget", t as never)).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toEqual([]);
  });

  it("re-checks inside the handler when the router validation is bypassed", async () => {
    const calls: unknown[][] = [];
    let handler: ((req: never) => Promise<unknown>) | undefined;
    registerOpenTarget({ handle: (_n: string, fn: never) => { handler = fn; return { dispose() {} }; } } as never,
      { executeCommand: async (...a) => { calls.push(a); } });
    for (const t of [{ type: "commit", sha: "nope" }, { type: "thread", channelId: "C1", threadTs: "x" }, { type: "weird" }]) {
      await expect(handler!(t as never)).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(calls).toEqual([]);
  });

  it("reports an unregistered command as not_found naming what is missing", async () => {
    const { b } = setup(new Error("command 'nexus.openCommit' not found"));
    const err = await b.call("ui.openTarget", { type: "commit", sha: SHA }).catch(e => e);
    expect(err).toMatchObject({ code: "not_found" });
    expect(err.message).toContain("nexus.openCommit");
  });

  it("maps any other failure to internal without the raw message", async () => {
    const { b } = setup(new Error("secret token xoxp-123 leaked"));
    const err = await b.call("ui.openTarget", { type: "session", sessionId: "s-1" }).catch(e => e);
    expect(err).toMatchObject({ code: "internal" });
    expect(err.message).not.toContain("xoxp");
  });
});
