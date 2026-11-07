import { describe, expect, test } from "vitest";
import type { NexusEvent } from "../../src/contracts";
import { fx } from "../../src/contracts/fixtures";
import { scriptedNexusEvents } from "../../src/contracts/fixtures/stream";
import { familiesOf, windowMs } from "../globe/model";
import { ACTIVITY_H, BLOCK_H, LANE_H, PLOT_W, activityCenterY, eventX, laneCenterY, laneIndex, layoutEvents, plotHeight, scrollFor, ticksFor, xFor } from "./model";

const NOW = Date.parse("2026-11-08T15:00:00Z");
const H = 3_600_000;
const ev = (over: Partial<NexusEvent>): NexusEvent => ({ ...fx.event, ...over });

describe("xFor", () => {
  test("window start is 0, now is the width, the middle is half", () => {
    const w = windowMs("36h");
    expect(xFor(NOW - w, NOW, w, 1000)).toBe(0);
    expect(xFor(NOW, NOW, w, 1000)).toBe(1000);
    expect(xFor(NOW - w / 2, NOW, w, 1000)).toBe(500);
  });
  test("out of range clamps to the edges", () => {
    const w = windowMs("24h");
    expect(xFor(NOW - 2 * w, NOW, w, 1000)).toBe(0);
    expect(xFor(NOW + H, NOW, w, 1000)).toBe(1000);
  });
});

describe("lanes", () => {
  test("lane index follows the family order and centers stack by block height", () => {
    const fam = ["main", "lane-1", "lane-2"];
    expect(laneIndex(fam, "lane-2")).toBe(2);
    expect(laneIndex(fam, "nope")).toBe(-1);
    expect(laneCenterY(0)).toBe(LANE_H / 2);
    expect(laneCenterY(2)).toBe(2 * BLOCK_H + LANE_H / 2);
    expect(activityCenterY(1)).toBe(BLOCK_H + LANE_H + ACTIVITY_H / 2);
    expect(plotHeight(3)).toBe(3 * BLOCK_H);
  });
});

describe("layoutEvents", () => {
  const fam = ["main", "lane-1"];
  const at = (h: number) => new Date(NOW - h * H).toISOString();
  test("commits sit on their lane, sessions and tasks in the activity strip, merges connect two lanes", () => {
    const events = [
      ev({ id: "c", kind: "commit", orbit: "lane-1", at: at(1) }),
      ev({ id: "s", kind: "agent_session", orbit: "main", at: at(2), target: { type: "session", sessionId: "ses_01" } }),
      ev({ id: "t", kind: "slack_task", orbit: "lane-1", at: at(3), target: { type: "thread", channelId: "C", threadTs: "1.2" } }),
      ev({ id: "m", kind: "merge", orbit: "main", fromOrbit: "lane-1", at: at(4) }),
      ev({ id: "g", kind: "tag", orbit: "main", at: at(5) }),
    ];
    const l = layoutEvents(events, fam, NOW, "36h", 3600);
    const by = Object.fromEntries(l.marks.map((m) => [m.event.id, m]));
    expect(by.c).toMatchObject({ shape: "square", y: laneCenterY(1), x: 3500 });
    expect(by.s).toMatchObject({ shape: "cube", y: activityCenterY(0), x: 3400 });
    expect(by.t).toMatchObject({ shape: "diamond", y: activityCenterY(1), x: 3300 });
    expect(l.marks.length).toBe(3);
    expect(l.connectors).toEqual([{ event: events[3], x: 3200, fromY: laneCenterY(1), toY: laneCenterY(0) }]);
    expect(l.height).toBe(plotHeight(2));
  });
  test("a merge with an unknown source lane or an event on an unknown lane is skipped", () => {
    const l = layoutEvents([ev({ kind: "merge", orbit: "main", fromOrbit: "ghost" }), ev({ orbit: "ghost" })], ["main"], NOW, "36h");
    expect(l.marks).toEqual([]);
    expect(l.connectors).toEqual([]);
  });
  test("scales to the fixture scenario", () => {
    const events = scriptedNexusEvents();
    const l = layoutEvents(events, familiesOf(events), Date.parse(fx.event.at) + 36 * H, "36h");
    expect(l.marks.length).toBeGreaterThan(50);
    expect(l.connectors.length).toBeGreaterThan(0);
    for (const m of l.marks) expect(m.x).toBeGreaterThanOrEqual(0);
  });
  test("eventX matches the layout", () => {
    const e = ev({ at: at(6) });
    expect(eventX(e, NOW, "36h", 3600)).toBe(xFor(Date.parse(e.at), NOW, windowMs("36h"), 3600));
  });
});

describe("ticksFor", () => {
  const t0 = Date.parse("2026-11-07T03:00:00Z");
  test("at most 12 ticks, on round multiples from T+0, inside the plot", () => {
    for (const w of ["24h", "36h", "7d", "30d"] as const) {
      const ticks = ticksFor(NOW, w, t0);
      expect(ticks.length).toBeGreaterThan(1);
      expect(ticks.length).toBeLessThanOrEqual(12);
      for (const k of ticks) {
        expect(k.x).toBeGreaterThanOrEqual(0);
        expect(k.x).toBeLessThanOrEqual(PLOT_W);
      }
    }
    const t = ticksFor(NOW, "36h", t0);
    expect((t[1].atMs - t[0].atMs) % H).toBe(0);
    expect((t[0].atMs - t0) % (3 * H)).toBe(0);
  });
});

describe("scrollFor", () => {
  test("centers x, clamped to the plot", () => {
    expect(scrollFor(800, 400, 1600)).toBe(600);
    expect(scrollFor(10, 400, 1600)).toBe(0);
    expect(scrollFor(1600, 400, 1600)).toBe(1200);
    expect(scrollFor(500, 2000, 1600)).toBe(0);
  });
});
