// Pure globe math (CLAUDE.md §7). No DOM, no three: everything here is unit tested.
import type { NexusEvent, TimeWindow } from "../../../src/contracts";

const HOUR = 3_600_000;
const WINDOW_MS: Record<TimeWindow, number> = { "24h": 24 * HOUR, "36h": 36 * HOUR, "7d": 7 * 24 * HOUR, "30d": 30 * 24 * HOUR };

/** Events may be this far ahead of "now" (clock skew) and still show, clamped to the now line. */
export const FUTURE_SKEW_MS = 60_000;
/** Angle of the now line in an orbit's own plane: x = cos(a)·r, z = sin(a)·r, so now is +Z. */
export const NOW_ANGLE = Math.PI / 2;
/** All orbits tilt around this one axis (Z), which is what keeps every "now" point on the +Z ray. */
export const TILT_AXIS = [0, 0, 1] as const;
export const GLOBE_RADIUS = 1.45;
export const MAIN_RADIUS = 2.0;

export const TIME_WINDOWS: readonly TimeWindow[] = ["24h", "36h", "7d", "30d"];

export function windowMs(w: TimeWindow): number {
  return WINDOW_MS[w];
}

/** Radians back from the now line: 0 at now, 2π at the window edge. */
export function angleFor(atMs: number, nowMs: number, windowMillis: number): number {
  const age = Math.max(0, nowMs - atMs);
  return (age / windowMillis) * Math.PI * 2;
}

/** True when the event is inside the window (and not implausibly far in the future). */
export function inWindow(atMs: number, nowMs: number, w: TimeWindow): boolean {
  const age = nowMs - atMs;
  return age >= -FUTURE_SKEW_MS && age <= WINDOW_MS[w];
}

export function visibleEvents(events: readonly NexusEvent[], nowMs: number, w: TimeWindow): NexusEvent[] {
  return events.filter((e) => inWindow(Date.parse(e.at), nowMs, w));
}

function compareFamilies(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

/** One family per orbit that appears in the events (or as a merge source); main is always first. */
export function familiesOf(events: readonly NexusEvent[]): string[] {
  const set = new Set<string>();
  for (const e of events) {
    set.add(e.orbit);
    if (e.fromOrbit) set.add(e.fromOrbit);
  }
  set.delete("main");
  return ["main", ...[...set].sort(compareFamilies)];
}

export interface OrbitSpec {
  id: string;
  radius: number;
  /** Radians around TILT_AXIS. */
  tilt: number;
  index: number;
}

const RADIUS_STEP = 0.4;
const TILT_STEP = 0.5;
const MAX_TILT = 1.3;

/** main innermost and untilted; the rest at increasing radius, alternating tilt sign, around one axis. */
export function orbitLayout(families: readonly string[]): OrbitSpec[] {
  const rest = [...new Set(families)].filter((f) => f !== "main");
  return ["main", ...rest].map((id, index) => {
    const step = Math.ceil(index / 2);
    const sign = index % 2 === 1 ? 1 : -1;
    const tilt = index === 0 ? 0 : sign * Math.min(MAX_TILT, 0.05 + step * TILT_STEP);
    return { id, radius: MAIN_RADIUS + index * RADIUS_STEP, tilt, index };
  });
}

/** Point on an orbit ring at `angle` (orbit-plane angle, NOW_ANGLE = now line), after the shared Z tilt. */
export function orbitPoint(o: Pick<OrbitSpec, "radius" | "tilt">, angle: number, radiusOffset = 0): [number, number, number] {
  const r = o.radius + radiusOffset;
  const x = Math.cos(angle) * r;
  const z = Math.sin(angle) * r;
  const c = Math.cos(o.tilt);
  const s = Math.sin(o.tilt);
  return [x * c, x * s, z];
}

/** Where an event sits: back from the now line by its age, on its orbit. */
export function eventPoint(o: Pick<OrbitSpec, "radius" | "tilt">, atMs: number, nowMs: number, w: TimeWindow, radiusOffset = 0): [number, number, number] {
  return orbitPoint(o, NOW_ANGLE + angleFor(atMs, nowMs, WINDOW_MS[w]), radiusOffset);
}

/** Above this many visible events the scene draws instanced meshes. */
export const INSTANCE_THRESHOLD = 2000;

/** True when the scene should draw one InstancedMesh instead of a mesh per event (strictly more than 2,000). */
export function useInstancing(count: number): boolean {
  return count > INSTANCE_THRESHOLD;
}

/** Stable key for a family list, so layouts rebuild only when the set of orbits changes. */
export function familiesKey(families: readonly string[]): string {
  return families.join("\u0000");
}

export const QUERY_LIMIT = 5000;

/** Newest `limit` events (a response may arrive oldest-first); `truncated` when the store may hold more. */
export function keepNewest(events: readonly NexusEvent[], limit: number): { events: NexusEvent[]; truncated: boolean } {
  const sorted = [...events].sort((a, b) => b.at.localeCompare(a.at));
  return { events: sorted.slice(0, limit), truncated: events.length >= limit };
}
