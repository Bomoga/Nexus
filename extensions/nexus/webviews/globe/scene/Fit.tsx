import { useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import type { PerspectiveCamera } from "three";
import { MAX_FIT_DISTANCE, fitDistance } from "../model/fit";
import { MAX_DISTANCE } from "../model/tracking";

interface ControlsLike {
  maxDistance: number;
  update(): void;
}

/**
 * Keeps every orbit in view. When the globe GROWS (a new branch family adds an outer orbit), the camera backs off along
 * its current direction until the outermost ring fits. Resizing the pane or releasing a tracked event never moves the
 * camera, so a deliberate zoom-in stays. The zoom-out limit follows the largest fit seen, capped so the globe can never
 * be pushed past the camera's far plane.
 */
export function Fit({ radius, tracking }: { radius: number; tracking: boolean }) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const controls = useThree((s) => s.controls) as unknown as ControlsLike | null;
  const fittedFor = useRef(0);
  const widest = useRef(0);

  useEffect(() => {
    const d = fitDistance(radius, camera.fov, size.height > 0 ? size.width / size.height : 1);
    widest.current = Math.max(widest.current, d);
    if (controls) controls.maxDistance = Math.min(MAX_FIT_DISTANCE * 1.3, Math.max(MAX_DISTANCE, widest.current * 1.3));
    if (tracking || radius <= fittedFor.current) return;
    fittedFor.current = radius;
    if (camera.position.length() < d) {
      camera.position.setLength(d);
      controls?.update();
    }
    // Only a larger radius re-fits; size is read for the aspect at that moment on purpose, not watched.
  }, [radius, tracking, camera, controls]);

  return null;
}
