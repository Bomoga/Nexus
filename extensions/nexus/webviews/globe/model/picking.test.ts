import { describe, expect, it } from "vitest";
import type { NexusEvent } from "../../../src/contracts";
import { CLICK_SLOP_PX, commitInstanceIds, formatEventTime, isClick, pickEventId, shortId } from "./picking";

const H = 3_600_000;
const T0 = Date.parse("2026-11-07T03:15:00Z");

describe("formatEventTime", () => {
  it("formats T+hh:mm relative to the origin", () => {
    expect(formatEventTime(T0, T0)).toBe("T+00:00");
    expect(formatEventTime(T0 + 5 * H + 7 * 60_000, T0)).toBe("T+05:07");
    expect(formatEventTime(T0 + 100 * H, T0)).toBe("T+100:00");
  });
  it("uses T- before the origin and T+--:-- when invalid", () => {
    expect(formatEventTime(T0 - 90 * 60_000, T0)).toBe("T-01:30");
    expect(formatEventTime(NaN, T0)).toBe("T+--:--");
  });
});

describe("shortId", () => {
  it("shortens by target type", () => {
    expect(shortId({ type: "commit", sha: "3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21" })).toBe("3f2a9c1");
    expect(shortId({ type: "session", sessionId: "01JABCDEFGHJ" })).toBe("01JABCDE");
    expect(shortId({ type: "thread", channelId: "C1", threadTs: "17.1" })).toBe("17.1");
  });
});

describe("isClick", () => {
  it("is a click below the slop and a drag at or beyond it", () => {
    expect(isClick(0, 0)).toBe(true);
    expect(isClick(CLICK_SLOP_PX - 0.5, 0)).toBe(true);
    expect(isClick(CLICK_SLOP_PX, 0)).toBe(false);
    expect(isClick(3, 3)).toBe(false);
  });
});

const ev = (id: string, kind: NexusEvent["kind"], orbit: string): NexusEvent =>
  ({ id, kind, orbit, at: "2026-11-07T05:00:00Z", title: id, actor: { name: "a", kind: "human" }, target: { type: "session", sessionId: id }, workspaceId: "w", machineId: "m" }) as NexusEvent;

describe("commitInstanceIds", () => {
  it("lists commits on known orbits in event order, as Markers instances them", () => {
    const events = [ev("a", "commit", "main"), ev("m", "merge", "main"), ev("b", "commit", "ghost"), ev("c", "commit", "lane-1")];
    expect(commitInstanceIds(events, [{ id: "main" }, { id: "lane-1" }])).toEqual(["a", "c"]);
  });
});

describe("pickEventId", () => {
  const ids = ["a", "b", "c"];
  it("maps an instanced hit through instanceId", () => {
    expect(pickEventId([{ object: { isInstancedMesh: true }, instanceId: 1 }], ids)).toBe("b");
  });
  it("reads userData.eventId for meshes and lines", () => {
    expect(pickEventId([{ object: { userData: { eventId: "x" } } }], ids)).toBe("x");
  });
  it("skips unlabeled lines but is occluded by an unlabeled mesh (the globe)", () => {
    expect(pickEventId([{ object: { isLine: true } }, { object: { userData: { eventId: "x" } } }], ids)).toBe("x");
    expect(pickEventId([{ object: { isMesh: true } }, { object: { userData: { eventId: "x" } } }], ids)).toBeUndefined();
  });
  it("returns undefined for no hits or an out-of-range instance", () => {
    expect(pickEventId([], ids)).toBeUndefined();
    expect(pickEventId([{ object: { isInstancedMesh: true }, instanceId: 9 }], ids)).toBeUndefined();
  });
});
