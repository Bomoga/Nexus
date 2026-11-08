import { useEffect, useMemo } from "react";
import type { InterleavedBufferAttribute } from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { useFrame, useThree } from "@react-three/fiber";
import type { NexusEvent, TimeWindow } from "../../../src/contracts";
import { ARC_SEGMENTS, arcControl, mergeKey, arcPoint, eventPointInto } from "../model/arcs";
import type { Vec3 } from "../model/arcs";
import { windowMs } from "../model";
import type { OrbitSpec } from "../model";
import { ACCENT } from "./colors";
import { useDriftNow } from "./live";

// 1.5 px merge arcs. LineMaterial needs the canvas size (set from the Arcs component); one material is shared by every arc.
const arcMaterial = new LineMaterial({ color: ACCENT, linewidth: 1.5, transparent: true, opacity: 0.85 });

interface Arc {
  id: string;
  atMs: number;
  from: OrbitSpec;
  to: OrbitSpec;
  line: Line2;
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
  // LineGeometry stores one (start, end) pair per segment in a single interleaved buffer: write the new curve into it in place.
  const start = arc.line.geometry.getAttribute("instanceStart") as InterleavedBufferAttribute;
  const out = start.data.array as Float32Array;
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    arcPoint(A, C, B, i / ARC_SEGMENTS, P);
    if (i < ARC_SEGMENTS) {
      out[i * 6] = P[0];
      out[i * 6 + 1] = P[1];
      out[i * 6 + 2] = P[2];
    }
    if (i > 0) {
      out[(i - 1) * 6 + 3] = P[0];
      out[(i - 1) * 6 + 4] = P[1];
      out[(i - 1) * 6 + 5] = P[2];
    }
  }
  start.data.needsUpdate = true;
  // Picking and culling read the bounds, so keep them current.
  arc.line.geometry.computeBoundingSphere();
}

/** Merge events as bezier arcs from fromOrbit's ring to the merge's orbit ring, redrawn every frame as time drifts. */
export function Arcs({ events, layout, now, window }: ArcsProps) {
  // Keyed on the arcs themselves: the 5 s tick re-filters `events` without changing any merge.
  const key = mergeKey(events);
  const arcs = useMemo<Arc[]>(() => {
    const byId = new Map(layout.map((o) => [o.id, o]));
    const out: Arc[] = [];
    const wms = windowMs(window);
    for (const event of events) {
      if (event.kind !== "merge" || !event.fromOrbit) continue;
      const from = byId.get(event.fromOrbit);
      const to = byId.get(event.orbit);
      if (!from || !to) continue;
      const geometry = new LineGeometry();
      geometry.setPositions(new Float32Array((ARC_SEGMENTS + 1) * 3));
      const line = new Line2(geometry, arcMaterial);
      line.frustumCulled = false;
      line.userData = { eventId: event.id };
      const arc: Arc = { id: event.id, atMs: Date.parse(event.at), from, to, line };
      writeArc(arc, now, wms);
      out.push(arc);
    }
    return out;
    // Initial shape only; useFrame redraws afterwards, so `now` is deliberately not a dependency.
  }, [key, layout, window]);
  // Geometries are ours (the material is shared): release them when the arcs change or on unmount.
  useEffect(() => () => arcs.forEach((a) => a.line.geometry.dispose()), [arcs]);

  const size = useThree((st) => st.size);
  useEffect(() => {
    arcMaterial.resolution.set(size.width, size.height);
  }, [size.width, size.height]);

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
