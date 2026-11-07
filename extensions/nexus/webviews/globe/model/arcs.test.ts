import { describe, expect, it } from "vitest";
import type { NexusEvent } from "../../../src/contracts";
import { QUERY_LIMIT } from "./index";
import { ACTIVITY_OFFSET, activityKey, mergeKey, scriptedNow, ARC_LIFT, SCALE_IN_MS, activityPoint, arcControl, arcPoint, eventPointInto, insertLive, mergeEndpoints, scaleIn, shapeOf } from "./arcs";
import { NOW_ANGLE, eventPoint, orbitPoint, visibleEvents, windowMs } from "./index";

const H = 3_600_000;
const NOW = Date.parse("2026-11-07T12:00:00Z");
const main = { radius: 2, tilt: 0 };
const lane = { radius: 2.4, tilt: 0.5 };
const len = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);

function ev(id: string, hoursAgo: number, extra: Partial<NexusEvent> = {}): NexusEvent {
  return {
    id, kind: "commit", at: new Date(NOW - hoursAgo * H).toISOString(), orbit: "main", title: "t",
    actor: { name: "a", kind: "human" }, target: { type: "commit", sha: "a".repeat(40) }, workspaceId: "w", machineId: "m", ...extra,
  };
}

describe("arcControl", () => {
  it("lies on the ray through the midpoint, ARC_LIFT beyond the larger radius", () => {
    const a = orbitPoint(lane, NOW_ANGLE + 1);
    const b = orbitPoint(main, NOW_ANGLE + 1);
    const c = arcControl(a, b);
    expect(len(c)).toBeCloseTo(Math.max(len(a), len(b)) + ARC_LIFT);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const dot = (c[0] * mid[0] + c[1] * mid[1] + c[2] * mid[2]) / (len(c) * len(mid));
    expect(dot).toBeCloseTo(1);
  });
  it("lifts a degenerate (antipodal, zero) midpoint along +Y to radius + lift without NaN", () => {
    const c = arcControl([1, 0, 0], [-1, 0, 0]);
    expect(c.every(Number.isFinite)).toBe(true);
    expect(c).toEqual([0, 1 + ARC_LIFT, 0]);
  });
});

describe("arcPoint", () => {
  const a = orbitPoint(lane, NOW_ANGLE + 1);
  const b = orbitPoint(main, NOW_ANGLE + 1);
  const c = arcControl(a, b);
  it("starts at a and ends at b", () => {
    const out: [number, number, number] = [0, 0, 0];
    arcPoint(a, c, b, 0, out);
    expect(out).toEqual(a);
    arcPoint(a, c, b, 1, out);
    out.forEach((v, i) => expect(v).toBeCloseTo(b[i]));
  });
  it("bulges beyond both endpoints at the middle", () => {
    const out: [number, number, number] = [0, 0, 0];
    arcPoint(a, c, b, 0.5, out);
    expect(len(out)).toBeGreaterThan(Math.max(len(a), len(b)));
  });
});

describe("mergeEndpoints", () => {
  const close = (p: readonly number[], q: readonly number[]) => q.forEach((v, i) => expect(p[i]).toBeCloseTo(v, 9));
  it("at the now line both ends are on +Z at their own ring radius", () => {
    const { from, to } = mergeEndpoints(lane, main, NOW, NOW, "36h");
    close(from, [0, 0, 2.4]);
    close(to, [0, 0, 2]);
  });
  it("a quarter window back both ends sit at the same angle, tilted around Z", () => {
    const { from, to } = mergeEndpoints(lane, main, NOW - 9 * H, NOW, "36h");
    close(from, [-2.4 * Math.cos(0.5), -2.4 * Math.sin(0.5), 0]);
    close(to, [-2, 0, 0]);
  });
  it("endpoints of a tilted orbit lie in that orbit's plane at its radius", () => {
    for (const hours of [0.5, 3, 9, 17, 30]) {
      const { from } = mergeEndpoints(lane, main, NOW - hours * H, NOW, "36h");
      // The ring plane contains Z and the tilted X axis, so y*cos(tilt) - x*sin(tilt) = 0.
      expect(from[1] * Math.cos(lane.tilt) - from[0] * Math.sin(lane.tilt)).toBeCloseTo(0, 9);
      expect(len(from)).toBeCloseTo(lane.radius, 9);
    }
  });
});

describe("activityPoint", () => {
  it("sits ACTIVITY_OFFSET outside the orbit ring at the event angle", () => {
    const at = NOW - 3 * H;
    const p = activityPoint(lane, at, NOW, "36h");
    expect(p).toEqual(eventPoint(lane, at, NOW, "36h", ACTIVITY_OFFSET));
    expect(len(p)).toBeCloseTo(lane.radius + ACTIVITY_OFFSET);
  });
});

describe("shapeOf", () => {
  it("maps kinds to marker shapes", () => {
    expect(shapeOf("commit")).toBe("sphere");
    expect(shapeOf("agent_session")).toBe("cube");
    expect(shapeOf("slack_task")).toBe("diamond");
    expect(shapeOf("merge")).toBe("arc");
    expect(shapeOf("tag")).toBeUndefined();
    expect(shapeOf("branch")).toBeUndefined();
  });
});

describe("insertLive", () => {
  const loaded = [ev("b", 2), ev("a", 4)];
  it("puts a new in-window event first and returns a new array", () => {
    const e = ev("n", 0);
    const next = insertLive(loaded, e, NOW, "36h");
    expect(next).not.toBe(loaded);
    expect(next.map((x) => x.id)).toEqual(["n", "b", "a"]);
    expect(loaded).toHaveLength(2);
  });
  it("returns the same array for an id already loaded", () => {
    expect(insertLive(loaded, ev("b", 2), NOW, "36h")).toBe(loaded);
  });
  it("ignores events outside the window or too far in the future", () => {
    expect(insertLive(loaded, ev("old", 30), NOW, "24h")).toBe(loaded);
    expect(insertLive(loaded, ev("fut", -1), NOW, "36h")).toBe(loaded);
  });
  it("keeps newest-first order for a slightly older live event", () => {
    const next = insertLive(loaded, ev("mid", 3), NOW, "36h");
    expect(next.map((x) => x.id)).toEqual(["b", "mid", "a"]);
  });
});

describe("scaleIn", () => {
  it("grows 0 to 1 within SCALE_IN_MS (< 100 ms) and clamps", () => {
    expect(SCALE_IN_MS).toBeLessThan(100);
    expect(scaleIn(0)).toBe(0);
    expect(scaleIn(-5)).toBe(0);
    expect(scaleIn(SCALE_IN_MS / 2)).toBeGreaterThan(0);
    expect(scaleIn(SCALE_IN_MS / 2)).toBeLessThan(1);
    expect(scaleIn(SCALE_IN_MS)).toBe(1);
    expect(scaleIn(10_000)).toBe(1);
  });
});

describe("eventPointInto", () => {
  it("matches eventPoint (with and without offset) and returns its out array", () => {
    const out: [number, number, number] = [0, 0, 0];
    for (const off of [0, ACTIVITY_OFFSET]) {
      for (const h of [0, 1.5, 20, 35]) {
        const at = NOW - h * H;
        const r = eventPointInto(out, lane, at, NOW, windowMs("36h"), off);
        expect(r).toBe(out);
        eventPoint(lane, at, NOW, "36h", off).forEach((v, i) => expect(out[i]).toBeCloseTo(v, 10));
      }
    }
  });
  it("drifts: the same event moves back as now advances", () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [0, 0, 0];
    eventPointInto(a, main, NOW, NOW, windowMs("36h"));
    eventPointInto(b, main, NOW, NOW + H, windowMs("36h"));
    expect(a).not.toEqual(b);
  });
});

describe("fake clock", () => {
  const pinned = Date.parse("2026-11-07T15:15:00Z");
  it("a live event stamped 90 s after the pinned start is visible only if the filter's now advanced too", () => {
    const stamped = ev("live", 0, { at: new Date(scriptedNow(pinned, 90_000)).toISOString() });
    // Old behavior: stamp ran ahead, filter stayed pinned -> beyond the 60 s skew, dropped.
    expect(visibleEvents([stamped], pinned, "36h")).toHaveLength(0);
    expect(visibleEvents([stamped], scriptedNow(pinned, 90_000), "36h")).toHaveLength(1);
  });
});

describe("insertLive cap", () => {
  it("keeps only the newest events up to the limit", () => {
    const loaded = [ev("a", 1), ev("b", 2), ev("c", 3)];
    const next = insertLive(loaded, ev("n", 0), NOW, "36h", 3);
    expect(next.map((e) => e.id)).toEqual(["n", "a", "b"]);
  });
  it("defaults to QUERY_LIMIT", () => {
    const loaded = Array.from({ length: QUERY_LIMIT }, (_, i) => ev(`e${i}`, 1 + i / 1000));
    expect(insertLive(loaded, ev("n", 0), NOW, "36h")).toHaveLength(QUERY_LIMIT);
  });
});

describe("geometry keys", () => {
  const m = ev("m", 5, { kind: "merge", fromOrbit: "lane-1" });
  it("ignore unrelated events and re-filtering, change with the arcs", () => {
    expect(mergeKey([m, ev("c", 1)])).toBe(mergeKey([ev("c2", 2), m]));
    expect(mergeKey([m, ev("m2", 6, { kind: "merge", fromOrbit: "lane-2" })])).not.toBe(mergeKey([m]));
  });
  it("activityKey tracks only cubes and diamonds", () => {
    const g = ev("g", 2, { kind: "agent_session" });
    expect(activityKey([g, m, ev("c", 1)])).toBe(activityKey([g]));
    expect(activityKey([g, ev("s", 3, { kind: "slack_task" })])).not.toBe(activityKey([g]));
  });
});
