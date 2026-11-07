// Pure search/track math for the globe (CLAUDE.md section 7). No DOM, no three.
import type { EventSearchHit, NexusEvent, TimeWindow } from "../../../src/contracts";
import { TIME_WINDOWS, eventPoint, inWindow } from "./index";
import type { OrbitSpec } from "./index";
import { activityPoint } from "./arcs";
import type { Vec3 } from "./arcs";

/** The Scene's world group rotation (Euler XYZ, radians). Scene.tsx must use this same value. */
export const WORLD_ROTATION: Readonly<Vec3> = [0.22, -0.7, 0];
/** Tracking moves the camera to this fraction of its current distance. */
export const TRACK_ZOOM = 0.85;
/** OrbitControls' distance limits (Scene.tsx). */
export const MIN_DISTANCE = 4;
export const MAX_DISTANCE = 14;

export type WindowChoice = { kind: "keep" } | { kind: "widen"; window: TimeWindow } | { kind: "outside" };

/** Keep the window if it holds the event, else the smallest window that does, else "outside". */
export function chooseWindow(atMs: number, nowMs: number, current: TimeWindow): WindowChoice {
  if (!Number.isFinite(atMs)) return { kind: "outside" };
  if (inWindow(atMs, nowMs, current)) return { kind: "keep" };
  const found = TIME_WINDOWS.find((w) => inWindow(atMs, nowMs, w));
  return found ? { kind: "widen", window: found } : { kind: "outside" };
}

/** Position in the world group's own frame, from the same functions the markers, rings and arcs use. */
export function trackedLocalPoint(event: NexusEvent, layout: readonly OrbitSpec[], nowMs: number, w: TimeWindow): Vec3 | undefined {
  const orbit = layout.find((o) => o.id === event.orbit);
  if (!orbit) return undefined;
  const atMs = Date.parse(event.at);
  if (event.kind === "agent_session" || event.kind === "slack_task") return activityPoint(orbit, atMs, nowMs, w);
  // Commits, branches and tags sit on the orbit; a merge arc is tracked at its target end (the event's own orbit).
  return eventPoint(orbit, atMs, nowMs, w);
}

/** Applies WORLD_ROTATION (three's Euler XYZ order: Rx * Ry * Rz) to a point. */
export function toWorld(p: Readonly<Vec3>, rotation: Readonly<Vec3> = WORLD_ROTATION): Vec3 {
  const [x, y, z] = p;
  const [a, b, c] = rotation;
  const cz = Math.cos(c), sz = Math.sin(c);
  const x1 = x * cz - y * sz, y1 = x * sz + y * cz, z1 = z;
  const cy = Math.cos(b), sy = Math.sin(b);
  const x2 = x1 * cy + z1 * sy, y2 = y1, z2 = -x1 * sy + z1 * cy;
  const cx = Math.cos(a), sx = Math.sin(a);
  return [x2, y2 * cx - z2 * sx, y2 * sx + z2 * cx];
}

export function trackedWorldPoint(event: NexusEvent, layout: readonly OrbitSpec[], nowMs: number, w: TimeWindow): Vec3 | undefined {
  const local = trackedLocalPoint(event, layout, nowMs, w);
  return local ? toWorld(local) : undefined;
}

/** Camera position looking from the origin through `world` at TRACK_ZOOM of `currentDistance`, clamped. */
export function cameraGoal(world: Readonly<Vec3>, currentDistance: number): { position: Vec3; distance: number } {
  const distance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, currentDistance * TRACK_ZOOM));
  const len = Math.hypot(world[0], world[1], world[2]);
  // A point at the origin has no direction: fall back to the default camera side (+Z).
  const dir: Vec3 = len < 1e-9 ? [0, 0, 1] : [world[0] / len, world[1] / len, world[2] / len];
  return { position: [dir[0] * distance, dir[1] * distance, dir[2] * distance], distance };
}

/** A tracked event that leaves the window releases tracking. */
export function shouldRelease(event: NexusEvent, nowMs: number, w: TimeWindow): boolean {
  return !inWindow(Date.parse(event.at), nowMs, w);
}

/** Adds the event unless its id is already loaded (returns the same array then). */
export function withEvent(events: NexusEvent[], event: NexusEvent): NexusEvent[] {
  return events.some((e) => e.id === event.id) ? events : [...events, event];
}

/** Search hits newest first, without mutating the input. */
export function newestFirst(hits: readonly EventSearchHit[]): EventSearchHit[] {
  return [...hits].sort((a, b) => Date.parse(b.event.at) - Date.parse(a.event.at));
}
