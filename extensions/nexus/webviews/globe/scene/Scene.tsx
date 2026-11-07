import { useMemo } from "react";
import type { ReactNode } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { NexusEvent, TimeWindow } from "../../../src/contracts";
import { familiesKey, familiesOf, orbitLayout } from "../model";
import { Globe } from "./Globe";
import { Arcs } from "./arcs";
import { Markers } from "./Markers";
import { Orbits } from "./Orbits";
import { Picking } from "./picking";
import { Activity } from "./rings";
import { Tracking } from "./Tracking";
import { Fit } from "./Fit";
import { DriftFrozen } from "./live";
import { WORLD_ROTATION } from "../model/tracking";
import { CAMERA_FAR, outerRadius } from "../model/fit";

const noop = () => undefined;

export interface SceneProps {
  events: readonly NexusEvent[];
  now: number;
  window: TimeWindow;
  /** Click selection (markers, arcs, activity shapes); undefined for a click on empty space. */
  onPick?: (event: NexusEvent | undefined) => void;
  /** The event the camera follows and rings (search/track); undefined for none. */
  tracked?: NexusEvent;
  /** The user dragged the globe while tracking. */
  onRelease?: () => void;
  /** The globe is pinned to a past time: stop the per-frame drift. */
  frozen?: boolean;
  /** Seam for arcs, activity rings and picking: rendered inside the same world group. */
  children?: ReactNode;
}

/** The Canvas fills its parent, which must have an explicit (not content-driven) height; r3f handles resize. */
export function Scene({ events, now, window, onPick, tracked, onRelease, frozen = false, children }: SceneProps) {
  // Rebuild orbits only when the set of families changes, not on every events/now update.
  const key = familiesKey(familiesOf(events));
  const layout = useMemo(() => orbitLayout(key.split("\u0000")), [key]);
  return (
    <Canvas camera={{ fov: 40, position: [0, 0.8, 8.2], near: 0.1, far: CAMERA_FAR }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }}>
      <DriftFrozen.Provider value={frozen}>
      <OrbitControls enablePan={false} minDistance={4} maxDistance={14} rotateSpeed={0.6} makeDefault />
      <Fit radius={outerRadius(layout)} tracking={tracked !== undefined} />
      {onPick ? <Picking events={events} layout={layout} onPick={onPick} /> : null}
      <Tracking event={tracked} layout={layout} now={now} window={window} onRelease={onRelease ?? noop} />
      <group rotation={WORLD_ROTATION as [number, number, number]}>
        <Globe />
        <Orbits layout={layout} />
        <Markers events={events} layout={layout} now={now} window={window} />
        <Activity events={events} layout={layout} now={now} window={window} />
        <Arcs events={events} layout={layout} now={now} window={window} />
        {children}
      </group>
      </DriftFrozen.Provider>
    </Canvas>
  );
}
