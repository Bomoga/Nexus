import { describe, expect, test } from "vitest";
import { Euler, Vector3 } from "three";
import type { NexusEvent } from "../../../src/contracts";
import { fx } from "../../../src/contracts/fixtures";
import { activityPoint } from "./arcs";
import { eventPoint, orbitLayout } from "./index";
import {
  TRACK_ZOOM,
  WORLD_ROTATION,
  cameraGoal,
  chooseWindow,
  newestFirst,
  shouldRelease,
  toWorld,
  trackedLocalPoint,
  trackedWorldPoint,
  withEvent,
} from "./tracking";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const HOUR = 3_600_000;
const layout = orbitLayout(["main", "lane-3"]);
const lane3 = layout[1];
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();
const commit: NexusEvent = { ...fx.event, id: "c1", kind: "commit", orbit: "lane-3", at: at(6) };
const session: NexusEvent = { ...fx.event, id: "s1", kind: "agent_session", orbit: "lane-3", at: at(10), target: { type: "session", sessionId: "01JABCDEFGHJKMNPQRSTVWXYZ0" } };
const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe("chooseWindow", () => {
  test("keeps the window when the event is inside it", () => {
    expect(chooseWindow(NOW - 5 * HOUR, NOW, "36h")).toEqual({ kind: "keep" });
  });
  test("widens to the smallest window that contains it", () => {
    expect(chooseWindow(NOW - 30 * HOUR, NOW, "24h")).toEqual({ kind: "widen", window: "36h" });
    expect(chooseWindow(NOW - 40 * HOUR, NOW, "24h")).toEqual({ kind: "widen", window: "7d" });
    expect(chooseWindow(NOW - 10 * 24 * HOUR, NOW, "36h")).toEqual({ kind: "widen", window: "30d" });
  });
  test("reports outside when even 30d does not contain it", () => {
    expect(chooseWindow(NOW - 31 * 24 * HOUR, NOW, "30d")).toEqual({ kind: "outside" });
  });
  test("an invalid time is outside", () => {
    expect(chooseWindow(Number.NaN, NOW, "36h")).toEqual({ kind: "outside" });
  });
});

describe("tracked position", () => {
  test("a commit sits on its orbit at its age", () => {
    expect(trackedLocalPoint(commit, layout, NOW, "36h")).toEqual(eventPoint(lane3, Date.parse(commit.at), NOW, "36h"));
  });
  test("an agent session sits on the activity ring", () => {
    expect(trackedLocalPoint(session, layout, NOW, "36h")).toEqual(activityPoint(lane3, Date.parse(session.at), NOW, "36h"));
  });
  test("a merge is tracked at its target end", () => {
    const merge: NexusEvent = { ...commit, id: "m1", kind: "merge", orbit: "main", fromOrbit: "lane-3" };
    expect(trackedLocalPoint(merge, layout, NOW, "36h")).toEqual(eventPoint(layout[0], Date.parse(merge.at), NOW, "36h"));
  });
  test("an unknown orbit has no position", () => {
    expect(trackedLocalPoint({ ...commit, orbit: "nope" }, layout, NOW, "36h")).toBeUndefined();
  });
  test("world position applies the scene group rotation", () => {
    const local = trackedLocalPoint(commit, layout, NOW, "36h")!;
    const expected = new Vector3(...local).applyEuler(new Euler(...WORLD_ROTATION));
    close(toWorld(local), [expected.x, expected.y, expected.z]);
    close(trackedWorldPoint(commit, layout, NOW, "36h")!, [expected.x, expected.y, expected.z]);
  });
});

describe("cameraGoal", () => {
  const world: [number, number, number] = [3, 0, 4];
  test("looks from the origin through the point at 85% of the current distance", () => {
    expect(TRACK_ZOOM).toBe(0.85);
    const g = cameraGoal(world, 8);
    close(g.position, [(3 / 5) * 6.8, 0, (4 / 5) * 6.8]);
    expect(g.distance).toBeCloseTo(6.8, 6);
  });
  test("clamps to the near limit and the fit maximum; a camera the fit backed off stays ~15% closer, not pulled to 14", () => {
    expect(cameraGoal(world, 4.2).distance).toBe(4);
    expect(cameraGoal(world, 30).distance).toBeCloseTo(25.5, 9);
    expect(cameraGoal(world, 100).distance).toBe(40);
  });
  test("a point at the origin keeps the goal finite", () => {
    const g = cameraGoal([0, 0, 0], 8);
    expect(g.position.every(Number.isFinite)).toBe(true);
  });
});

describe("shouldRelease", () => {
  test("releases once the event leaves the window", () => {
    expect(shouldRelease(commit, NOW, "36h")).toBe(false);
    expect(shouldRelease(commit, NOW + 40 * HOUR, "36h")).toBe(true);
    expect(shouldRelease(commit, NOW, "24h")).toBe(false);
    expect(shouldRelease({ ...commit, at: at(30) }, NOW, "24h")).toBe(true);
  });
});

describe("list helpers", () => {
  test("withEvent adds once and deduplicates by id", () => {
    expect(withEvent([session], commit)).toEqual([session, commit]);
    const same = [commit];
    expect(withEvent(same, { ...commit })).toBe(same);
  });
  test("newestFirst sorts by event time descending without mutating", () => {
    const hits = [commit, session, { ...commit, id: "c2", at: at(1) }].map((event) => ({ event, score: 1 }));
    expect(newestFirst(hits).map((h) => h.event.id)).toEqual(["c2", "c1", "s1"]);
    expect(hits[0].event.id).toBe("c1");
  });
});
