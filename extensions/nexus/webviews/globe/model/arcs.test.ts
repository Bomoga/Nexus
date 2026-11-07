import { describe, expect, it } from "vitest";
import type { NexusEvent } from "../../../src/contracts";
import { ACTIVITY_OFFSET, ARC_LIFT, SCALE_IN_MS, activityPoint, arcControl, arcPoint, eventPointInto, insertLive, mergeEndpoints, scaleIn, shapeOf } from "./arcs";
import { NOW_ANGLE, eventPoint, orbitPoint, windowMs } from "./index";

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
  it("is the raw lifted point of a degenerate (zero) midpoint without NaN", () => {
    const c = arcControl([1, 0, 0], [-1, 0, 0]);
    expect(c.every(Number.isFinite)).toBe(true);
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
  it("puts both ends at the merge angle, on fromOrbit and orbit rings", () => {
    const e = ev("m", 5, { kind: "merge", fromOrbit: "lane-1" });
    const w = windowMs("36h");
    const { from, to } = mergeEndpoints(lane, main, Date.parse(e.at), NOW, "36h");
    expect(from).toEqual(eventPoint(lane, Date.parse(e.at), NOW, "36h"));
    expect(to).toEqual(eventPoint(main, Date.parse(e.at), NOW, "36h"));
    expect(w).toBeGreaterThan(0);
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
