// Live events and per-frame drift for the globe scene. Hooks here never set React state per frame:
// time advances through refs and imperative three updates (CLAUDE.md §7).
import { createContext, useContext, useEffect, useLayoutEffect, useRef } from "react";
import type { Object3D } from "three";
import type { NexusEvent, TimeWindow } from "../../../src/contracts";
import { subscribe } from "../../shared";
import { SCALE_IN_MS, eventPointInto, scaleIn, shapeOf } from "../model/arcs";
import type { Vec3 } from "../model/arcs";
import { windowMs } from "../model";

/** What a drifting marker mesh carries in `userData` (eventId is also what picking reads). */
export interface DriftData {
  eventId: string;
  atMs: number;
  radius: number;
  tilt: number;
}

/** Subscribes to events.subscribe through the bridge kit while mounted; unsubscribes on unmount. */
export function useLiveEvents(onEvent: (event: NexusEvent) => void, enabled = true): void {
  const handler = useRef(onEvent);
  useLayoutEffect(() => {
    handler.current = onEvent;
  });
  useEffect(() => {
    if (!enabled) return;
    return subscribe("events.subscribe", {}, (e) => handler.current(e));
  }, [enabled]);
}

/** A "now" that keeps advancing between prop updates: base + wall time elapsed since the base was set. */
export function useDriftNow(now: number): () => number {
  const frozen = useContext(DriftFrozen);
  const base = useRef({ now, perf: performance.now(), frozen });
  const read = useRef(() => (base.current.frozen ? base.current.now : base.current.now + (performance.now() - base.current.perf)));
  useLayoutEffect(() => {
    base.current = { now, perf: performance.now(), frozen };
  }, [now, frozen]);
  return read.current;
}

/**
 * True inside the scene while the globe is pinned to a past time (activity strip): drift stops, so markers stay where
 * that time puts them. Provided inside the Canvas (React context does not cross the r3f Canvas boundary).
 */
export const DriftFrozen = createContext(false);

// Arrival times (performance.now) of live markers still scaling in. Empty almost always, so the per-frame check is free.
const arrivals = new Map<string, number>();

/** Registers a live event for the scale-in. Events the globe does not draw as a marker are skipped. */
export function markLive(event: NexusEvent, perfNow = performance.now()): void {
  const shape = shapeOf(event.kind);
  if (shape === undefined || shape === "arc") return;
  for (const [id, t] of arrivals) if (perfNow - t > SCALE_IN_MS * 4) arrivals.delete(id);
  arrivals.set(event.id, perfNow);
}

/** Scale for a marker this frame: 1 unless it just arrived live. */
export function liveScale(eventId: string, perfNow: number): number {
  if (arrivals.size === 0) return 1;
  const t = arrivals.get(eventId);
  if (t === undefined) return 1;
  const s = scaleIn(perfNow - t);
  if (s >= 1) arrivals.delete(eventId);
  return s;
}

const tmp: Vec3 = [0, 0, 0];

/** Recomputes every child's angle for `now` (and applies the live scale-in). No allocation. */
export function applyDrift(group: Object3D, now: number, w: TimeWindow, radiusOffset: number, perfNow: number): void {
  const wms = windowMs(w);
  const children = group.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const d = child.userData as Partial<DriftData>;
    if (d.atMs === undefined || d.radius === undefined || d.tilt === undefined || d.eventId === undefined) continue;
    eventPointInto(tmp, d as DriftData, d.atMs, now, wms, radiusOffset);
    child.position.set(tmp[0], tmp[1], tmp[2]);
    child.scale.setScalar(liveScale(d.eventId, perfNow));
  }
}
