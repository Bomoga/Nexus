import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { BufferGeometry, Line, LineBasicMaterial, Vector3 } from "three";
import type { Group } from "three";
import { GLOBE_RADIUS } from "../model";
import { PURPLE } from "./colors";

function ringPoints(r: number, y: number, segments: number): Vector3[] {
  const pts: Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
  }
  return pts;
}

/** Wireframe planet: latitude rings and meridians, slowly rotating. A depth-only sphere hides lines behind it. */
const globeMaterial = new LineBasicMaterial({ color: PURPLE });

export function Globe() {
  const group = useRef<Group>(null);
  const lines = useMemo(() => {
    const mat = globeMaterial;
    const out: Line[] = [];
    for (const d of [-60, -30, 0, 30, 60]) {
      const t = (d * Math.PI) / 180;
      out.push(new Line(new BufferGeometry().setFromPoints(ringPoints(GLOBE_RADIUS * Math.cos(t), GLOBE_RADIUS * Math.sin(t), 96)), mat));
    }
    const meridian = new BufferGeometry().setFromPoints(ringPoints(GLOBE_RADIUS, 0, 96));
    for (let k = 0; k < 6; k++) {
      const m = new Line(meridian, mat);
      m.rotation.set(Math.PI / 2, 0, (k * Math.PI) / 6);
      out.push(m);
    }
    return out;
  }, []);

  useEffect(
    () => () => {
      const seen = new Set<BufferGeometry>();
      for (const l of lines) if (!seen.has(l.geometry)) { seen.add(l.geometry); l.geometry.dispose(); }
    },
    [lines],
  );

  useFrame((_, dt) => {
    if (group.current) group.current.rotation.y += Math.min(dt, 0.05) * 0.05;
  });

  return (
    <group ref={group}>
      {lines.map((l) => (
        <primitive key={l.uuid} object={l} />
      ))}
      <mesh>
        <sphereGeometry args={[GLOBE_RADIUS * 0.99, 48, 48]} />
        <meshBasicMaterial colorWrite={false} />
      </mesh>
    </group>
  );
}
