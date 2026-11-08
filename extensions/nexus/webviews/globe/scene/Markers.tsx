import { useLayoutEffect, useMemo, useRef } from "react";
import { Color, MeshBasicMaterial, Object3D, SphereGeometry } from "three";
import type { Group, InstancedMesh } from "three";
import { useFrame, useThree } from "@react-three/fiber";
import type { NexusEvent, TimeWindow } from "../../../src/contracts";
import { eventPoint, shouldInstance, windowMs } from "../model";
import { eventPointInto } from "../model/arcs";
import { commitPlacements } from "../model/picking";
import type { Vec3 } from "../model/arcs";
import type { OrbitSpec } from "../model";
import { ACCENT_HI } from "./colors";
import { FAR_OPACITY, applyFade, isFarSide } from "./fade";
import { applyDrift, liveScale, useDriftNow } from "./live";
import type { DriftData } from "./live";

export interface MarkersProps {
  events: readonly NexusEvent[];
  layout: readonly OrbitSpec[];
  now: number;
  window: TimeWindow;
}

interface Placed {
  event: NexusEvent;
  position: [number, number, number];
  data: DriftData;
  scale: number;
}

const COMMIT_RADIUS = 0.05;
// One geometry and one material per quality level, shared by every commit marker for the page lifetime.
const sphereHi = new SphereGeometry(COMMIT_RADIUS, 14, 14);
const sphereLo = new SphereGeometry(COMMIT_RADIUS, 8, 8);
const markerMaterial = new MeshBasicMaterial({ color: ACCENT_HI });
// Far side of the orbit: half opacity. Instanced markers dim through the per-instance color instead.
const markerFar = new MeshBasicMaterial({ color: ACCENT_HI, transparent: true, opacity: FAR_OPACITY });
const NEAR_TINT = new Color(1, 1, 1);
const FAR_TINT = new Color(FAR_OPACITY, FAR_OPACITY, FAR_OPACITY);

/** Commits as small spheres at their time angle. Individual meshes up to 2,000 (pickable), one InstancedMesh beyond. */
export function Markers({ events, layout, now, window }: MarkersProps) {
  const placed = useMemo<Placed[]>(() => {
    const out: Placed[] = [];
    const perf = performance.now();
    for (const { event, orbit } of commitPlacements(events, layout)) {
      const atMs = Date.parse(event.at);
      out.push({
        event,
        position: eventPoint(orbit, atMs, now, window),
        data: { eventId: event.id, atMs, radius: orbit.radius, tilt: orbit.tilt },
        scale: liveScale(event.id, perf),
      });
    }
    return out;
    // Initial positions only; useFrame owns them afterwards, so `now` is deliberately not a dependency.
  }, [events, layout, window]);

  const driftNow = useDriftNow(now);
  return shouldInstance(placed.length) ? (
    <Instanced placed={placed} window={window} driftNow={driftNow} />
  ) : (
    <Individual placed={placed} window={window} driftNow={driftNow} />
  );
}

interface DriftProps {
  placed: readonly Placed[];
  window: TimeWindow;
  driftNow: () => number;
}

function Individual({ placed, window, driftNow }: DriftProps) {
  const group = useRef<Group>(null);
  const camera = useThree((s) => s.camera);
  useFrame(() => {
    if (!group.current) return;
    applyDrift(group.current, driftNow(), window, 0, performance.now());
    applyFade(group.current, camera, markerMaterial, markerFar);
  });
  return (
    <group ref={group}>
      {placed.map((p) => (
        <mesh key={p.event.id} position={p.position} scale={p.scale} geometry={sphereHi} material={markerMaterial} userData={p.data} />
      ))}
    </group>
  );
}

const tmp: Vec3 = [0, 0, 0];

function Instanced({ placed, window, driftNow }: DriftProps) {
  const mesh = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const camera = useThree((s) => s.camera);
  const write = (m: InstancedMesh, now: number) => {
    const wms = windowMs(window);
    const perf = performance.now();
    const parent = m.parent ?? m;
    parent.updateWorldMatrix(true, false);
    for (let i = 0; i < placed.length; i++) {
      const d = placed[i].data;
      eventPointInto(tmp, d, d.atMs, now, wms);
      dummy.position.set(tmp[0], tmp[1], tmp[2]);
      dummy.scale.setScalar(liveScale(d.eventId, perf));
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      m.setColorAt(i, isFarSide(parent, dummy, camera) ? FAR_TINT : NEAR_TINT);
    }
    m.count = placed.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  };
  useLayoutEffect(() => {
    if (mesh.current) write(mesh.current, driftNow());
  }, [placed]);
  useFrame(() => {
    if (mesh.current) write(mesh.current, driftNow());
  });
  // Keyed by capacity so a larger set reallocates the instance buffer.
  return <instancedMesh key={placed.length} ref={mesh} args={[sphereLo, markerMaterial, placed.length]} frustumCulled={false} />;
}
