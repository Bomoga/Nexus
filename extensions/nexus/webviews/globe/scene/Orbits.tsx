import { useMemo } from "react";
import { BufferGeometry, Line, LineBasicMaterial, Vector3 } from "three";
import { GLOBE_RADIUS } from "../model";
import type { OrbitSpec } from "../model";
import { PURPLE, PURPLE_NOW } from "./colors";

function circle(r: number, segments: number): BufferGeometry {
  const pts: Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
  }
  return new BufferGeometry().setFromPoints(pts);
}

const ringMaterial = new LineBasicMaterial({ color: PURPLE, transparent: true, opacity: 0.55 });
const nowMaterial = new LineBasicMaterial({ color: PURPLE_NOW });

/** One ring per orbit family, all tilted around the shared Z axis, plus the now line along +Z. */
export function Orbits({ layout }: { layout: readonly OrbitSpec[] }) {
  const outer = layout.length ? layout[layout.length - 1].radius : 2;
  const rings = useMemo(() => layout.map((o) => ({ id: o.id, tilt: o.tilt, line: new Line(circle(o.radius, 160), ringMaterial) })), [layout]);
  const nowLine = useMemo(() => new Line(new BufferGeometry().setFromPoints([new Vector3(0, 0, GLOBE_RADIUS), new Vector3(0, 0, outer + 0.8)]), nowMaterial), [outer]);
  return (
    <group>
      {rings.map((r) => (
        <group key={r.id} rotation={[0, 0, r.tilt]}>
          <primitive object={r.line} />
        </group>
      ))}
      <primitive object={nowLine} />
    </group>
  );
}
