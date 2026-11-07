// Pure timeline geometry (CLAUDE.md §7 fallback). No DOM, no React: everything here is unit tested.
import type { NexusEvent, TimeWindow } from "../../src/contracts";
import { windowMs } from "../globe/model";

const HOUR = 3_600_000;

/** Height of a lane's mark row. */
export const LANE_H = 20;
/** Thin activity strip (cubes, diamonds) directly under its lane. */
export const ACTIVITY_H = 8;
/** One lane block: mark row plus activity strip. */
export const BLOCK_H = LANE_H + ACTIVITY_H;
/** Width of the plot in px; the window is stretched over it and the plot scrolls inside the view. */
export const PLOT_W = 1600;
/** Mark size in px. */
export const MARK = 6;

/** X for a time: now - window at 0, now at `width`; times outside the window clamp to the edges. */
export function xFor(atMs: number, nowMs: number, windowMillis: number, width: number = PLOT_W): number {
  const f = (atMs - (nowMs - windowMillis)) / windowMillis;
  return Math.min(1, Math.max(0, f)) * width;
}

/** Lane index for an orbit, or -1 when it has no lane. */
export function laneIndex(families: readonly string[], orbit: string): number {
  return families.indexOf(orbit);
}

/** Vertical center of a lane's mark row. */
export function laneCenterY(index: number): number {
  return index * BLOCK_H + LANE_H / 2;
}

/** Vertical center of a lane's activity strip. */
export function activityCenterY(index: number): number {
  return index * BLOCK_H + LANE_H + ACTIVITY_H / 2;
}

export function plotHeight(laneCount: number): number {
  return laneCount * BLOCK_H;
}

export type MarkShape = "square" | "cube" | "diamond";

export interface Mark {
  event: NexusEvent;
  shape: MarkShape;
  x: number;
  y: number;
}

export interface Connector {
  event: NexusEvent;
  x: number;
  /** Source lane's center and the target lane's center. */
  fromY: number;
  toY: number;
}

export interface Layout {
  marks: Mark[];
  connectors: Connector[];
  height: number;
}

/** Lays out the events on lanes. Tags and branches are not drawn (the globe does not draw them either). */
export function layoutEvents(events: readonly NexusEvent[], families: readonly string[], nowMs: number, w: TimeWindow, width: number = PLOT_W): Layout {
  const wms = windowMs(w);
  const marks: Mark[] = [];
  const connectors: Connector[] = [];
  for (const event of events) {
    const lane = laneIndex(families, event.orbit);
    if (lane < 0) continue;
    const x = xFor(Date.parse(event.at), nowMs, wms, width);
    switch (event.kind) {
      case "commit":
        marks.push({ event, shape: "square", x, y: laneCenterY(lane) });
        break;
      case "agent_session":
        marks.push({ event, shape: "cube", x, y: activityCenterY(lane) });
        break;
      case "slack_task":
        marks.push({ event, shape: "diamond", x, y: activityCenterY(lane) });
        break;
      case "merge": {
        const from = event.fromOrbit ? laneIndex(families, event.fromOrbit) : -1;
        if (from >= 0) connectors.push({ event, x, fromY: laneCenterY(from), toY: laneCenterY(lane) });
        break;
      }
      default:
        break;
    }
  }
  return { marks, connectors, height: plotHeight(families.length) };
}

/** X of one event on the plot, for revealing it. */
export function eventX(event: NexusEvent, nowMs: number, w: TimeWindow, width: number = PLOT_W): number {
  return xFor(Date.parse(event.at), nowMs, windowMs(w), width);
}

const TICK_STEPS = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 48 * HOUR, 7 * 24 * HOUR];
export const MAX_TICKS = 12;

export interface Tick {
  atMs: number;
  x: number;
}

/** Tick times on multiples of a round step counted from T+0, at most MAX_TICKS across the window. */
export function ticksFor(nowMs: number, w: TimeWindow, t0Ms: number, width: number = PLOT_W): Tick[] {
  const wms = windowMs(w);
  const from = nowMs - wms;
  const step = TICK_STEPS.find((s) => wms / s < MAX_TICKS) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const out: Tick[] = [];
  for (let at = t0Ms + Math.ceil((from - t0Ms) / step) * step; at <= nowMs; at += step) {
    out.push({ atMs: at, x: xFor(at, nowMs, wms, width) });
  }
  return out;
}

/** Scroll offset that centers x in a view `viewW` wide, clamped to the plot. */
export function scrollFor(x: number, viewW: number, width: number = PLOT_W): number {
  return Math.min(Math.max(0, width - viewW), Math.max(0, x - viewW / 2));
}
