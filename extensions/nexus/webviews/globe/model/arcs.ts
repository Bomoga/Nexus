// Pure arc / activity-ring / live-insert math (CLAUDE.md §7). No DOM, no three.
import type { EventKind, NexusEvent, TimeWindow } from "../../../src/contracts";
import { eventPoint, inWindow } from "./index";
import type { OrbitSpec } from "./index";

export type Vec3 = [number, number, number];
type Ring = Pick<OrbitSpec, "radius" | "tilt">;

/** The arc's control point sits this far beyond the larger endpoint radius. */
export const ARC_LIFT = 0.55;
/** Activity ring (cubes, diamonds) radius beyond the orbit's own ring. */
export const ACTIVITY_OFFSET = 0.28;
/** New live markers scale in over this long; the only animation in the globe. */
export const SCALE_IN_MS = 80;
/** Segments per drawn arc (25 vertices, as in the prototype). */
export const ARC_SEGMENTS = 24;

export type MarkerShape = "sphere" | "cube" | "diamond" | "arc";

/** How an event kind is drawn; kinds the globe does not draw (tag, branch) return undefined. */
export function shapeOf(kind: EventKind): MarkerShape | undefined {
  switch (kind) {
    case "commit": return "sphere";
    case "agent_session": return "cube";
    case "slack_task": return "diamond";
    case "merge": return "arc";
    default: return undefined;
  }
}

/** Quadratic bezier control point: the endpoints' midpoint pushed out along its own ray to max(|a|,|b|) + lift. */
export function arcControl(a: Readonly<Vec3>, b: Readonly<Vec3>, out: Vec3 = [0, 0, 0], lift = ARC_LIFT): Vec3 {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const mz = (a[2] + b[2]) / 2;
  const target = Math.max(Math.hypot(a[0], a[1], a[2]), Math.hypot(b[0], b[1], b[2])) + lift;
  const m = Math.hypot(mx, my, mz);
  if (m < 1e-9) {
    // Endpoints are antipodal: any outward ray works; lift along +Y.
    out[0] = 0; out[1] = target; out[2] = 0;
    return out;
  }
  const k = target / m;
  out[0] = mx * k; out[1] = my * k; out[2] = mz * k;
  return out;
}

/** Point at `t` (0..1) on the quadratic bezier a -> c -> b, written into `out`. */
export function arcPoint(a: Readonly<Vec3>, c: Readonly<Vec3>, b: Readonly<Vec3>, t: number, out: Vec3): Vec3 {
  const u = 1 - t;
  const wa = u * u;
  const wc = 2 * u * t;
  const wb = t * t;
  out[0] = wa * a[0] + wc * c[0] + wb * b[0];
  out[1] = wa * a[1] + wc * c[1] + wb * b[1];
  out[2] = wa * a[2] + wc * c[2] + wb * b[2];
  return out;
}

/** Both ends of a merge arc at the merge's time angle: fromOrbit's ring and the target orbit's ring. */
export function mergeEndpoints(fromOrbit: Ring, orbit: Ring, atMs: number, nowMs: number, w: TimeWindow): { from: Vec3; to: Vec3 } {
  return { from: eventPoint(fromOrbit, atMs, nowMs, w), to: eventPoint(orbit, atMs, nowMs, w) };
}

/** Cube / diamond position: the event's angle on the orbit's outer activity ring. */
export function activityPoint(orbit: Ring, atMs: number, nowMs: number, w: TimeWindow): Vec3 {
  return eventPoint(orbit, atMs, nowMs, w, ACTIVITY_OFFSET);
}

/**
 * A live event joins the loaded list (newest first). Returns the same array when the id is already loaded
 * or the event is outside the window, so callers can skip a state update.
 */
export function insertLive(loaded: readonly NexusEvent[], incoming: NexusEvent, nowMs: number, w: TimeWindow): readonly NexusEvent[] {
  if (!inWindow(Date.parse(incoming.at), nowMs, w)) return loaded;
  if (loaded.some((e) => e.id === incoming.id)) return loaded;
  const next = [...loaded, incoming];
  next.sort((a, b) => b.at.localeCompare(a.at));
  return next;
}

/** Scale 0..1 over SCALE_IN_MS (linear, clamped). */
export function scaleIn(ageMs: number): number {
  if (!(ageMs > 0)) return 0;
  return ageMs >= SCALE_IN_MS ? 1 : ageMs / SCALE_IN_MS;
}
