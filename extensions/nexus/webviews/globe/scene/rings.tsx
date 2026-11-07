import { useEffect, useMemo, useRef } from "react";
import { BoxGeometry, BufferGeometry, Line, LineBasicMaterial, MeshBasicMaterial, OctahedronGeometry, Vector3 } from "three";
import type { Group } from "three";
import { useFrame } from "@react-three/fiber";
import type { NexusEvent, TimeWindow } from "../../../src/contracts";
import { ACTIVITY_OFFSET, activityKey, activityPoint, shapeOf } from "../model/arcs";
import type { OrbitSpec } from "../model";
import { PURPLE_HI } from "./colors";
import { applyDrift, liveScale, useDriftNow } from "./live";
import type { DriftData } from "./live";

/** Event-kind colors from the prototype legend: the only non-purple things in the globe. */
export const AGENT_GREEN = 0x1d9e75;
export const SLACK_PINK = 0xd4537e;

// Shared for the page lifetime; never disposed.
const cubeGeometry = new BoxGeometry(0.1, 0.1, 0.1);
const diamondGeometry = new OctahedronGeometry(0.075, 0);
const cubeMaterial = new MeshBasicMaterial({ color: AGENT_GREEN });
const diamondMaterial = new MeshBasicMaterial({ color: SLACK_PINK });
const ringMaterial = new LineBasicMaterial({ color: PURPLE_HI, transparent: true, opacity: 0.22 });

function circle(r: number, segments: number): BufferGeometry {
  const pts: Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
  }
  return new BufferGeometry().setFromPoints(pts);
}

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

/** Agent sessions (green cubes) and Slack tasks (pink diamonds) on a faint activity ring just outside each orbit. */
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
        .map((o) => ({ id: o.id, tilt: o.tilt, line: new Line(circle(o.radius + ACTIVITY_OFFSET, 160), ringMaterial) })),
    [layout, withActivity],
  );
  // Geometries are ours (materials are shared): release them when the rings change or on unmount.
  useEffect(() => () => rings.forEach((r) => r.line.geometry.dispose()), [rings]);

  const group = useRef<Group>(null);
  const driftNow = useDriftNow(now);
  useFrame(() => {
    if (group.current) applyDrift(group.current, driftNow(), window, ACTIVITY_OFFSET, performance.now());
  });

  return (
    <group>
      {rings.map((r) => (
        <group key={r.id} rotation={[0, 0, r.tilt]}>
          <primitive object={r.line} />
        </group>
      ))}
      <group ref={group}>
        {placed.map((p) => (
          <mesh
            key={p.event.id}
            position={p.position}
            scale={p.scale}
            geometry={p.shape === "cube" ? cubeGeometry : diamondGeometry}
            material={p.shape === "cube" ? cubeMaterial : diamondMaterial}
            userData={p.data}
          />
        ))}
      </group>
    </group>
  );
}
