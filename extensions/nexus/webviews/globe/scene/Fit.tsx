import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import type { PerspectiveCamera } from "three";
import { fitDistance } from "../model/fit";
import { MAX_DISTANCE } from "../model/tracking";

interface ControlsLike {
  maxDistance: number;
  update(): void;
}

/**
 * Keeps every orbit in view: when the outermost ring (or the view's shape) needs more room, the camera backs off along
 * its current direction and the zoom-out limit grows with it. It never pulls a camera the user zoomed out further back
 * in, and it leaves the camera alone while an event is tracked (Tracking owns it then).
 */
export function Fit({ radius, tracking }: { radius: number; tracking: boolean }) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const controls = useThree((s) => s.controls) as unknown as ControlsLike | null;

  useEffect(() => {
    const d = fitDistance(radius, camera.fov, size.height > 0 ? size.width / size.height : 1);
    if (controls) controls.maxDistance = Math.max(MAX_DISTANCE, d * 1.3);
    if (tracking) return;
    if (camera.position.length() < d) {
      camera.position.setLength(d);
      controls?.update();
    }
  }, [radius, size.width, size.height, tracking, camera, controls]);

  return null;
}
