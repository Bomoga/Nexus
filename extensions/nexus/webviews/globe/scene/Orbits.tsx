import { useMemo } from "react";
import { Line } from "@react-three/drei";
import { SphereGeometry, MeshBasicMaterial } from "three";
import { GLOBE_RADIUS } from "../model";
import type { OrbitSpec } from "../model";
import { ACTIVITY_OFFSET } from "../model/arcs";
import { ACCENT_GLOW, ACCENT_LO } from "./colors";

type P3 = [number, number, number];

/** A ring in the orbit's own XZ plane. Shared with the activity rings. */
export function circlePoints(r: number, segments: number): P3[] {
  const pts: P3[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push([Math.cos(a) * r, 0, Math.sin(a) * r]);
  }
  return pts;
}

/** Decorative lines must never take a click: wide lines are meshes to the raycaster and would occlude markers behind them. */
export const noRaycast = () => undefined;

const dotGeometry = new SphereGeometry(0.03, 10, 10);
const dotMaterial = new MeshBasicMaterial({ color: ACCENT_GLOW });
/** Past the outermost activity ring. */
const NOW_LINE_OVERSHOOT = ACTIVITY_OFFSET + 0.15;

/** One 1.5 px ring per orbit family (all tilted around the shared Z axis), plus the 2 px now line along +Z with a dot at each crossing. */
export function Orbits({ layout }: { layout: readonly OrbitSpec[] }) {
  const outer = layout.length ? layout[layout.length - 1].radius : 2;
  const rings = useMemo(() => layout.map((o) => ({ id: o.id, tilt: o.tilt, radius: o.radius, points: circlePoints(o.radius, 160) })), [layout]);
  const nowPoints = useMemo<P3[]>(
    () => [
      [0, 0, GLOBE_RADIUS],
      [0, 0, outer + NOW_LINE_OVERSHOOT],
    ],
    [outer],
  );
  return (
    <group>
      {rings.map((r) => (
        <group key={r.id} rotation={[0, 0, r.tilt]}>
          <Line points={r.points} color={ACCENT_LO} lineWidth={1.5} transparent opacity={0.55} raycast={noRaycast} />
        </group>
      ))}
      <Line points={nowPoints} color={ACCENT_GLOW} lineWidth={2} raycast={noRaycast} />
      {rings.map((r) => (
        <mesh key={`dot-${r.id}`} position={[0, 0, r.radius]} geometry={dotGeometry} material={dotMaterial} raycast={noRaycast} />
      ))}
    </group>
  );
}
