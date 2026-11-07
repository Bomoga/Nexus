// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { ChatMessage, Channel, NexusEvent } from "../../src/contracts";
import { createBridgeClient } from "./bridgeClient";
import { createFakeTransport } from "./fakeBridge";

const client = () => createBridgeClient(createFakeTransport({ liveIntervalMs: 0 }));

describe("fakeBridge", () => {
  test("answers events.query with schema-valid events", async () => {
    const events = await client().request("events.query", { from: "2026-11-07T00:00:00Z", to: "2026-11-09T00:00:00Z" });
    expect(events.length).toBeGreaterThan(10);
    for (const e of events) expect(NexusEvent.safeParse(e).success).toBe(true);
  });

  test("answers slack.channels with schema-valid channels", async () => {
    const channels = await client().request("slack.channels", {});
    expect(channels.length).toBeGreaterThan(0);
    for (const c of channels) expect(Channel.safeParse(c).success).toBe(true);
  });

  test("answers slack.thread and slack.post", async () => {
    const c = client();
    const thread = await c.request("slack.thread", { channelId: "C_DEMO", threadTs: "1762485300.000100" });
    expect(thread.messages.length).toBeGreaterThan(0);
    const posted = await c.request("slack.post", { channelId: "C_DEMO", text: "hi", clientId: "c1" });
    expect(ChatMessage.safeParse(posted).success).toBe(true);
  });

  test("events.subscribe delivers validated events and unsubscribes", async () => {
    const c = createBridgeClient(createFakeTransport({ liveIntervalMs: 5 }));
    const seen: string[] = [];
    const stop = c.subscribe("events.subscribe", {}, (e) => seen.push(e.id));
    await new Promise((r) => setTimeout(r, 40));
    stop();
    const n = seen.length;
    expect(n).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(seen.length).toBe(n);
  });

  test("rejects an invalid request body", async () => {
    // @ts-expect-error missing channelId
    await expect(client().request("slack.thread", {})).rejects.toThrow();
  });
});
