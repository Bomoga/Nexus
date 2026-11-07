import { useEffect, useMemo } from "react";
import { Raycaster, Vector2 } from "three";
import type { InstancedMesh, Object3D } from "three";
import { useThree } from "@react-three/fiber";
import type { NexusEvent } from "../../../src/contracts";
import { LINE_THRESHOLD, commitInstanceIds, isClick, pickEventId } from "../model/picking";
import type { PickHit } from "../model/picking";
import type { OrbitSpec } from "../model";

export interface PickingProps {
  events: readonly NexusEvent[];
  layout: readonly OrbitSpec[];
  /** Called with the clicked event, or undefined when a click lands on empty space. Never called for drags. */
  onPick: (event: NexusEvent | undefined) => void;
}

/**
 * Click-to-select for markers (individual meshes and the InstancedMesh), merge arcs and activity cubes/diamonds.
 * Renders nothing and holds no React state: it listens for pointer events on the canvas and raycasts on click only.
 */
export function Picking({ events, layout, onPick }: PickingProps) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const raycaster = useMemo(() => {
    const r = new Raycaster();
    r.params.Line = { threshold: LINE_THRESHOLD };
    return r;
  }, []);
  const ndc = useMemo(() => new Vector2(), []);

  useEffect(() => {
    const el = gl.domElement;
    const instanceIds = commitInstanceIds(events, layout);
    const byId = new Map(events.map((e) => [e.id, e]));
    let down: { x: number; y: number; id: number } | undefined;

    const onDown = (e: PointerEvent) => {
      // Only the primary pointer can start a pick; a second finger (pinch) cancels it.
      if (!e.isPrimary) {
        down = undefined;
        return;
      }
      down = e.button === 0 ? { x: e.clientX, y: e.clientY, id: e.pointerId } : undefined;
    };
    const onUp = (e: PointerEvent) => {
      const start = down;
      if (!e.isPrimary) return;
      down = undefined;
      if (!start || e.pointerId !== start.id || e.button !== 0 || !isClick(e.clientX - start.x, e.clientY - start.y)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      // The instance matrices drift every frame but three caches the instanced bounding sphere: drop it so this pick recomputes.
      scene.traverse((o: Object3D) => {
        if ((o as InstancedMesh).isInstancedMesh) (o as InstancedMesh).boundingSphere = null;
      });
      const hits = raycaster.intersectObjects(scene.children, true) as unknown as PickHit[];
      const id = pickEventId(hits, instanceIds);
      onPick(id === undefined ? undefined : byId.get(id));
    };
    const onCancel = () => {
      down = undefined;
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
    };
  }, [gl, camera, scene, raycaster, ndc, events, layout, onPick]);

  return null;
}
