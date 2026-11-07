import { describe, expect, test } from "vitest";
import { BUCKET_MS, buildActivity, columnAtFraction, orbitOpacity } from "./activity";

const HOUR = 3_600_000;
// 2026-11-07T12:00:00Z is on a 15-minute boundary.
const NOW = Date.parse("2026-11-07T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("buildActivity", () => {
  test("one column per 15-minute bucket across the window, missing buckets are zero", () => {
    const m = buildActivity([{ bucketStart: iso(NOW - 30 * 60_000), orbit: "main", count: 2 }], ["main"], NOW, HOUR);
    // window [11:00, 12:00]: starts 11:00, 11:15, 11:30, 11:45, plus the (just started) 12:00 bucket
    expect(m.columns.map((c) => iso(c.start))).toEqual([
      "2026-11-07T11:00:00.000Z",
      "2026-11-07T11:15:00.000Z",
      "2026-11-07T11:30:00.000Z",
      "2026-11-07T11:45:00.000Z",
      "2026-11-07T12:00:00.000Z",
    ]);
    expect(m.columns.map((c) => c.total)).toEqual([0, 0, 2, 0, 0]);
    expect(m.columns[2].end - m.columns[2].start).toBe(BUCKET_MS);
    expect(m.max).toBe(2);
  });

  test("buckets outside the window are ignored", () => {
    const m = buildActivity(
      [
        { bucketStart: iso(NOW - 3 * HOUR), orbit: "main", count: 9 },
        { bucketStart: iso(NOW + HOUR), orbit: "main", count: 9 },
        { bucketStart: iso(NOW - 15 * 60_000), orbit: "main", count: 1 },
      ],
      ["main"],
      NOW,
      HOUR,
    );
    expect(m.columns.reduce((s, c) => s + c.total, 0)).toBe(1);
    expect(m.max).toBe(1);
  });

  test("per-orbit counts stack in family order and repeated buckets are summed", () => {
    const at = iso(NOW - 45 * 60_000);
    const m = buildActivity(
      [
        { bucketStart: at, orbit: "lane-1", count: 1 },
        { bucketStart: at, orbit: "main", count: 2 },
        { bucketStart: at, orbit: "main", count: 3 },
        { bucketStart: at, orbit: "zzz", count: 4 },
      ],
      ["main", "lane-1"],
      NOW,
      HOUR,
    );
    const c = m.columns[1];
    expect(c.segments).toEqual([
      { orbit: "main", count: 5 },
      { orbit: "lane-1", count: 1 },
      { orbit: "zzz", count: 4 },
    ]);
    expect(c.total).toBe(10);
    expect(m.max).toBe(10);
  });

  test("an empty response has max 0 and every column empty", () => {
    const m = buildActivity([], ["main"], NOW, HOUR);
    expect(m.max).toBe(0);
    expect(m.columns.every((c) => c.total === 0 && c.segments.length === 0)).toBe(true);
  });

  test("unaligned bucket starts floor to their bucket", () => {
    const m = buildActivity([{ bucketStart: iso(NOW - 40 * 60_000), orbit: "main", count: 1 }], ["main"], NOW, HOUR);
    expect(m.columns[1].total).toBe(1);
  });
});

describe("columnAtFraction", () => {
  const m = buildActivity([], ["main"], NOW, HOUR);
  test("maps a click position to the bucket under it", () => {
    expect(columnAtFraction(0, m.columns)?.start).toBe(m.columns[0].start);
    expect(columnAtFraction(0.5, m.columns)?.start).toBe(m.columns[2].start);
    expect(columnAtFraction(0.999, m.columns)?.start).toBe(m.columns[4].start);
    expect(columnAtFraction(1, m.columns)?.start).toBe(m.columns[4].start);
  });
  test("outside the strip or no columns gives nothing", () => {
    expect(columnAtFraction(-0.1, m.columns)).toBeUndefined();
    expect(columnAtFraction(1.1, m.columns)).toBeUndefined();
    expect(columnAtFraction(Number.NaN, m.columns)).toBeUndefined();
    expect(columnAtFraction(0.5, [])).toBeUndefined();
  });
});

describe("orbitOpacity", () => {
  test("main is full and the rest get dimmer but never vanish", () => {
    expect(orbitOpacity(0)).toBe(1);
    expect(orbitOpacity(1)).toBeLessThan(1);
    expect(orbitOpacity(2)).toBeLessThan(orbitOpacity(1));
    expect(orbitOpacity(50)).toBeGreaterThanOrEqual(0.3);
  });
});
