// Pure activity-strip math (CLAUDE.md §7): bucket the events.activity response into one column per
// 15-minute bucket across the window, and map a click position back to a bucket.
import type { ActivityBucket } from "../../../src/contracts";

export const BUCKET_MS = 15 * 60_000;

export interface Segment {
  orbit: string;
  count: number;
}

export interface Column {
  /** Bucket start, epoch ms (aligned to 15 minutes). */
  start: number;
  /** Bucket end, epoch ms. */
  end: number;
  total: number;
  /** Non-empty per-orbit counts in stacking order. */
  segments: Segment[];
}

export interface ActivityModel {
  columns: Column[];
  /** Largest column total in view (0 when nothing happened). */
  max: number;
}

const floorBucket = (ms: number) => Math.floor(ms / BUCKET_MS) * BUCKET_MS;

/**
 * Columns for [now - window, now]. Missing buckets are zero, buckets outside the window are ignored,
 * and counts for the same bucket and orbit are summed. `families` gives the stacking order (main first);
 * orbits not listed follow alphabetically.
 */
export function buildActivity(buckets: readonly ActivityBucket[], families: readonly string[], nowMs: number, windowMillis: number): ActivityModel {
  const first = floorBucket(nowMs - windowMillis);
  const last = floorBucket(nowMs);
  const counts = new Map<number, Map<string, number>>();
  const seen = new Set<string>();
  for (const b of buckets) {
    const t = Date.parse(b.bucketStart);
    if (!Number.isFinite(t)) continue;
    const start = floorBucket(t);
    if (start < first || start > last) continue;
    let per = counts.get(start);
    if (!per) counts.set(start, (per = new Map()));
    per.set(b.orbit, (per.get(b.orbit) ?? 0) + b.count);
    seen.add(b.orbit);
  }
  const order = [...families, ...[...seen].filter((o) => !families.includes(o)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))];
  const columns: Column[] = [];
  let max = 0;
  for (let start = first; start <= last; start += BUCKET_MS) {
    const per = counts.get(start);
    const segments: Segment[] = [];
    let total = 0;
    if (per) {
      for (const orbit of order) {
        const count = per.get(orbit);
        if (count) {
          segments.push({ orbit, count });
          total += count;
        }
      }
    }
    max = Math.max(max, total);
    columns.push({ start, end: start + BUCKET_MS, total, segments });
  }
  return { columns, max };
}

/** The column under a horizontal position given as a fraction (0..1) of the strip's width. */
export function columnAtFraction(fraction: number, columns: readonly Column[]): Column | undefined {
  if (!Number.isFinite(fraction) || columns.length === 0 || fraction < 0 || fraction > 1) return undefined;
  return columns[Math.min(columns.length - 1, Math.floor(fraction * columns.length))];
}

/** Purple shades only: main the full accent, other orbits progressively dimmer, never below 0.3. */
export function orbitOpacity(index: number): number {
  return index <= 0 ? 1 : Math.max(0.3, 0.8 - (index - 1) * 0.15);
}
