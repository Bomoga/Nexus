// Depth cue for markers: the half of an orbit facing away from the camera is drawn dimmer. No allocation per call.
import { Vector3 } from "three";
import type { Camera, Material, Mesh, Object3D } from "three";

/** Opacity of markers on the far side of an orbit (the planet's depth-only sphere hides anything fully behind it). */
export const FAR_OPACITY = 0.5;

const world = new Vector3();

/** True when `child` (a child of `parent`) is on the hemisphere facing away from the camera, with the planet at the origin. Callers refresh `parent.matrixWorld` once per frame. */
export function isFarSide(parent: Object3D, child: Object3D, camera: Camera): boolean {
  world.copy(child.position).applyMatrix4(parent.matrixWorld);
  return world.dot(camera.position) < 0;
}

/** True when the user asked the OS to reduce motion: the planet then holds still. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Swaps each child's material between `near` and `far` by hemisphere. Children must be plain meshes; no allocation. */
export function applyFade(group: Object3D, camera: Camera, near: Material, far: Material): void {
  group.updateWorldMatrix(true, false);
  const children = group.children as Mesh[];
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    const m = isFarSide(group, c, camera) ? far : near;
    if (c.material !== m) c.material = m;
  }
}
