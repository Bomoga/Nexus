import { describe, expect, it } from "vitest";
import type { NexusEvent } from "../../../src/contracts";
import { NOW_ANGLE, angleFor, familiesKey, familiesOf, keepNewest, shouldInstance, orbitLayout, orbitPoint, visibleEvents, windowMs } from "./index";

const H = 3_600_000;
const NOW = Date.parse("2026-11-07T12:00:00Z");

function ev(orbit: string, hoursAgo: number, extra: Partial<NexusEvent> = {}): NexusEvent {
  return {
    id: `${orbit}:${hoursAgo}`, kind: "commit", at: new Date(NOW - hoursAgo * H).toISOString(), orbit, title: "t",
    actor: { name: "a", kind: "human" }, target: { type: "commit", sha: "a".repeat(40) }, workspaceId: "w", machineId: "m", ...extra,
  };
}

describe("windowMs", () => {
  it("maps each TimeWindow", () => {
    expect(windowMs("24h")).toBe(24 * H);
    expect(windowMs("36h")).toBe(36 * H);
    expect(windowMs("7d")).toBe(7 * 24 * H);
    expect(windowMs("30d")).toBe(30 * 24 * H);
  });
});

describe("angleFor", () => {
  const w = windowMs("36h");
  it("is 0 at now and a full lap at the window edge", () => {
    expect(angleFor(NOW, NOW, w)).toBe(0);
    expect(angleFor(NOW - w, NOW, w)).toBeCloseTo(2 * Math.PI);
  });
  it("is proportional to age", () => {
    expect(angleFor(NOW - 9 * H, NOW, w)).toBeCloseTo(Math.PI / 2);
    expect(angleFor(NOW - 18 * H, NOW, w)).toBeCloseTo(Math.PI);
  });
  it("clamps events slightly in the future to the now line", () => {
    expect(angleFor(NOW + H, NOW, w)).toBe(0);
  });
});

describe("familiesOf", () => {
  it("puts main first and always includes it", () => {
    expect(familiesOf([ev("lane-2", 1), ev("lane-1", 2)])).toEqual(["main", "lane-1", "lane-2"]);
    expect(familiesOf([])).toEqual(["main"]);
  });
  it("includes merge sources and dedupes", () => {
    const fams = familiesOf([ev("main", 1, { kind: "merge", fromOrbit: "feature/x" }), ev("lane-1", 2), ev("lane-1", 3)]);
    expect(fams).toEqual(["main", "feature/x", "lane-1"]);
  });
  it("orders lanes numerically", () => {
    expect(familiesOf([ev("lane-10", 1), ev("lane-2", 1)])).toEqual(["main", "lane-2", "lane-10"]);
  });
});

describe("orbitLayout", () => {
  const layout = orbitLayout(["main", "lane-1", "lane-2", "lane-3", "feature/x"]);
  it("keeps main innermost and untilted", () => {
    expect(layout[0]).toMatchObject({ id: "main", tilt: 0 });
    const radii = layout.map((o) => o.radius);
    expect(radii[0]).toBe(Math.min(...radii));
  });
  it("increases radius monotonically and tilts the others", () => {
    for (let i = 1; i < layout.length; i++) {
      expect(layout[i].radius).toBeGreaterThan(layout[i - 1].radius);
      expect(layout[i].tilt).not.toBe(0);
    }
    expect(layout.map((o) => o.tilt)).toEqual([...new Set(layout.map((o) => o.tilt))]);
  });
  it("forces main first even if listed late", () => {
    expect(orbitLayout(["lane-1", "main"]).map((o) => o.id)).toEqual(["main", "lane-1"]);
  });
  it("puts every orbit's now point on the same ray", () => {
    const pts = layout.map((o) => orbitPoint(o, NOW_ANGLE));
    for (const p of pts) {
      expect(p[0]).toBeCloseTo(0);
      expect(p[1]).toBeCloseTo(0);
      expect(p[2]).toBeGreaterThan(0);
    }
  });
  it("keeps points on their ring radius", () => {
    for (const o of layout) {
      const p = orbitPoint(o, 1.234);
      expect(Math.hypot(...p)).toBeCloseTo(o.radius);
    }
  });
});

describe("visibleEvents", () => {
  it("hides events older than the window", () => {
    const events = [ev("main", 1), ev("main", 23), ev("main", 25), ev("main", 40)];
    expect(visibleEvents(events, NOW, "24h").map((e) => e.id)).toEqual(["main:1", "main:23"]);
    expect(visibleEvents(events, NOW, "36h")).toHaveLength(3);
    expect(visibleEvents(events, NOW, "7d")).toHaveLength(4);
  });
  it("drops events too far in the future", () => {
    expect(visibleEvents([ev("main", -5)], NOW, "24h")).toHaveLength(0);
    expect(visibleEvents([ev("main", -0.01)], NOW, "24h")).toHaveLength(1);
  });
});

describe("shouldInstance", () => {
  it("switches strictly above 2,000", () => {
    expect(shouldInstance(0)).toBe(false);
    expect(shouldInstance(2000)).toBe(false);
    expect(shouldInstance(2001)).toBe(true);
  });
});

describe("familiesKey", () => {
  it("is equal for equal family lists and differs otherwise", () => {
    expect(familiesKey(["main", "lane-1"])).toBe(familiesKey(["main", "lane-1"]));
    expect(familiesKey(["main", "lane-1"])).not.toBe(familiesKey(["main", "lane-2"]));
    expect(familiesKey(["a", "bc"])).not.toBe(familiesKey(["ab", "c"]));
  });
});

describe("keepNewest", () => {
  const evs = [ev("main", 5), ev("main", 1), ev("main", 3)];
  it("keeps the newest events and flags truncation at the limit", () => {
    const r = keepNewest(evs, 2);
    expect(r.events.map((e) => e.id)).toEqual(["main:1", "main:3"]);
    expect(r.truncated).toBe(true);
  });
  it("is not truncated below the limit", () => {
    expect(keepNewest(evs, 4).truncated).toBe(false);
    expect(keepNewest(evs, 4).events).toHaveLength(3);
  });
});
