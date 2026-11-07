// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createBridgeClient, createFakeTransport } from "../shared";
import type { BridgeClient } from "../shared";
import type { ChatMessage } from "../../src/contracts";
import { History } from "./History";
import { formatTime } from "./MessageRow";

afterEach(cleanup);

const msg = (n: number, over: Partial<ChatMessage> = {}): ChatMessage => {
  const ts = `${1762485000 + n * 60}.000100`;
  return { id: `C1:${ts}`, channelId: "C1", ts, author: { id: "U1", name: "adrian", isBot: false }, text: `message ${n}`, codeRefs: [], sentVia: "user", ...over };
};

interface Page { messages: ChatMessage[]; nextCursor?: string; fromCache: boolean }

function fakeClient(pages: Record<string, Page>) {
  const history = vi.fn(async (body: { cursor?: string }) => pages[body.cursor ?? "first"]);
  const client = {
    request: vi.fn(async (name: string, body: never) => {
      if (name === "slack.history") return history(body);
      if (name === "slack.users") return [];
      throw new Error(`unexpected ${name}`);
    }),
    subscribe: vi.fn(),
  } as unknown as BridgeClient;
  return { client, history };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("History", () => {
  test("renders avatar, name, time, text and reply count from the fake bridge", async () => {
    const client = createBridgeClient(createFakeTransport({ liveIntervalMs: 0 }));
    render(<History bridge={client} channelId="C_DEMO" />);
    const row = (await screen.findByText(/cart total ignores the discount/)).closest(".chat-row") as HTMLElement;
    expect(row.querySelector(".chat-avatar")?.textContent).toBe("A");
    await waitFor(() => expect(row.querySelector(".chat-name")?.textContent).toBe("Adrian"));
    expect(row.querySelector(".chat-time")?.textContent).toBe(formatTime("1762485300.000100"));
    expect(row.querySelector(".chat-replies")?.textContent).toBe("↳ 1");
  });

  test("loads the newest page first, oldest-to-newest top-to-bottom", async () => {
    const { client, history } = fakeClient({ first: { messages: [msg(3), msg(2), msg(1)], nextCursor: "c2", fromCache: false } });
    const { container } = render(<History bridge={client} channelId="C1" />);
    await screen.findByText("message 3");
    expect(history).toHaveBeenCalledTimes(1);
    expect(history.mock.calls[0][0].cursor).toBeUndefined();
    expect([...container.querySelectorAll(".chat-text")].map((e) => e.textContent)).toEqual(["message 1", "message 2", "message 3"]);
  });

  test("loads an older page when scrolled to the top and stops without a cursor", async () => {
    const { client, history } = fakeClient({
      first: { messages: [msg(3), msg(2)], nextCursor: "c2", fromCache: false },
      c2: { messages: [msg(1)], fromCache: false },
    });
    const { container } = render(<History bridge={client} channelId="C1" />);
    await screen.findByText("message 3");
    const scroller = container.querySelector(".chat-history") as HTMLElement;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    await screen.findByText("message 1");
    expect(history).toHaveBeenCalledTimes(2);
    expect(history.mock.calls[1][0].cursor).toBe("c2");
    expect([...container.querySelectorAll(".chat-text")].map((e) => e.textContent)).toEqual(["message 1", "message 2", "message 3"]);
    fireEvent.scroll(scroller);
    await settle();
    expect(history).toHaveBeenCalledTimes(2);
  });

  test("does not page when scrolled away from the top", async () => {
    const { client, history } = fakeClient({ first: { messages: [msg(2), msg(1)], nextCursor: "c2", fromCache: false } });
    const { container } = render(<History bridge={client} channelId="C1" />);
    await screen.findByText("message 2");
    const scroller = container.querySelector(".chat-history") as HTMLElement;
    scroller.scrollTop = 200;
    fireEvent.scroll(scroller);
    await settle();
    expect(history).toHaveBeenCalledTimes(1);
  });

  test("shows a cached badge when the page came from the cache", async () => {
    const { client } = fakeClient({ first: { messages: [msg(1)], fromCache: true } });
    render(<History bridge={client} channelId="C1" />);
    await screen.findByText("message 1");
    expect(screen.getByText("cached")).toBeTruthy();
  });

  test("renders message text as text, never as HTML", async () => {
    const evil = [msg(1, { text: "<b>x</b>" }), msg(2, { text: "<img src=x onerror=alert(1)>" })];
    const { client } = fakeClient({ first: { messages: evil, fromCache: false } });
    const { container } = render(<History bridge={client} channelId="C1" />);
    await screen.findByText("<b>x</b>");
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  test("detects http(s) links and hands them to onOpenLink instead of navigating", async () => {
    const text = "see https://example.com/a?b=1 now javascript:alert(1)";
    const { client } = fakeClient({ first: { messages: [msg(1, { text })], fromCache: false } });
    const onOpenLink = vi.fn();
    const { container } = render(<History bridge={client} channelId="C1" onOpenLink={onOpenLink} />);
    const link = await waitFor(() => {
      const el = container.querySelector(".chat-link");
      if (!el) throw new Error("no link yet");
      return el;
    });
    expect(link.textContent).toBe("https://example.com/a?b=1");
    expect(container.querySelectorAll(".chat-link").length).toBe(1);
    expect(link.getAttribute("href")).toBeNull();
    fireEvent.click(link);
    expect(onOpenLink).toHaveBeenCalledWith("https://example.com/a?b=1");
    expect(container.querySelector(".chat-text")?.textContent).toBe(text);
  });

  test("uses a data: avatar from slack.users but ignores remote avatar URLs", async () => {
    const m = [msg(1), msg(2, { author: { id: "U2", name: "brandon", isBot: false } })];
    const client = {
      request: vi.fn(async (name: string) =>
        name === "slack.history"
          ? { messages: m, fromCache: false }
          : [
              { id: "U1", name: "adrian", displayName: "Adrian", isBot: false, avatarUrl: "data:image/png;base64,AAAA" },
              { id: "U2", name: "brandon", displayName: "Brandon", isBot: false, avatarUrl: "https://avatars.slack-edge.com/x.png" },
            ]),
      subscribe: vi.fn(),
    } as unknown as BridgeClient;
    const { container } = render(<History bridge={client} channelId="C1" />);
    await screen.findByText("message 2");
    await waitFor(() => expect(container.querySelectorAll("img.chat-avatar").length).toBe(1));
    expect(container.querySelector("img.chat-avatar")?.getAttribute("src")).toMatch(/^data:/);
    expect(container.innerHTML).not.toContain("slack-edge.com");
  });

  test("clicking the reply count calls onOpenThread when provided", async () => {
    const { client } = fakeClient({ first: { messages: [msg(1, { replyCount: 3 })], fromCache: false } });
    const onOpenThread = vi.fn();
    render(<History bridge={client} channelId="C1" onOpenThread={onOpenThread} />);
    fireEvent.click(await screen.findByText("↳ 3"));
    expect(onOpenThread).toHaveBeenCalledWith(expect.objectContaining({ replyCount: 3 }));
  });
});
