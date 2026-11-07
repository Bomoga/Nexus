import { useEffect, useRef } from "react";
import { DoubleSide, MeshBasicMaterial, RingGeometry, Vector3 } from "three";
import type { Mesh } from "three";
import { useFrame, useThree } from "@react-three/fiber";
import type { NexusEvent, TimeWindow } from "../../../src/contracts";
import type { OrbitSpec } from "../model";
import { TRACK_ZOOM, cameraGoal, trackedWorldPoint } from "../model/tracking";
import { PURPLE } from "./colors";
import { useDriftNow } from "./live";

/** Fraction of the remaining distance the camera closes each frame (the globe is the one place motion is allowed). */
const FOLLOW_EASE = 0.12;

const ringGeometry = new RingGeometry(0.12, 0.14, 40);
const ringMaterial = new MeshBasicMaterial({ color: PURPLE, side: DoubleSide, depthTest: false, transparent: true });
const noRaycast = () => undefined;

export interface TrackingProps {
  event: NexusEvent | undefined;
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
export function Tracking({ event, layout, now, window, onRelease }: TrackingProps) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as ControlsLike | null;
  const driftNow = useDriftNow(now);
  const ring = useRef<Mesh>(null);
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
    const p = event ? trackedWorldPoint(event, layout, driftNow(), window) : undefined;
    if (!p) {
      r.visible = false;
      return;
    }
    // The distance is fixed when tracking starts (85% of where the camera was), so following does not keep zooming in.
    goalDistance.current ??= cameraGoal(p, camera.position.length()).distance;
    const g = cameraGoal(p, goalDistance.current / TRACK_ZOOM).position;
    goal.current.set(g[0], g[1], g[2]);
    camera.position.lerp(goal.current, FOLLOW_EASE);
    r.position.set(p[0], p[1], p[2]);
    r.quaternion.copy(camera.quaternion);
    r.visible = true;
  });

  return <mesh ref={ring} geometry={ringGeometry} material={ringMaterial} raycast={noRaycast} renderOrder={10} visible={false} />;
}
