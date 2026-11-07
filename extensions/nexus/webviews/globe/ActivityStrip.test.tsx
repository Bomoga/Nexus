// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ActivityBucket, Envelope } from "../../src/contracts";
import { createBridgeClient } from "../shared";
import type { Transport } from "../shared";
import { ActivityStrip } from "./ActivityStrip";

afterEach(cleanup);

const NOW = Date.parse("2026-11-07T12:00:00Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

type Answer = ActivityBucket[] | { code: string; message: string };

function setup(answer: () => Answer) {
  const handlers = new Set<(e: Envelope) => void>();
  const bodies: { from: string; to: string }[] = [];
  const transport: Transport = {
    listen(h) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    post(env) {
      if (env.t !== "req" || env.name !== "events.activity") return;
      bodies.push(env.body as { from: string; to: string });
      queueMicrotask(() => {
        const out = answer();
        const res: Envelope = Array.isArray(out)
          ? { t: "res", id: env.id, ok: true, body: out }
          : { t: "res", id: env.id, ok: false, error: { code: out.code as "not_found", message: out.message } };
        handlers.forEach((h) => h(res));
      });
    },
  };
  return { bridge: createBridgeClient(transport), bodies };
}

const buckets: ActivityBucket[] = [
  { bucketStart: iso(NOW - 45 * 60_000), orbit: "main", count: 2 },
  { bucketStart: iso(NOW - 45 * 60_000), orbit: "lane-1", count: 1 },
  { bucketStart: iso(NOW - 15 * 60_000), orbit: "main", count: 1 },
];

describe("ActivityStrip", () => {
  test("renders one column per bucket with stacked segments and a tooltip", async () => {
    const h = setup(() => buckets);
    const { container } = render(<ActivityStrip bridge={h.bridge} now={NOW} window="24h" families={["main", "lane-1"]} onPin={() => undefined} />);
    // 24h = 96 buckets plus the current one
    await waitFor(() => expect(container.querySelectorAll("[data-column]").length).toBe(97));
    const stacked = container.querySelector(`[data-column="${iso(NOW - 45 * 60_000)}"]`) as Element;
    expect(stacked.querySelectorAll("rect[data-orbit]").length).toBe(2);
    expect(stacked.querySelector("title")?.textContent).toMatch(/^T[+-]\d\d:\d\d · 3 events$/);
    const single = container.querySelector(`[data-column="${iso(NOW - 15 * 60_000)}"] title`);
    expect(single?.textContent).toMatch(/ · 1 event$/);
  });

  test("a not_found host shows one quiet line and no RETRY", async () => {
    const h = setup(() => ({ code: "not_found", message: "no handler for events.activity" }));
    render(<ActivityStrip bridge={h.bridge} now={NOW} window="36h" families={["main"]} onPin={() => undefined} />);
    expect(await screen.findByText("activity isn't connected yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "RETRY" })).toBeNull();
  });

  test("another error shows RETRY and RETRY re-requests", async () => {
    let answer: Answer = { code: "internal", message: "boom" };
    const h = setup(() => answer);
    render(<ActivityStrip bridge={h.bridge} now={NOW} window="36h" families={["main"]} onPin={() => undefined} />);
    expect(await screen.findByText(/activity failed: boom/)).toBeTruthy();
    answer = buckets;
    fireEvent.click(screen.getByRole("button", { name: "RETRY" }));
    await waitFor(() => expect(screen.queryByText(/activity failed/)).toBeNull());
    expect(h.bodies.length).toBe(2);
  });

  test("an empty window shows one line", async () => {
    const h = setup(() => []);
    render(<ActivityStrip bridge={h.bridge} now={NOW} window="36h" families={["main"]} onPin={() => undefined} />);
    expect(await screen.findByText("no activity in this window")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "RETRY" })).toBeNull();
  });

  test("clicking a column pins the globe to the end of that bucket", async () => {
    const h = setup(() => buckets);
    const onPin = vi.fn();
    const { container } = render(<ActivityStrip bridge={h.bridge} now={NOW} window="24h" families={["main"]} onPin={onPin} />);
    await waitFor(() => expect(container.querySelectorAll("[data-column]").length).toBe(97));
    const svg = container.querySelector("svg") as SVGSVGElement;
    svg.getBoundingClientRect = () => ({ left: 0, width: 970, top: 0, height: 30, right: 970, bottom: 30, x: 0, y: 0, toJSON: () => ({}) });
    // column 0 starts at now - 24h; x = 5 is inside it
    fireEvent.click(svg, { clientX: 5 });
    expect(onPin).toHaveBeenCalledWith(NOW - 24 * HOUR + 15 * 60_000);
  });

  test("re-queries when the window changes, and when now moves by 15 minutes, but not on a 5 s tick", async () => {
    const h = setup(() => buckets);
    const props = { bridge: h.bridge, families: ["main"], onPin: () => undefined };
    const { rerender } = render(<ActivityStrip {...props} now={NOW} window="24h" />);
    await waitFor(() => expect(h.bodies.length).toBe(1));
    rerender(<ActivityStrip {...props} now={NOW + 5_000} window="24h" />);
    rerender(<ActivityStrip {...props} now={NOW + 10_000} window="24h" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.bodies.length).toBe(1);
    rerender(<ActivityStrip {...props} now={NOW + 5_000} window="7d" />);
    await waitFor(() => expect(h.bodies.length).toBe(2));
    rerender(<ActivityStrip {...props} now={NOW + 16 * 60_000} window="7d" />);
    await waitFor(() => expect(h.bodies.length).toBe(3));
  });
});
