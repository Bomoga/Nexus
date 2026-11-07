// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../src/contracts";
import { Composer } from "./Composer";
import { History } from "./History";
import { ThreadPane } from "./ThreadPane";
import { createTestHost } from "./testHost";

afterEach(cleanup);

const settle = () => new Promise((r) => setTimeout(r, 20));
const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const brandon = { id: "U_BRANDON", name: "brandon", isBot: false };

describe("Composer", () => {
  test("Enter sends the trimmed text and clears the box", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    type("  hello  ");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hello");
    expect(box().value).toBe("");
  });

  test("SEND button sends", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    type("hi");
    fireEvent.click(screen.getByText("SEND"));
    expect(onSend).toHaveBeenCalledWith("hi");
  });

  test("Shift+Enter does not send (it inserts a newline)", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    type("a");
    const notPrevented = fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  test("empty or whitespace-only text does not send", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    fireEvent.keyDown(box(), { key: "Enter" });
    type("   \n ");
    fireEvent.keyDown(box(), { key: "Enter" });
    fireEvent.click(screen.getByText("SEND"));
    expect(onSend).not.toHaveBeenCalled();
  });

  test("Enter during IME composition does not send", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    type("x");
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("posting from the channel view", () => {
  test("shows a dimmed pending echo at once, then Slack's copy from slack.subscribe replaces it", async () => {
    const host = createTestHost();
    host.holdPosts();
    const { container } = render(<History bridge={host.client} channelId="C_DEMO" />);
    await screen.findByText(/cart total ignores the discount/);
    type("shipping it");
    fireEvent.keyDown(box(), { key: "Enter" });
    const row = (await screen.findByText("shipping it")).closest(".chat-row") as HTMLElement;
    expect(row.classList.contains("chat-row--pending")).toBe(true);
    expect(host.posts).toHaveLength(1);
    expect(host.posts[0]).toMatchObject({ channelId: "C_DEMO", text: "shipping it" });
    expect(host.posts[0].threadTs).toBeUndefined();
    expect(host.posts[0].clientId.length).toBeGreaterThan(0);

    // Slack's copy arrives on the subscription before the post reply.
    const ts = host.slackTs(1);
    act(() => host.emit({ type: "message", message: { id: `C_DEMO:${ts}`, channelId: "C_DEMO", ts, author: { id: "U_ADRIAN", name: "adrian", isBot: false }, text: "shipping it", codeRefs: [], sentVia: "user" } }));
    await waitFor(() => expect(container.querySelectorAll(".chat-text").length).toBe(2));
    expect(container.querySelector(".chat-row--pending")).toBeNull();
    expect(screen.getAllByText("shipping it")).toHaveLength(1);

    host.release();
    await settle();
    expect(screen.getAllByText("shipping it")).toHaveLength(1);
  });

  test("the post reply also replaces the pending echo", async () => {
    const host = createTestHost();
    const { container } = render(<History bridge={host.client} channelId="C_DEMO" />);
    await screen.findByText(/cart total ignores the discount/);
    type("hello");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(container.querySelector(".chat-row--pending")).toBeNull());
    expect(screen.getAllByText("hello")).toHaveLength(1);
  });

  test("a failed send shows a red RETRY and retrying re-sends with the same clientId", async () => {
    const host = createTestHost();
    host.failNextPost();
    const { container } = render(<History bridge={host.client} channelId="C_DEMO" />);
    await screen.findByText(/cart total ignores the discount/);
    type("flaky");
    fireEvent.keyDown(box(), { key: "Enter" });
    const retry = await screen.findByText("RETRY");
    expect(container.querySelector(".chat-row--pending")).toBeNull();
    expect(container.querySelector(".chat-failed")).not.toBeNull();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByText("RETRY")).toBeNull());
    expect(host.posts).toHaveLength(2);
    expect(host.posts[1].clientId).toBe(host.posts[0].clientId);
    expect(host.posts[1].text).toBe("flaky");
    expect(screen.getAllByText("flaky")).toHaveLength(1);
  });

  test("message text typed by the user is rendered literally", async () => {
    const host = createTestHost();
    host.holdPosts();
    const { container } = render(<History bridge={host.client} channelId="C_DEMO" />);
    await screen.findByText(/cart total ignores the discount/);
    type("<img src=x onerror=alert(1)>");
    fireEvent.keyDown(box(), { key: "Enter" });
    await screen.findByText("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
  });

  test("live messages from other people append and message_changed replaces", async () => {
    const host = createTestHost();
    render(<History bridge={host.client} channelId="C_DEMO" />);
    await screen.findByText(/cart total ignores the discount/);
    expect(host.subscribed).toContainEqual(["C_DEMO"]);
    const ts = host.slackTs(2);
    const base: ChatMessage = { id: `C_DEMO:${ts}`, channelId: "C_DEMO", ts, author: brandon, text: "live one", codeRefs: [], sentVia: "user" };
    act(() => host.emit({ type: "message", message: base }));
    await screen.findByText("live one");
    act(() => host.emit({ type: "message_changed", message: { ...base, text: "live one (edited)" } }));
    await screen.findByText("live one (edited)");
    expect(screen.queryByText("live one")).toBeNull();
  });

  const liveAt = async (scrollTop: number, text: string, n: number) => {
    const host = createTestHost();
    const { container } = render(<History bridge={host.client} channelId="C_DEMO" />);
    await screen.findByText(/cart total ignores the discount/);
    const scroller = container.querySelector(".chat-history") as HTMLElement;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 100 });
    scroller.scrollTop = scrollTop;
    fireEvent.scroll(scroller);
    const ts = host.slackTs(n);
    act(() => host.emit({ type: "message", message: { id: `C_DEMO:${ts}`, channelId: "C_DEMO", ts, author: brandon, text, codeRefs: [], sentVia: "user" } }));
    await screen.findByText(text);
    return scroller;
  };

  test("a live message does not move the scroll position when the reader is not at the bottom", async () => {
    const scroller = await liveAt(300, "while reading", 3);
    expect(scroller.scrollTop).toBe(300);
  });

  test("a live message follows to the bottom when the reader is at the bottom", async () => {
    const scroller = await liveAt(900, "at bottom", 4);
    expect(scroller.scrollTop).toBe(1000);
  });

  test("a live reply bumps the parent's reply count instead of joining the channel list", async () => {
    const host = createTestHost();
    const { container } = render(<History bridge={host.client} channelId="C_DEMO" />);
    await screen.findByText("↳ 1");
    const ts = host.slackTs(5);
    const reply: ChatMessage = { id: `C_DEMO:${ts}`, channelId: "C_DEMO", ts, threadTs: "1762485300.000100", author: brandon, text: "a reply", codeRefs: [], sentVia: "user" };
    act(() => host.emit({ type: "message", message: reply }));
    await screen.findByText("↳ 2");
    expect(screen.queryByText("a reply")).toBeNull();
    expect(container.querySelectorAll(".chat-row").length).toBe(1);
  });
});

describe("posting from the thread pane", () => {
  test("a reply posts with threadTs and appears pending, then confirmed", async () => {
    const host = createTestHost();
    host.holdPosts();
    const { container } = render(<ThreadPane bridge={host.client} channelId="C_DEMO" threadTs="1762485300.000100" onClose={() => undefined} />);
    await screen.findByText("can an agent take this?");
    type("on it");
    fireEvent.keyDown(box(), { key: "Enter" });
    const row = (await screen.findByText("on it")).closest(".chat-row") as HTMLElement;
    expect(row.classList.contains("chat-row--pending")).toBe(true);
    expect(host.posts[0]).toMatchObject({ channelId: "C_DEMO", text: "on it", threadTs: "1762485300.000100" });
    host.release();
    await waitFor(() => expect(container.querySelector(".chat-row--pending")).toBeNull());
    expect(screen.getAllByText("on it")).toHaveLength(1);
  });
});
