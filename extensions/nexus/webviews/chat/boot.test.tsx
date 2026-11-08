// @vitest-environment jsdom
// The host points the Slack view at a thread by re-setting <body data-channel-id data-thread-ts> (nexus.openSlack).
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { BridgeClient } from "../shared";
import { App, bootTarget } from "./App";
import { StatusBar } from "./StatusBar";

afterEach(() => {
  cleanup();
  delete document.body.dataset.channelId;
  delete document.body.dataset.threadTs;
});

const channels = [
  { id: "C_GENERAL", name: "general", isPrivate: false, isMember: true, botIsMember: true },
  { id: "C_DEMO", name: "nexus-demo", isPrivate: false, isMember: true, botIsMember: true },
];
const parent = { id: "C_DEMO:1.1", channelId: "C_DEMO", ts: "1762466100.000100", author: { id: "U1", name: "adrian", isBot: false }, text: "cart total ignores the discount", codeRefs: [], sentVia: "user", replyCount: 1 };
const reply = { id: "C_DEMO:1.2", channelId: "C_DEMO", ts: "1762466200.000200", threadTs: "1762466100.000100", author: { id: "U2", name: "brandon", isBot: false }, text: "can an agent take this?", codeRefs: [], sentVia: "user" };

function fakeBridge() {
  const request = vi.fn(async (name: string) => {
    switch (name) {
      case "slack.channels": return channels;
      case "slack.history": return { messages: [parent], hasMore: false };
      case "slack.thread": return { channelId: "C_DEMO", threadTs: "1762466100.000100", messages: [parent, reply] };
      case "slack.users": return [];
      case "slack.status": return { connected: true, postsAs: { userId: "U1", name: "adrian" }, userTokenSource: "manual", botName: "Nexus" };
      case "store.status": return { online: true, outboxDepth: 0 };
      default: return {};
    }
  });
  return { request, subscribe: vi.fn(() => () => undefined), dispose: () => undefined } as unknown as BridgeClient;
}

describe("bootTarget", () => {
  test("reads a valid channel and thread from the body, ignores malformed values", () => {
    expect(bootTarget({ channelId: "C_DEMO", threadTs: "1762466100.000100" })).toEqual({ channelId: "C_DEMO", threadTs: "1762466100.000100" });
    expect(bootTarget({ channelId: "C_DEMO" })).toEqual({ channelId: "C_DEMO" });
    expect(bootTarget({ channelId: "C_DEMO", threadTs: "nope" })).toEqual({ channelId: "C_DEMO" });
    expect(bootTarget({ channelId: "c-demo" })).toBeUndefined();
    expect(bootTarget({})).toBeUndefined();
  });
});

describe("Slack view boot target", () => {
  test("selects the channel from the body and opens its thread instead of the first channel", async () => {
    document.body.dataset.channelId = "C_DEMO";
    document.body.dataset.threadTs = "1762466100.000100";
    const bridge = fakeBridge();
    render(<App bridge={bridge} />);
    await waitFor(() => expect(screen.getByText("can an agent take this?")).toBeTruthy());
    const calls = (bridge.request as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some(([n, b]) => n === "slack.thread" && (b as { threadTs: string }).threadTs === "1762466100.000100")).toBe(true);
    expect(calls.some(([n, b]) => n === "slack.history" && (b as { channelId: string }).channelId === "C_GENERAL")).toBe(false);
  });
});

describe("StatusBar polling", () => {
  test("asks slack.status again while disconnected and turns green once the socket is up", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ connected: false, postsAs: null, userTokenSource: "none", botName: "Nexus" })
      .mockResolvedValue({ connected: true, postsAs: { userId: "U1", name: "adrian" }, userTokenSource: "manual", botName: "Nexus" });
    render(<StatusBar bridge={{ request, subscribe: vi.fn() } as unknown as BridgeClient} pollWhileDownMs={20} pollWhileUpMs={10_000} />);
    expect(await screen.findByText("slack disconnected")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("slack connected · token: manual")).toBeTruthy());
    expect(request.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
