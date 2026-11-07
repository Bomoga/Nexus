import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readLines } from "../shared/jsonl";
import { AgentChannel } from "./channel";

function setup() {
  const fromHost = new PassThrough();
  const toHost = new PassThrough();
  const sent: Array<Record<string, unknown>> = [];
  readLines(toHost, l => sent.push(JSON.parse(l) as Record<string, unknown>));
  const channel = new AgentChannel(fromHost, toHost);
  const hostSays = (v: unknown) => fromHost.write(JSON.stringify(v) + "\n");
  return { channel, sent, hostSays, fromHost };
}

describe("AgentChannel", () => {
  it("sends a validated request and resolves with the validated response", async () => {
    const { channel, sent, hostSays } = setup();
    const p = channel.request("fs.read", { path: "a.ts" });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ t: "req", name: "fs.read", body: { path: "a.ts" } });
    hostSays({ t: "res", id: sent[0].id, ok: true, body: { content: "x", truncated: false } });
    await expect(p).resolves.toEqual({ content: "x", truncated: false });
  });

  it("refuses to send an invalid request", async () => {
    const { channel, sent } = setup();
    await expect(channel.request("fs.read", { path: 1 } as never)).rejects.toThrow("invalid fs.read request");
    expect(sent).toHaveLength(0);
  });

  it("rejects on an error response and on an invalid response body", async () => {
    const { channel, sent, hostSays } = setup();
    const a = channel.request("fs.read", { path: "a" });
    const b = channel.request("fs.read", { path: "b" });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    hostSays({ t: "res", id: sent[0].id, ok: false, error: "path outside worktree" });
    hostSays({ t: "res", id: sent[1].id, ok: true, body: { content: 5 } });
    await expect(a).rejects.toThrow("path outside worktree");
    await expect(b).rejects.toThrow("invalid fs.read response");
  });

  it("applies defaults when sending (fs.list)", async () => {
    const { channel, sent } = setup();
    void channel.request("fs.list", {}).catch(() => {});
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toEqual({ path: ".", depth: 2 });
  });

  it("serves host requests through the registered handler and validates both sides", async () => {
    const { channel, sent, hostSays } = setup();
    channel.onHostRequest((async (name: string) => (name === "health" ? { ok: true, pid: 7 } : { nope: true })) as never);
    hostSays({ t: "req", id: "h1", name: "health", body: {} });
    hostSays({ t: "req", id: "h2", name: "session.cancel", body: { sessionId: "s" } });   // handler returns junk
    hostSays({ t: "req", id: "h3", name: "session.cancel", body: {} });                    // invalid request
    hostSays({ t: "req", id: "h4", name: "bogus", body: {} });
    await vi.waitFor(() => expect(sent).toHaveLength(4));
    const byId = Object.fromEntries(sent.map(s => [s.id as string, s]));
    expect(byId.h1).toMatchObject({ ok: true, body: { ok: true, pid: 7 } });
    expect(byId.h2).toMatchObject({ ok: false, error: "invalid session.cancel response" });
    expect(byId.h3).toMatchObject({ ok: false, error: "invalid session.cancel request" });
    expect(byId.h4).toMatchObject({ ok: false, error: "unknown host request bogus" });
  });

  it("delivers valid host events and ignores invalid ones", async () => {
    const { channel, hostSays } = setup();
    const got: unknown[] = [];
    channel.onHostEvent("approval.resolved", e => got.push(e));
    hostSays({ t: "evt", name: "approval.resolved", body: { approvalId: "a", decision: "maybe" } });
    hostSays({ t: "evt", name: "approval.resolved", body: { approvalId: "a", decision: "approved" } });
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(got[0]).toEqual({ approvalId: "a", decision: "approved" });
  });

  it("fails in-flight requests when the host closes the stream, and after close()", async () => {
    const { channel, sent, fromHost } = setup();
    const p = channel.request("fs.read", { path: "a" });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    fromHost.end();
    await expect(p).rejects.toThrow("host closed the channel");
    channel.close();
    await expect(channel.request("fs.read", { path: "a" })).rejects.toThrow("channel closed");
  });

  it("ignores garbage lines", async () => {
    const { channel, sent, fromHost, hostSays } = setup();
    fromHost.write("}{not json\n");
    hostSays({ t: "zzz" });
    const p = channel.request("fs.read", { path: "a" });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    hostSays({ t: "res", id: sent[0].id, ok: true, body: { content: "", truncated: false } });
    await expect(p).resolves.toBeDefined();
  });
});
