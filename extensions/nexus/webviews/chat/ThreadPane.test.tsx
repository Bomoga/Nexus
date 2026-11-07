// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../src/contracts";
import { App } from "./App";
import { ThreadPane } from "./ThreadPane";
import { createTestHost } from "./testHost";
import type { TestHost } from "./testHost";

afterEach(cleanup);

const THREAD = "1762485300.000100";
const brandon = { id: "U_BRANDON", name: "brandon", isBot: false };
const reply = (host: TestHost, n: number, threadTs: string, text: string): ChatMessage => {
  const ts = host.slackTs(n);
  return { id: `C_DEMO:${ts}`, channelId: "C_DEMO", ts, threadTs, author: brandon, text, codeRefs: [], sentVia: "user" };
};

describe("ThreadPane", () => {
  test("loads slack.thread and lists the parent and replies oldest first", async () => {
    const host = createTestHost();
    const { container } = render(<ThreadPane bridge={host.client} channelId="C_DEMO" threadTs={THREAD} onClose={() => undefined} />);
    await screen.findByText("can an agent take this?");
    const texts = [...container.querySelectorAll(".chat-text")].map((e) => e.textContent ?? "");
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatch(/cart total ignores the discount/);
    expect(texts[1]).toBe("can an agent take this?");
  });

  test("MAKE TASK runs nexus.makeTaskFromThread with channelId and threadTs", async () => {
    const host = createTestHost();
    const runCommand = vi.fn(async () => undefined);
    render(<ThreadPane bridge={host.client} channelId="C_DEMO" threadTs={THREAD} onClose={() => undefined} runCommand={runCommand} />);
    await screen.findByText("can an agent take this?");
    fireEvent.click(screen.getByText("MAKE TASK"));
    expect(runCommand).toHaveBeenCalledWith("nexus.makeTaskFromThread", { channelId: "C_DEMO", threadTs: THREAD });
  });

  test("MAKE TASK reports a failed command", async () => {
    const host = createTestHost();
    const runCommand = vi.fn(async () => {
      throw new Error("nope");
    });
    render(<ThreadPane bridge={host.client} channelId="C_DEMO" threadTs={THREAD} onClose={() => undefined} runCommand={runCommand} />);
    await screen.findByText("can an agent take this?");
    fireEvent.click(screen.getByText("MAKE TASK"));
    await screen.findByText("could not make a task");
  });

  test("without a command runner MAKE TASK falls back to tasks.createFromThread over the bridge", async () => {
    const host = createTestHost();
    render(<ThreadPane bridge={host.client} channelId="C_DEMO" threadTs={THREAD} onClose={() => undefined} />);
    await screen.findByText("can an agent take this?");
    fireEvent.click(screen.getByText("MAKE TASK"));
    await screen.findByText("task drafted");
  });

  test("MAKE TASK is disabled after the task is drafted", async () => {
    const host = createTestHost();
    render(<ThreadPane bridge={host.client} channelId="C_DEMO" threadTs={THREAD} onClose={() => undefined} />);
    await screen.findByText("can an agent take this?");
    fireEvent.click(screen.getByText("MAKE TASK"));
    await screen.findByText("task drafted");
    expect((screen.getByText("MAKE TASK").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  test("renders thread text as text, never as HTML", async () => {
    const host = createTestHost();
    render(<ThreadPane bridge={host.client} channelId="C_DEMO" threadTs={THREAD} onClose={() => undefined} />);
    await screen.findByText("can an agent take this?");
    act(() => host.emit({ type: "message", message: reply(host, 7, THREAD, "<b>bold</b> <script>alert(1)</script>") }));
    const el = await screen.findByText("<b>bold</b> <script>alert(1)</script>");
    expect(el.querySelector("b")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });

  test("live replies to this thread append; other threads are ignored", async () => {
    const host = createTestHost();
    render(<ThreadPane bridge={host.client} channelId="C_DEMO" threadTs={THREAD} onClose={() => undefined} />);
    await screen.findByText("can an agent take this?");
    act(() => host.emit({ type: "message", message: reply(host, 8, "1762400000.000100", "elsewhere") }));
    act(() => host.emit({ type: "message", message: reply(host, 9, THREAD, "right here") }));
    await screen.findByText("right here");
    expect(screen.queryByText("elsewhere")).toBeNull();
  });

  test("CLOSE calls onClose", async () => {
    const host = createTestHost();
    const onClose = vi.fn();
    render(<ThreadPane bridge={host.client} channelId="C_DEMO" threadTs={THREAD} onClose={onClose} />);
    await screen.findByText("can an agent take this?");
    fireEvent.click(screen.getByText("CLOSE"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("App thread wiring", () => {
  test("clicking a parent opens the thread pane", async () => {
    const host = createTestHost();
    const { container } = render(<App bridge={host.client} />);
    const parent = (await screen.findByText(/cart total ignores the discount/)).closest(".chat-row") as HTMLElement;
    fireEvent.click(parent);
    await screen.findByText("can an agent take this?");
    expect(container.querySelector(".chat-thread")).not.toBeNull();
    fireEvent.click(screen.getByText("CLOSE"));
    await waitFor(() => expect(container.querySelector(".chat-thread")).toBeNull());
  });
});
