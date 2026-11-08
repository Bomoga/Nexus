import { useEffect, useRef } from "react";
import { BufferGeometry, Line, LineBasicMaterial, Vector3 } from "three";
import { useFrame, useThree } from "@react-three/fiber";
import type { NexusEvent, TimeWindow } from "../../../src/contracts";
import type { OrbitSpec } from "../model";
import { TRACK_ZOOM, cameraGoal, trackedWorldPoint } from "../model/tracking";
import { ACCENT_GLOW } from "./colors";
import { useDriftNow } from "./live";

/** Fraction of the remaining distance the camera closes each frame (the globe is the one place motion is allowed). */
const FOLLOW_EASE = 0.12;

/** A 1 px ring (a plain GL line, so it stays 1 px at any zoom), faced toward the camera each frame. */
const RING_RADIUS = 0.13;
const ringGeometry = new BufferGeometry().setFromPoints(
  Array.from({ length: 49 }, (_, i) => new Vector3(Math.cos((i / 48) * Math.PI * 2) * RING_RADIUS, Math.sin((i / 48) * Math.PI * 2) * RING_RADIUS, 0)),
);
const ringMaterial = new LineBasicMaterial({ color: ACCENT_GLOW, depthTest: false, transparent: true });
const noRaycast = () => undefined;
const ringObject = new Line(ringGeometry, ringMaterial);
ringObject.raycast = noRaycast;
ringObject.renderOrder = 10;
ringObject.visible = false;

export interface TrackingProps {
  /** The tracked event: ringed, and the camera follows it. */
  event: NexusEvent | undefined;
  /** The selected event: ringed only, when nothing is tracked. */
  selected?: NexusEvent;
  layout: readonly OrbitSpec[];
  now: number;
  window: TimeWindow;
  /** The user dragged the globe: stop following. */
  onRelease: () => void;
}

interface ControlsLike {
  addEventListener: (type: "start", listener: () => void) => void;
  removeEventListener: (type: "start", listener: () => void) => void;
}

/**
 * Follows the tracked event: rings it, turns the camera to face it from about 85% of the current distance, and keeps it
 * centred as it drifts. A drag on the OrbitControls ("start") releases it. Lives outside the world group; positions come
 * from the same model functions the markers use, rotated by the group's rotation.
 */
export function Tracking({ event, selected, layout, now, window, onRelease }: TrackingProps) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as ControlsLike | null;
  const driftNow = useDriftNow(now);
  const ring = useRef<Line>(null);
  const goalDistance = useRef<number | undefined>(undefined);
  const goal = useRef(new Vector3());
  const release = useRef(onRelease);
  useEffect(() => {
    release.current = onRelease;
  });
  useEffect(() => {
    goalDistance.current = undefined;
  }, [event?.id]);

  useEffect(() => {
    if (!event || !controls) return;
    const onStart = () => release.current();
    controls.addEventListener("start", onStart);
    return () => controls.removeEventListener("start", onStart);
  }, [event, controls]);

  useFrame(() => {
    const r = ring.current;
    if (!r) return;
    const shown = event ?? selected;
    const p = shown ? trackedWorldPoint(shown, layout, driftNow(), window) : undefined;
    if (!p) {
      r.visible = false;
      return;
    }
    r.position.set(p[0], p[1], p[2]);
    r.quaternion.copy(camera.quaternion);
    r.visible = true;
    if (!event) return;
    // The distance is fixed when tracking starts (85% of where the camera was), so following does not keep zooming in.
    goalDistance.current ??= cameraGoal(p, camera.position.length()).distance;
    const g = cameraGoal(p, goalDistance.current / TRACK_ZOOM).position;
    goal.current.set(g[0], g[1], g[2]);
    camera.position.lerp(goal.current, FOLLOW_EASE);
  });

  return <primitive ref={ring} object={ringObject} />;
}
