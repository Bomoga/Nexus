// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createBridgeClient } from "../shared";
import { createFakeTransport } from "../shared/fakeBridge";
import type { BridgeClient } from "../shared";
import { ChannelList, INVITE_TOOLTIP } from "./ChannelList";
import type { Channel } from "../../src/contracts";

afterEach(cleanup);

const bridge = () => createBridgeClient(createFakeTransport({ liveIntervalMs: 0 }));

describe("ChannelList", () => {
  test("lists the channels from slack.channels with name and unread count", async () => {
    render(<ChannelList bridge={bridge()} selectedId={undefined} onSelect={() => {}} />);
    const demo = await screen.findByRole("button", { name: /nexus-demo/ });
    expect(demo.textContent).toContain("nexus-demo");
    expect(demo.querySelector(".chat-unread")?.textContent).toBe("2");
    const build = await screen.findByRole("button", { name: /nexus-build/ });
    expect(build.querySelector(".chat-unread")).toBeNull();
  });

  test("calls onSelect with the channel and marks the selected row", async () => {
    const onSelect = vi.fn();
    render(<ChannelList bridge={bridge()} selectedId="C_BUILD" onSelect={onSelect} />);
    const demo = await screen.findByRole("button", { name: /nexus-demo/ });
    fireEvent.click(demo);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "C_DEMO" }));
    const build = await screen.findByRole("button", { name: /nexus-build/ });
    expect(build.getAttribute("aria-current")).toBe("true");
    expect(build.className).toContain("is-selected");
    expect(demo.className).not.toContain("is-selected");
  });

  test("rows are the kit's 20 px small rows and show a CHANNELS header with the count", async () => {
    const { container } = render(<ChannelList bridge={bridge()} selectedId={undefined} onSelect={() => {}} />);
    await screen.findByRole("button", { name: /nexus-demo/ });
    expect(container.querySelector(".nx-panel-header")?.textContent).toMatch(/^CHANNELS\s*\d+$/);
    expect(container.querySelectorAll(".nx-list-row--sm").length).toBeGreaterThan(0);
  });

  test("shows a dot with the invite tooltip only when botIsMember is false", async () => {
    const channels: Channel[] = [
      { id: "C1", name: "with-bot", isPrivate: false, isMember: true, botIsMember: true },
      { id: "C2", name: "no-bot", isPrivate: false, isMember: true, botIsMember: false },
    ];
    const client = { request: vi.fn().mockResolvedValue(channels), subscribe: vi.fn() } as unknown as BridgeClient;
    render(<ChannelList bridge={client} selectedId={undefined} onSelect={() => {}} />);
    const noBot = await screen.findByRole("button", { name: /no-bot/ });
    const dot = noBot.querySelector(".chat-dot");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("title")).toBe("bot not in channel: no live updates");
    expect(dot?.getAttribute("aria-label")).toBe("bot not in channel: no live updates");
    expect(INVITE_TOOLTIP).toBe("bot not in channel: no live updates");
    const withBot = await screen.findByRole("button", { name: /with-bot/ });
    expect(withBot.querySelector(".chat-dot")).toBeNull();
  });

  test("shows a one-line empty state when the request fails", async () => {
    const client = { request: vi.fn().mockRejectedValue(new Error("boom")), subscribe: vi.fn() } as unknown as BridgeClient;
    render(<ChannelList bridge={client} selectedId={undefined} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByText("slack failed: boom")).toBeTruthy());
  });
});
