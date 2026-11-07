// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Envelope, NexusEvent } from "../../src/contracts";
import { fx } from "../../src/contracts/fixtures";
import { createBridgeClient } from "../shared";
import type { Transport } from "../shared";
import { DetailStrip } from "./DetailStrip";

afterEach(cleanup);

const T0_MS = Date.parse("2026-11-07T03:15:00Z");
const SHA = "3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21";

function scripted() {
  const posted: Envelope[] = [];
  const listeners = new Set<(env: Envelope) => void>();
  const transport: Transport = {
    post(env) {
      posted.push(env);
      if (env.t === "req") queueMicrotask(() => listeners.forEach((l) => l({ t: "res", id: env.id, ok: true, body: {} })));
    },
    listen(h) {
      listeners.add(h);
      return () => listeners.delete(h);
    },
  };
  const client = createBridgeClient(transport);
  return { posted, open: (t: NexusEvent["target"]) => client.request("ui.openTarget", t) };
}

const commit: NexusEvent = { ...fx.event, at: "2026-11-07T05:20:00Z", orbit: "lane-3" };
const session: NexusEvent = { ...fx.event, id: "s1", kind: "agent_session", title: "fix flaky test", actor: { name: "nexus-agent", kind: "agent" }, target: { type: "session", sessionId: "01JABCDEFGHJKMNPQRSTVWXYZ0" } };
const thread: NexusEvent = { ...fx.event, id: "t1", kind: "slack_task", title: "ship the cart", target: { type: "thread", channelId: "C1", threadTs: "1731000000.000100" } };

describe("DetailStrip", () => {
  test("renders a commit's fields", () => {
    render(<DetailStrip event={commit} t0Ms={T0_MS} open={scripted().open} />);
    const strip = screen.getByRole("group", { name: "Selected event" });
    expect(strip.textContent).toContain("commit");
    expect(strip.textContent).toContain("add cart module");
    expect(strip.textContent).toContain("lane-3");
    expect(strip.textContent).toContain("T+02:05");
    expect(strip.textContent).toContain(SHA.slice(0, 7));
    expect(strip.textContent).toContain("Adrian");
    expect(screen.getByRole("button", { name: /open/i })).toBeTruthy();
  });

  test("renders session and thread ids", () => {
    const { unmount } = render(<DetailStrip event={session} t0Ms={T0_MS} open={scripted().open} />);
    expect(screen.getByRole("group").textContent).toContain("agent_session");
    expect(screen.getByRole("group").textContent).toContain("01JABCDE");
    expect(screen.getByRole("group").textContent).toContain("nexus-agent");
    unmount();
    render(<DetailStrip event={thread} t0Ms={T0_MS} open={scripted().open} />);
    expect(screen.getByRole("group").textContent).toContain("slack_task");
    expect(screen.getByRole("group").textContent).toContain("1731000000.000100");
  });

  test("shows a title with markup literally", () => {
    const evil: NexusEvent = { ...commit, title: "<img src=x onerror=alert(1)><b>hi</b>" };
    const { container } = render(<DetailStrip event={evil} t0Ms={T0_MS} open={scripted().open} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)><b>hi</b>");
  });

  test("OPEN sends ui.openTarget with the event target", async () => {
    const s = scripted();
    render(<DetailStrip event={commit} t0Ms={T0_MS} open={s.open} />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await waitFor(() => expect(s.posted).toHaveLength(1));
    expect(s.posted[0]).toMatchObject({ t: "req", name: "ui.openTarget", body: commit.target });
  });

  test("Enter on the focused strip opens the target", async () => {
    const s = scripted();
    render(<DetailStrip event={thread} t0Ms={T0_MS} open={s.open} />);
    fireEvent.keyDown(screen.getByRole("group"), { key: "Enter" });
    await waitFor(() => expect(s.posted).toHaveLength(1));
    expect(s.posted[0]).toMatchObject({ name: "ui.openTarget", body: thread.target });
  });

  test("Enter on the OPEN button does not open twice", async () => {
    const s = scripted();
    render(<DetailStrip event={commit} t0Ms={T0_MS} open={s.open} />);
    fireEvent.keyDown(screen.getByRole("button", { name: /open/i }), { key: "Enter" });
    await new Promise((r) => setTimeout(r, 10));
    expect(s.posted).toHaveLength(0);
  });

  test("empty state when nothing is selected, and Enter does nothing", async () => {
    const s = scripted();
    render(<DetailStrip event={undefined} t0Ms={T0_MS} open={s.open} />);
    expect(screen.getByRole("group").textContent).toContain("No event selected");
    expect(screen.queryByRole("button", { name: /open/i })).toBeNull();
    fireEvent.keyDown(screen.getByRole("group"), { key: "Enter" });
    await new Promise((r) => setTimeout(r, 10));
    expect(s.posted).toHaveLength(0);
  });
});
