// @vitest-environment jsdom
// The app-owned outbox: pending echoes are confirmed only by an exact clientId (or the ts the post reply
// gave), and they outlive the view that sent them.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../src/contracts";
import { App } from "./App";
import { History } from "./History";
import { confirms } from "./outbox";
import type { OutboxEntry } from "./outbox";
import { ThreadPane } from "./ThreadPane";
import { createTestHost } from "./testHost";
import type { TestHost } from "./testHost";

afterEach(cleanup);

const THREAD = "1762485300.000100";
const OTHER_THREAD = "1762400000.000100";
const adrian = { id: "U_ADRIAN", name: "adrian", isBot: false };
const settle = () => new Promise((r) => setTimeout(r, 20));
const box = (label = "message") => screen.getByLabelText(label) as HTMLTextAreaElement;
const send = (text: string, label = "message") => {
  fireEvent.change(box(label), { target: { value: text } });
  fireEvent.keyDown(box(label), { key: "Enter" });
};
const deliver = (host: TestHost, message: ChatMessage) => act(() => host.emit({ type: "message", message }));
const threadPane = (container: HTMLElement) => container.querySelector(".chat-thread") as HTMLElement;

async function openThread(container: HTMLElement) {
  const parent = (await screen.findByText(/cart total ignores the discount/)).closest(".chat-row") as HTMLElement;
  fireEvent.click(parent);
  await waitFor(() => expect(threadPane(container)).not.toBeNull());
  await within(threadPane(container)).findByText("can an agent take this?");
  await settle();
}

async function closeThread(container: HTMLElement) {
  fireEvent.click(within(threadPane(container)).getByText("CLOSE"));
  await waitFor(() => expect(threadPane(container)).toBeNull());
}

async function selectChannel(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
  await settle();
}

describe("exact matching (failure 1)", () => {
  test("an older message of ours with the same text never deletes a failed send or its RETRY", async () => {
    const older: ChatMessage = { id: "C_DEMO:1762480000.000100", channelId: "C_DEMO", ts: "1762480000.000100", author: adrian, text: "ok", codeRefs: [], sentVia: "user" };
    const olderStill: ChatMessage = { ...older, id: "C_DEMO:1762479000.000100", ts: "1762479000.000100" };
    const host = createTestHost({ history: ({ channelId }) => ({ messages: channelId === "C_DEMO" ? [older] : [], fromCache: false }) });
    host.failNextPost();
    const { rerender } = render(<History bridge={host.client} channelId="C_DEMO" />);
    await screen.findByText("ok");
    await settle();
    send("ok");
    await screen.findByText("RETRY");
    // An older "ok" of ours turns up live (re-delivered from beyond the loaded page): it is not our failed send.
    deliver(host, olderStill);
    await waitFor(() => expect(screen.getAllByText("ok")).toHaveLength(3));
    expect(screen.getByText("RETRY")).toBeTruthy();
    // Leaving and coming back reloads the history that holds the older "ok": the failed send stays.
    rerender(<History bridge={host.client} channelId="C_BUILD" />);
    await screen.findByText("no messages yet");
    rerender(<History bridge={host.client} channelId="C_DEMO" />);
    await screen.findByText("RETRY");
    await settle();
    expect(screen.getByText("RETRY")).toBeTruthy();
    expect(host.posts).toHaveLength(1);
  });
});

describe("delivery while elsewhere (failure 2)", () => {
  test("a send Slack delivered while the user was in another channel is neither doubled nor turned into RETRY by a timeout", async () => {
    let page: ChatMessage[] = [];
    const host = createTestHost({ history: ({ channelId }) => ({ messages: channelId === "C_DEMO" ? page : [], fromCache: false }) });
    host.holdPosts();
    const { rerender, container } = render(<History bridge={host.client} channelId="C_DEMO" />);
    await screen.findByText("no messages yet");
    await settle();
    send("ship");
    await screen.findByText("ship");
    rerender(<History bridge={host.client} channelId="C_BUILD" />);
    await screen.findByText("no messages yet");
    await settle();
    deliver(host, host.copyOf(host.posts[0]));
    await settle();
    host.releaseOffline();
    await settle();
    // Slack's history has no clientId; only the outbox knows the send was confirmed.
    page = [host.copyOf(host.posts[0], { clientId: false })];
    rerender(<History bridge={host.client} channelId="C_DEMO" />);
    await screen.findByText("ship");
    await settle();
    expect(screen.getAllByText("ship")).toHaveLength(1);
    expect(container.querySelector(".chat-row--pending")).toBeNull();
    expect(screen.queryByText("RETRY")).toBeNull();
    expect(host.posts).toHaveLength(1);
  });
});

describe("post results reach the view showing the message now (failure 3)", () => {
  test("closing and reopening the thread pane while a reply is in flight: the reopened pane shows it pending, then confirmed", async () => {
    const host = createTestHost();
    host.holdPosts();
    const { container } = render(<App bridge={host.client} />);
    await openThread(container);
    send("on it", "reply");
    await within(threadPane(container)).findByText("on it");
    await closeThread(container);
    await openThread(container);
    await within(threadPane(container)).findByText("on it");
    expect(threadPane(container).querySelector(".chat-row--pending")).not.toBeNull();
    host.release();
    await waitFor(() => expect(threadPane(container).querySelector(".chat-row--pending")).toBeNull());
    expect(within(threadPane(container)).getAllByText("on it")).toHaveLength(1);
  });

  test("a reply confirmed while the pane was closed shows once, never as a stale pending row", async () => {
    const host = createTestHost();
    host.holdPosts();
    const { container } = render(<App bridge={host.client} />);
    await openThread(container);
    send("done soon", "reply");
    await within(threadPane(container)).findByText("done soon");
    await closeThread(container);
    host.release();
    await settle();
    await openThread(container);
    await within(threadPane(container)).findByText("done soon");
    deliver(host, host.copyOf(host.posts[0]));
    await settle();
    expect(threadPane(container).querySelector(".chat-row--pending")).toBeNull();
    expect(within(threadPane(container)).getAllByText("done soon")).toHaveLength(1);
  });

  test("switching channel and back while a send is in flight: the row settles confirmed", async () => {
    const host = createTestHost();
    host.holdPosts();
    const { container } = render(<App bridge={host.client} />);
    await screen.findByText(/cart total ignores the discount/);
    await settle();
    send("round trip");
    await screen.findByText("round trip");
    await selectChannel("nexus-build");
    await screen.findByText("no messages yet");
    host.release();
    await settle();
    await selectChannel("nexus-demo");
    await screen.findByText("round trip");
    await settle();
    expect(screen.getAllByText("round trip")).toHaveLength(1);
    expect(container.querySelector(".chat-row--pending")).toBeNull();
  });

  test("switching channel and back while a send is in flight: a rejected post settles as RETRY", async () => {
    const host = createTestHost();
    host.holdPosts();
    host.failNextPost();
    const { container } = render(<App bridge={host.client} />);
    await screen.findByText(/cart total ignores the discount/);
    await settle();
    send("bounced");
    await screen.findByText("bounced");
    await selectChannel("nexus-build");
    await selectChannel("nexus-demo");
    await screen.findByText("bounced");
    expect(container.querySelector(".chat-row--pending")).not.toBeNull();
    host.release();
    await screen.findByText("RETRY");
    expect(container.querySelector(".chat-row--pending")).toBeNull();
    expect(screen.getAllByText("bounced")).toHaveLength(1);
  });
});

describe("thread replies and drafts outlive the pane (failure 4)", () => {
  test("a failed thread reply survives closing and reopening the pane, and RETRY there re-sends it", async () => {
    const host = createTestHost();
    host.failNextPost();
    const { container } = render(<App bridge={host.client} />);
    await openThread(container);
    send("will fail", "reply");
    await within(threadPane(container)).findByText("RETRY");
    await closeThread(container);
    await openThread(container);
    await within(threadPane(container)).findByText("will fail");
    fireEvent.click(within(threadPane(container)).getByText("RETRY"));
    await waitFor(() => expect(within(threadPane(container)).queryByText("RETRY")).toBeNull());
    expect(host.posts).toHaveLength(2);
    expect(host.posts[1]).toMatchObject({ clientId: host.posts[0].clientId, threadTs: THREAD, text: "will fail" });
    expect(within(threadPane(container)).getAllByText("will fail")).toHaveLength(1);
  });

  test("drafts are kept per channel and per thread, and never move to another target", async () => {
    const host = createTestHost();
    const { container } = render(<App bridge={host.client} />);
    await openThread(container);
    fireEvent.change(box("reply"), { target: { value: "thread draft" } });
    fireEvent.change(box("message"), { target: { value: "channel draft" } });
    await closeThread(container);
    await openThread(container);
    expect(box("reply").value).toBe("thread draft");
    expect(box("message").value).toBe("channel draft");
    await selectChannel("nexus-build");
    await screen.findByText("no messages yet");
    expect(box("message").value).toBe("");
    expect(screen.queryByLabelText("reply")).toBeNull();
    await selectChannel("nexus-demo");
    await screen.findByText(/cart total ignores the discount/);
    expect(box("message").value).toBe("channel draft");
    expect(host.posts).toHaveLength(0);
  });
});

describe("MAKE TASK follows the open thread (failure 5)", () => {
  test("a MAKE TASK started on one thread neither blocks nor reports on the thread opened next", async () => {
    const host = createTestHost();
    const finishers: Array<() => void> = [];
    const runCommand = vi.fn(() => new Promise<void>((r) => finishers.push(r)));
    const pane = (threadTs: string) => <ThreadPane bridge={host.client} channelId="C_DEMO" threadTs={threadTs} onClose={() => undefined} runCommand={runCommand} />;
    const { rerender } = render(pane(THREAD));
    await screen.findByText("can an agent take this?");
    fireEvent.click(screen.getByText("MAKE TASK"));
    rerender(pane(OTHER_THREAD));
    await settle();
    await act(async () => finishers[0]());
    await settle();
    expect(screen.queryByText("task drafted")).toBeNull();
    const button = screen.getByText("MAKE TASK").closest("button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(runCommand).toHaveBeenLastCalledWith("nexus.makeTaskFromThread", { channelId: "C_DEMO", threadTs: OTHER_THREAD });
    await act(async () => finishers[1]());
    await screen.findByText("task drafted");
    rerender(pane(THREAD));
    await settle();
    expect(screen.getByText("task drafted")).toBeTruthy();
  });
});

describe("confirms", () => {
  test("matches only by clientId or the ts the post reply gave, never by text, author or target", () => {
    const entry: OutboxEntry = { clientId: "nx-1", channelId: "C_DEMO", text: "ok", state: "failed", sentAt: "1762490000.000001" };
    const m: ChatMessage = { id: "C_DEMO:1762490000.000005", channelId: "C_DEMO", ts: "1762490000.000005", author: adrian, text: "ok", codeRefs: [], sentVia: "user" };
    expect([
      confirms(entry, m),
      confirms(entry, { ...m, clientId: "nx-2" }),
      confirms(entry, { ...m, clientId: "nx-1", text: "edited" }),
      confirms({ ...entry, confirmedTs: m.ts }, m),
      confirms({ ...entry, confirmedTs: m.ts }, { ...m, channelId: "C_BUILD" }),
    ]).toEqual([false, false, true, true, false]);
  });
});

describe("confirmation rules", () => {
  const ready = async (host: TestHost) => {
    const view = render(<History bridge={host.client} channelId="C_DEMO" />);
    await screen.findByText(/cart total ignores the discount/);
    await settle();
    return view;
  };

  test("a post reply without clientId confirms by ts; the subscription copy without clientId does not", async () => {
    const host = createTestHost({ echoClientId: false });
    host.holdPosts();
    const { container } = await ready(host);
    send("hi");
    await screen.findByText("hi");
    deliver(host, host.copyOf(host.posts[0]));
    await waitFor(() => expect(screen.getAllByText("hi")).toHaveLength(2));
    expect(container.querySelectorAll(".chat-row--pending")).toHaveLength(1);
    host.release();
    await waitFor(() => expect(container.querySelector(".chat-row--pending")).toBeNull());
    expect(screen.getAllByText("hi")).toHaveLength(1);
  });

  test("a subscription copy with the clientId arriving before the post reply confirms it, and the reply adds nothing", async () => {
    const host = createTestHost();
    host.holdPosts();
    const { container } = await ready(host);
    send("early");
    await screen.findByText("early");
    deliver(host, host.copyOf(host.posts[0]));
    await waitFor(() => expect(container.querySelector(".chat-row--pending")).toBeNull());
    expect(screen.getAllByText("early")).toHaveLength(1);
    host.release();
    await settle();
    expect(screen.getAllByText("early")).toHaveLength(1);
    expect(container.querySelector(".chat-row--pending")).toBeNull();
  });

  test("a bridge timeout leaves the send dim and 'not confirmed' with RETRY; a later copy with its clientId confirms it", async () => {
    const host = createTestHost({ postTimeoutMs: 40 });
    host.holdPosts();
    const { container } = await ready(host);
    send("slow");
    await screen.findByText("not confirmed");
    expect(screen.getByText("RETRY")).toBeTruthy();
    expect(container.querySelector(".chat-row--pending")).not.toBeNull();
    expect(container.querySelector(".chat-failed")).toBeNull();
    deliver(host, host.copyOf(host.posts[0]));
    await waitFor(() => expect(screen.queryByText("not confirmed")).toBeNull());
    expect(screen.queryByText("RETRY")).toBeNull();
    expect(screen.getAllByText("slow")).toHaveLength(1);
    expect(container.querySelector(".chat-row--pending")).toBeNull();
    expect(host.posts).toHaveLength(1);
  });

  test("RETRY after a timeout re-sends with the same clientId and goes back to pending", async () => {
    const host = createTestHost({ postTimeoutMs: 40 });
    host.holdPosts();
    const { container } = await ready(host);
    send("again");
    await screen.findByText("not confirmed");
    fireEvent.click(screen.getByText("RETRY"));
    await waitFor(() => expect(host.posts).toHaveLength(2));
    expect(host.posts[1].clientId).toBe(host.posts[0].clientId);
    expect(screen.queryByText("not confirmed")).toBeNull();
    expect(container.querySelector(".chat-row--pending")).not.toBeNull();
    host.held()[1].ok();
    await waitFor(() => expect(container.querySelector(".chat-row--pending")).toBeNull());
    expect(screen.getAllByText("again")).toHaveLength(1);
    expect(screen.queryByText("RETRY")).toBeNull();
  });

  test("two identical texts sent back to back stay two entries and settle independently", async () => {
    const host = createTestHost();
    host.holdPosts();
    host.failNextPost();
    const { container } = await ready(host);
    send("ok");
    send("ok");
    await waitFor(() => expect(screen.getAllByText("ok")).toHaveLength(2));
    expect(host.posts).toHaveLength(2);
    expect(host.posts[0].clientId).not.toBe(host.posts[1].clientId);
    host.held()[1].ok();
    await waitFor(() => expect(container.querySelectorAll(".chat-row--pending")).toHaveLength(1));
    expect(screen.getAllByText("ok")).toHaveLength(2);
    host.held()[0].fail();
    await screen.findByText("RETRY");
    expect(container.querySelector(".chat-row--pending")).toBeNull();
    expect(screen.getAllByText("ok")).toHaveLength(2);
    // A copy of the confirmed one arriving again changes nothing for the failed one.
    deliver(host, host.copyOf(host.posts[1]));
    await settle();
    expect(screen.getByText("RETRY")).toBeTruthy();
    fireEvent.click(screen.getByText("RETRY"));
    await waitFor(() => expect(host.posts).toHaveLength(3));
    expect(host.posts[2].clientId).toBe(host.posts[0].clientId);
    host.release();
    await waitFor(() => expect(container.querySelector(".chat-row--pending")).toBeNull());
    expect(screen.queryByText("RETRY")).toBeNull();
    expect(screen.getAllByText("ok")).toHaveLength(2);
  });
});
