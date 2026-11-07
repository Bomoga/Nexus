import { useLayoutEffect, useMemo, useRef } from "react";
import { Object3D } from "three";
import type { InstancedMesh } from "three";
import type { NexusEvent, TimeWindow } from "../../../src/contracts";
import { INSTANCE_THRESHOLD, eventPoint } from "../model";
import type { OrbitSpec } from "../model";
import { PURPLE_HI } from "./colors";

export interface MarkersProps {
  events: readonly NexusEvent[];
  layout: readonly OrbitSpec[];
  now: number;
  window: TimeWindow;
}

interface Placed {
  event: NexusEvent;
  position: [number, number, number];
}

const COMMIT_RADIUS = 0.05;

/** Commits as small spheres at their time angle. Individual meshes up to 2,000 (pickable), one InstancedMesh beyond. */
export function Markers({ events, layout, now, window }: MarkersProps) {
  const placed = useMemo<Placed[]>(() => {
    const byId = new Map(layout.map((o) => [o.id, o]));
    const out: Placed[] = [];
    for (const event of events) {
      if (event.kind !== "commit") continue;
      const orbit = byId.get(event.orbit);
      if (!orbit) continue;
      out.push({ event, position: eventPoint(orbit, Date.parse(event.at), now, window) });
    }
    return out;
  }, [events, layout, now, window]);

  return placed.length > INSTANCE_THRESHOLD ? <Instanced placed={placed} /> : <Individual placed={placed} />;
}

function Individual({ placed }: { placed: readonly Placed[] }) {
  return (
    <group>
      {placed.map((p) => (
        <mesh key={p.event.id} position={p.position} userData={{ eventId: p.event.id }}>
          <sphereGeometry args={[COMMIT_RADIUS, 14, 14]} />
          <meshBasicMaterial color={PURPLE_HI} />
        </mesh>
      ))}
    </group>
  );
}

function Instanced({ placed }: { placed: readonly Placed[] }) {
  const mesh = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    placed.forEach((p, i) => {
      dummy.position.set(...p.position);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.count = placed.length;
    m.instanceMatrix.needsUpdate = true;
  }, [placed, dummy]);
  // Keyed by capacity so a larger set reallocates the instance buffer.
  return (
    <instancedMesh key={placed.length} ref={mesh} args={[undefined, undefined, placed.length]}>
      <sphereGeometry args={[COMMIT_RADIUS, 8, 8]} />
      <meshBasicMaterial color={PURPLE_HI} />
    </instancedMesh>
  );
}
