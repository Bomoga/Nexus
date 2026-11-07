// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { NexusEvent } from "../../src/contracts";
import { fx } from "../../src/contracts/fixtures";
import css from "./timeline.css?raw";
import { Timeline } from "./Timeline";

afterEach(cleanup);

const NOW = Date.parse("2026-11-08T15:00:00Z");
const H = 3_600_000;
const at = (h: number) => new Date(NOW - h * H).toISOString();
const ev = (over: Partial<NexusEvent>): NexusEvent => ({ ...fx.event, ...over });
const EVENTS: NexusEvent[] = [
  ev({ id: "c", kind: "commit", orbit: "main", at: at(2) }),
  ev({ id: "s", kind: "agent_session", orbit: "lane-1", at: at(3), target: { type: "session", sessionId: "ses_01" } }),
  ev({ id: "t", kind: "slack_task", orbit: "lane-1", at: at(4), target: { type: "thread", channelId: "C", threadTs: "1.2" } }),
  ev({ id: "m", kind: "merge", orbit: "main", fromOrbit: "lane-1", at: at(5) }),
];

const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
const paint = /(^|[;\s])(fill|stroke)\s*:/;

describe("timeline styles", () => {
  test("every drawn shape matches a CSS rule that sets its fill or stroke", () => {
    render(<Timeline events={EVENTS} now={NOW} window="36h" onSelect={() => undefined} />);
    const shapes = [...screen.getByTestId("marks").querySelectorAll("rect, polygon, line")];
    expect(shapes.length).toBe(7);
    for (const el of shapes) {
      const painted = rules.some((r) => paint.test(r.body) && r.selector.split(",").some((sel) => el.matches(sel.trim())));
      expect(painted, `${el.tagName} in .${el.closest("g[class]")?.getAttribute("class")}`).toBe(true);
    }
  });
});

describe("timeline drift", () => {
  test("a clock tick shifts the mark group and leaves the marks' x attributes alone", () => {
    const { rerender } = render(<Timeline events={EVENTS} now={NOW} window="36h" onSelect={() => undefined} />);
    const xs = () => screen.getAllByTestId("mark").map((m) => m.getAttribute("data-cx"));
    const before = xs();
    const group = screen.getByTestId("marks");
    const first = screen.getAllByTestId("mark")[0];
    expect(group.getAttribute("transform")).toBe("translate(0,0)");
    rerender(<Timeline events={EVENTS} now={NOW + 5_000} window="36h" onSelect={() => undefined} />);
    expect(xs()).toEqual(before);
    expect(screen.getAllByTestId("mark")[0]).toBe(first);
    expect(group.getAttribute("transform")).not.toBe("translate(0,0)");
    expect(Number(/translate\((-?[\d.e-]+),0\)/.exec(group.getAttribute("transform")!)![1])).toBeLessThan(0);
  });

  test("once the drift reaches 1 px the marks are laid out again and the shift resets", () => {
    const { rerender } = render(<Timeline events={EVENTS} now={NOW} window="36h" onSelect={() => undefined} />);
    const x0 = Number(screen.getAllByTestId("mark")[0].getAttribute("data-cx"));
    const later = NOW + 2 * 60_000; // 36h over 1600 px: 1 px is about 81 s
    rerender(<Timeline events={EVENTS} now={later} window="36h" onSelect={() => undefined} />);
    expect(screen.getByTestId("marks").getAttribute("transform")).toBe("translate(0,0)");
    expect(Number(screen.getAllByTestId("mark")[0].getAttribute("data-cx"))).toBeLessThan(x0);
  });
});
