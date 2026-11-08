import { useMemo, useRef } from "react";
import { BoxGeometry, MeshBasicMaterial, OctahedronGeometry } from "three";
import type { Group } from "three";
import { Line } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import type { NexusEvent, TimeWindow } from "../../../src/contracts";
import { ACTIVITY_OFFSET, activityKey, activityPoint, shapeOf } from "../model/arcs";
import type { OrbitSpec } from "../model";
import { ACCENT, ACCENT_GLOW, ACCENT_LO } from "./colors";
import { FAR_OPACITY, applyFade } from "./fade";
import { circlePoints, noRaycast } from "./Orbits";
import { applyDrift, liveScale, useDriftNow } from "./live";
import type { DriftData } from "./live";

// Shared for the page lifetime; never disposed. Markers differ by shape and brightness only: no status colors in the scene.
const cubeGeometry = new BoxGeometry(0.1, 0.1, 0.1);
const diamondGeometry = new OctahedronGeometry(0.075, 0);
const cubeMaterial = new MeshBasicMaterial({ color: ACCENT_GLOW });
const cubeFar = new MeshBasicMaterial({ color: ACCENT_GLOW, transparent: true, opacity: FAR_OPACITY });
const diamondMaterial = new MeshBasicMaterial({ color: ACCENT });
const diamondFar = new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: FAR_OPACITY });

export interface ActivityProps {
  events: readonly NexusEvent[];
  layout: readonly OrbitSpec[];
  now: number;
  window: TimeWindow;
}

interface Placed {
  event: NexusEvent;
  shape: "cube" | "diamond";
  position: [number, number, number];
  data: DriftData;
  scale: number;
}

/** Agent sessions (cubes) and Slack tasks (diamonds) on a faint activity ring just outside each orbit. */
export function Activity({ events, layout, now, window }: ActivityProps) {
  // Keyed on the activity events themselves: the 5 s tick re-filters `events` without changing any of them.
  const key = activityKey(events);
  const placed = useMemo<Placed[]>(() => {
    const byId = new Map(layout.map((o) => [o.id, o]));
    const out: Placed[] = [];
    for (const event of events) {
      const shape = shapeOf(event.kind);
      if (shape !== "cube" && shape !== "diamond") continue;
      const orbit = byId.get(event.orbit);
      if (!orbit) continue;
      const atMs = Date.parse(event.at);
      out.push({ event, shape, position: activityPoint(orbit, atMs, now, window), data: { eventId: event.id, atMs, radius: orbit.radius, tilt: orbit.tilt }, scale: liveScale(event.id, performance.now()) });
    }
    return out;
    // Initial positions only; useFrame owns them afterwards, so `now` is deliberately not a dependency.
  }, [key, layout, window]);

  const withActivity = useMemo(() => new Set(placed.map((p) => p.event.orbit)), [placed]);
  const rings = useMemo(
    () =>
      layout
        .filter((o) => o.id !== "main" || withActivity.has(o.id))
        .map((o) => ({ id: o.id, tilt: o.tilt, points: circlePoints(o.radius + ACTIVITY_OFFSET, 160) })),
    [layout, withActivity],
  );

  const cubes = useRef<Group>(null);
  const diamonds = useRef<Group>(null);
  const camera = useThree((s) => s.camera);
  const driftNow = useDriftNow(now);
  useFrame(() => {
    const n = driftNow();
    const perf = performance.now();
    if (cubes.current) {
      applyDrift(cubes.current, n, window, ACTIVITY_OFFSET, perf);
      applyFade(cubes.current, camera, cubeMaterial, cubeFar);
    }
    if (diamonds.current) {
      applyDrift(diamonds.current, n, window, ACTIVITY_OFFSET, perf);
      applyFade(diamonds.current, camera, diamondMaterial, diamondFar);
    }
  });

  return (
    <group>
      {rings.map((r) => (
        <group key={r.id} rotation={[0, 0, r.tilt]}>
          <Line points={r.points} color={ACCENT_LO} lineWidth={1} transparent opacity={0.3} dashed dashSize={0.08} gapSize={0.06} raycast={noRaycast} />
        </group>
      ))}
      <group ref={cubes}>
        {placed.filter((p) => p.shape === "cube").map((p) => (
          <mesh key={p.event.id} position={p.position} scale={p.scale} geometry={cubeGeometry} material={cubeMaterial} userData={p.data} />
        ))}
      </group>
      <group ref={diamonds}>
        {placed.filter((p) => p.shape === "diamond").map((p) => (
          <mesh key={p.event.id} position={p.position} scale={p.scale} geometry={diamondGeometry} material={diamondMaterial} userData={p.data} />
        ))}
      </group>
    </group>
  );
}
