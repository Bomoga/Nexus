import { ACTIVITY_OFFSET } from "./arcs";
import type { OrbitSpec } from "./index";

/** Camera distance the globe opens at when everything already fits. */
export const BASE_DISTANCE = 8.24;
/** Room left around the outermost activity ring, as a fraction of its radius. */
const MARGIN = 1.12;

/** Radius of the outermost thing drawn: the last orbit plus its activity ring. */
export function outerRadius(layout: readonly Pick<OrbitSpec, "radius">[]): number {
  return layout.reduce((r, o) => Math.max(r, o.radius), 0) + ACTIVITY_OFFSET;
}

/**
 * Distance from the origin at which a sphere of `radius` fits the view with a margin: the narrower of the vertical
 * field of view and the horizontal one (fov × aspect) decides. Never closer than BASE_DISTANCE.
 */
export function fitDistance(radius: number, fovDeg: number, aspect: number): number {
  const half = Math.tan(((fovDeg / 2) * Math.PI) / 180) * Math.min(1, aspect > 0 ? aspect : 1);
  return Math.max(BASE_DISTANCE, (radius * MARGIN) / half);
}
