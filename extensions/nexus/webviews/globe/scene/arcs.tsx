import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry, Line, LineBasicMaterial } from "three";
import { useFrame } from "@react-three/fiber";
import type { NexusEvent, TimeWindow } from "../../../src/contracts";
import { ARC_SEGMENTS, arcControl, arcPoint, eventPointInto } from "../model/arcs";
import type { Vec3 } from "../model/arcs";
import { windowMs } from "../model";
import type { OrbitSpec } from "../model";
import { PURPLE } from "./colors";
import { useDriftNow } from "./live";

const arcMaterial = new LineBasicMaterial({ color: PURPLE, transparent: true, opacity: 0.85 });

interface Arc {
  id: string;
  atMs: number;
  from: OrbitSpec;
  to: OrbitSpec;
  line: Line;
}

export interface ArcsProps {
  events: readonly NexusEvent[];
  layout: readonly OrbitSpec[];
  now: number;
  window: TimeWindow;
}

const A: Vec3 = [0, 0, 0];
const B: Vec3 = [0, 0, 0];
const C: Vec3 = [0, 0, 0];
const P: Vec3 = [0, 0, 0];

function writeArc(arc: Arc, now: number, wms: number): void {
  eventPointInto(A, arc.from, arc.atMs, now, wms);
  eventPointInto(B, arc.to, arc.atMs, now, wms);
  arcControl(A, B, C);
  const pos = arc.line.geometry.getAttribute("position") as BufferAttribute;
  const out = pos.array as Float32Array;
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    arcPoint(A, C, B, i / ARC_SEGMENTS, P);
    out[i * 3] = P[0];
    out[i * 3 + 1] = P[1];
    out[i * 3 + 2] = P[2];
  }
  pos.needsUpdate = true;
  // Line.raycast culls on the bounding sphere, so keep it current for picking.
  arc.line.geometry.computeBoundingSphere();
}

/** Merge events as bezier arcs from fromOrbit's ring to the merge's orbit ring, redrawn every frame as time drifts. */
export function Arcs({ events, layout, now, window }: ArcsProps) {
  const arcs = useMemo<Arc[]>(() => {
    const byId = new Map(layout.map((o) => [o.id, o]));
    const out: Arc[] = [];
    const wms = windowMs(window);
    for (const event of events) {
      if (event.kind !== "merge" || !event.fromOrbit) continue;
      const from = byId.get(event.fromOrbit);
      const to = byId.get(event.orbit);
      if (!from || !to) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(new Float32Array((ARC_SEGMENTS + 1) * 3), 3));
      const line = new Line(geometry, arcMaterial);
      line.frustumCulled = false;
      line.userData = { eventId: event.id };
      const arc: Arc = { id: event.id, atMs: Date.parse(event.at), from, to, line };
      writeArc(arc, now, wms);
      out.push(arc);
    }
    return out;
    // Initial shape only; useFrame redraws afterwards, so `now` is deliberately not a dependency.
  }, [events, layout, window]);
  // Geometries are ours (the material is shared): release them when the arcs change or on unmount.
  useEffect(() => () => arcs.forEach((a) => a.line.geometry.dispose()), [arcs]);

  const driftNow = useDriftNow(now);
  useFrame(() => {
    const n = driftNow();
    const wms = windowMs(window);
    for (let i = 0; i < arcs.length; i++) writeArc(arcs[i], n, wms);
  });

  return (
    <group>
      {arcs.map((a) => (
        <primitive key={a.id} object={a.line} />
      ))}
    </group>
  );
}
