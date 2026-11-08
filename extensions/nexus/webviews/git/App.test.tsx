// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App, sessionIdOf } from "./App";
import type { BridgeClient } from "../shared";
import type { NexusEvent } from "../../src/contracts";

afterEach(cleanup);

const SHA = "3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21";
const NOW = Date.parse("2026-11-08T03:00:00Z");

function event(over: Partial<NexusEvent> & { id: string }): NexusEvent {
  return {
    kind: "commit",
    at: new Date(NOW - 3_600_000).toISOString(),
    orbit: "main",
    title: "fix cart discount for qty > 1",
    actor: { name: "adrian", kind: "human" },
    target: { type: "commit", sha: SHA },
    ...over,
  } as NexusEvent;
}

function fakeBridge(over: Partial<Record<string, (body: unknown) => unknown>> = {}) {
  const calls: { name: string; body: unknown }[] = [];
  const handlers: Record<string, (body: unknown) => unknown> = {
    "git.branches": () => [
      { name: "main", head: SHA, isCurrent: true, isAgent: false },
      { name: "nexus/agent-ses_01", head: SHA, isCurrent: false, isAgent: true },
    ],
    "events.query": () => [event({ id: "e1" }), event({ id: "e2", kind: "merge", title: "merge lane-2", at: new Date(NOW - 60_000).toISOString() })],
    "git.mergeAgentBranch": () => ({ ok: true, mergeSha: "9b1d2e0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", message: "merged" }),
    "ui.openTarget": () => ({}),
    "store.status": () => ({ online: true, outboxDepth: 0 }),
    ...over,
  };
  const bridge = {
    request: vi.fn(async (name: string, body: unknown) => {
      calls.push({ name, body });
      const h = handlers[name];
      if (!h) throw new Error(`no handler ${name}`);
      return h(body);
    }),
    subscribe: vi.fn(() => () => undefined),
    dispose: () => undefined,
  } as unknown as BridgeClient;
  return { bridge, calls };
}

describe("sessionIdOf", () => {
  it("reads the session id from an agent branch only", () => {
    expect(sessionIdOf("nexus/agent-ses_01")).toBe("ses_01");
    expect(sessionIdOf("main")).toBeUndefined();
    expect(sessionIdOf("nexus/agent-")).toBeUndefined();
    expect(sessionIdOf("nexus/agent-a/b")).toBeUndefined();
  });
});

describe("git view", () => {
  it("lists branches, agent branches and the last 24 h of commits, newest first", async () => {
    const { bridge, calls } = fakeBridge();
    render(<App bridge={bridge} now={NOW} />);
    await waitFor(() => expect(screen.getByText("CURRENT")).toBeTruthy());
    expect(screen.getByText("AGENT")).toBeTruthy();
    const q = calls.find((c) => c.name === "events.query")!.body as { from: string; to: string; kinds: string[] };
    expect(q.kinds).toEqual(["commit", "merge"]);
    expect(Date.parse(q.to) - Date.parse(q.from)).toBe(24 * 3_600_000 + 60_000);
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector(".git-commit-title")!.textContent)).toEqual(["merge lane-2", "fix cart discount for qty > 1"]);
    expect(rows[1].querySelector(".nx-data:nth-child(2)")!.textContent).toBe("3f2a9c1");
  });

  it("opens a commit through ui.openTarget on click and on Enter", async () => {
    const { bridge, calls } = fakeBridge();
    render(<App bridge={bridge} now={NOW} />);
    const rows = await screen.findAllByRole("listitem");
    fireEvent.click(rows[1]);
    fireEvent.keyDown(rows[0], { key: "Enter" });
    await waitFor(() => expect(calls.filter((c) => c.name === "ui.openTarget")).toHaveLength(2));
    expect(calls.filter((c) => c.name === "ui.openTarget")[0].body).toEqual({ type: "commit", sha: SHA });
  });

  it("merges an agent branch only after the inline confirm and shows the result", async () => {
    const { bridge, calls } = fakeBridge();
    render(<App bridge={bridge} now={NOW} />);
    const merge = await screen.findByRole("button", { name: "MERGE" });
    fireEvent.click(merge);
    expect(calls.filter((c) => c.name === "git.mergeAgentBranch")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /CONFIRM MERGE/ }));
    await waitFor(() => expect(screen.getByText(/merged as 9b1d2e0/)).toBeTruthy());
    expect(calls.find((c) => c.name === "git.mergeAgentBranch")!.body).toEqual({ sessionId: "ses_01" });
  });

  it("shows a clean-abort message in red when the merge conflicts", async () => {
    const { bridge } = fakeBridge({ "git.mergeAgentBranch": () => ({ ok: false, message: "merge aborted: conflicts in src/cart.ts" }) });
    render(<App bridge={bridge} now={NOW} />);
    fireEvent.click(await screen.findByRole("button", { name: "MERGE" }));
    fireEvent.click(screen.getByRole("button", { name: /CONFIRM MERGE/ }));
    const line = await screen.findByText(/merge aborted: conflicts/);
    expect(line.closest(".nx-status-line")!.className).toContain("nx-tone-error");
  });

  it("shows error lines with RETRY and empty states as one line", async () => {
    const { bridge } = fakeBridge({
      "git.branches": () => {
        throw new Error("git is not available");
      },
      "events.query": () => [],
    });
    render(<App bridge={bridge} now={NOW} />);
    await waitFor(() => expect(screen.getByText("no commits in the last 24 h")).toBeTruthy());
    expect(screen.getAllByRole("button", { name: "RETRY" })).toHaveLength(1);
  });
});
