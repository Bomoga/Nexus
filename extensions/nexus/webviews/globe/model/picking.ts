// Pure pick bookkeeping for the globe: click-vs-drag, event id <-> hit, T+ formatting. No three/React imports.
import type { EventTarget, NexusEvent } from "../../../src/contracts";

/** A pointer that moves this far (px) between down and up was a drag; it never selects. */
export const CLICK_SLOP_PX = 4;

/** Line raycast threshold in world units (from the reference prototype). */
export const LINE_THRESHOLD = 0.06;

/**
 * Default T+0: 22:00 ET on Fri 6 Nov 2026 as UTC, as recorded in progress/lane-3.md. The host's `nexus.t0` setting is not readable from a
 * webview (app.ping only returns whole hours), so the strip uses this unless a caller supplies another origin.
 */
export const DEFAULT_T0_MS = Date.parse("2026-11-07T03:00:00Z");

export function isClick(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) < CLICK_SLOP_PX;
}

/** "T+05:07": hours:minutes since the origin ("T-" before it, "T+--:--" for an invalid time). */
export function formatEventTime(atMs: number, t0Ms: number = DEFAULT_T0_MS): string {
  if (!Number.isFinite(atMs) || !Number.isFinite(t0Ms)) return "T+--:--";
  const diff = atMs - t0Ms;
  const mins = Math.floor(Math.abs(diff) / 60_000);
  const sign = diff < 0 && mins > 0 ? "T-" : "T+";
  return `${sign}${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/** Short identifier for the strip: 7-char SHA, 8-char session id, or the Slack thread timestamp. */
export function shortId(target: EventTarget): string {
  switch (target.type) {
    case "commit":
      return target.sha.slice(0, 7);
    case "session":
      return target.sessionId.slice(0, 8);
    case "thread":
      return target.threadTs;
  }
}

/** Commits on a known orbit, in event order, with their orbit. Markers draws exactly this list, in this order. */
export function commitPlacements<O extends { id: string }>(events: readonly NexusEvent[], layout: readonly O[]): { event: NexusEvent; orbit: O }[] {
  const byId = new Map(layout.map((o) => [o.id, o]));
  const out: { event: NexusEvent; orbit: O }[] = [];
  for (const event of events) {
    if (event.kind !== "commit") continue;
    const orbit = byId.get(event.orbit);
    if (orbit) out.push({ event, orbit });
  }
  return out;
}

/** Event ids in InstancedMesh instance order (same list Markers instances, via commitPlacements). */
export function commitInstanceIds(events: readonly NexusEvent[], layout: readonly { id: string }[]): string[] {
  return commitPlacements(events, layout).map((p) => p.event.id);
}

/** The minimal shape of a three Intersection that picking needs, so this stays testable without three. */
export interface PickHit {
  object: { userData?: { eventId?: unknown }; isInstancedMesh?: boolean; isLine?: boolean; isMesh?: boolean };
  instanceId?: number;
}

/**
 * Nearest event hit. `hits` must be sorted near to far. Unlabeled lines (orbits, wireframe) are skipped;
 * an unlabeled mesh (the depth-only globe sphere) occludes everything behind it.
 */
export function pickEventId(hits: readonly PickHit[], instanceIds: readonly string[]): string | undefined {
  for (const h of hits) {
    const o = h.object;
    if (o.isInstancedMesh) {
      const id = h.instanceId === undefined ? undefined : instanceIds[h.instanceId];
      if (id !== undefined) return id;
      continue;
    }
    const id = o.userData?.eventId;
    if (typeof id === "string") return id;
    if (o.isMesh) return undefined;
  }
  return undefined;
}
