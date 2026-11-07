import { useMemo } from "react";
import type { ReactNode } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { NexusEvent, TimeWindow } from "../../../src/contracts";
import { familiesOf, orbitLayout } from "../model";
import { Globe } from "./Globe";
import { Markers } from "./Markers";
import { Orbits } from "./Orbits";

export interface SceneProps {
  events: readonly NexusEvent[];
  now: number;
  window: TimeWindow;
  /** Seam for arcs, activity rings and picking: rendered inside the same world group. */
  children?: ReactNode;
}

/** The Canvas fills its parent, which must have an explicit (not content-driven) height; r3f handles resize. */
export function Scene({ events, now, window, children }: SceneProps) {
  const layout = useMemo(() => orbitLayout(familiesOf(events)), [events]);
  return (
    <Canvas camera={{ fov: 40, position: [0, 0.8, 8.2], near: 0.1, far: 100 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }}>
      <OrbitControls enablePan={false} minDistance={4} maxDistance={14} rotateSpeed={0.6} makeDefault />
      <group rotation={[0.22, -0.7, 0]}>
        <Globe />
        <Orbits layout={layout} />
        <Markers events={events} layout={layout} now={now} window={window} />
        {children}
      </group>
    </Canvas>
  );
}
