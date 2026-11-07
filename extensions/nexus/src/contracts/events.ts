import { z } from "zod";
import { Id, IsoTime, Sha } from "./common";

export const EventKind = z.enum(["commit", "merge", "branch", "tag", "agent_session", "slack_task"]);
export const EventTarget = z.discriminatedUnion("type", [
  z.object({ type: z.literal("commit"), sha: Sha }).strict(),
  z.object({ type: z.literal("session"), sessionId: Id }).strict(),
  z.object({ type: z.literal("thread"), channelId: z.string(), threadTs: z.string() }).strict(),
]);

export const NexusEvent = z.object({
  id: Id,                                  // git: `${workspaceId}:${kind}:${sha}`; others: ULID → same event never stored twice
  kind: EventKind,
  at: IsoTime,                             // committer date for git events
  orbit: z.string().min(1),                // branch family: "main", "lane-1", "feature/x"
  fromOrbit: z.string().optional(),        // merges only
  title: z.string(),
  actor: z.object({ name: z.string(), kind: z.enum(["human", "agent"]) }).strict(),
  target: EventTarget,
  workspaceId: z.string(),
  machineId: z.string(),                   // writer
  auth0UserId: z.string().optional(),
}).strict();

export function orbitOf(branch: string): string {       // frozen rule from §5 semantics
  if (branch === "main") return "main";
  const m = /^(lane-\d+)(\/.*|-wt\/.*)?$/.exec(branch); if (m) return m[1];   // lane-N/... and worker branches lane-N-wt/<id>
  if (branch.startsWith("nexus/agent-")) return "main";  // caller overrides with the session's base branch family
  return branch.split("/").slice(0, 2).join("/");         // "feature/x/y" -> "feature/x"
}

export const TimeWindow = z.enum(["24h", "36h", "7d", "30d"]);
export const EventQuery = z.object({ from: IsoTime, to: IsoTime, orbits: z.array(z.string()).optional(), kinds: z.array(EventKind).optional(), limit: z.number().int().max(5000).default(2000) }).strict();
export const EventSearchHit = z.object({ event: NexusEvent, score: z.number() }).strict();
export const ActivityBucket = z.object({ bucketStart: IsoTime, orbit: z.string(), count: z.number().int().nonnegative() }).strict(); // 15-minute buckets (continuous aggregate)

export type NexusEvent = z.infer<typeof NexusEvent>; export type EventQuery = z.infer<typeof EventQuery>;
export type ActivityBucket = z.infer<typeof ActivityBucket>; export type TimeWindow = z.infer<typeof TimeWindow>;
export type EventTarget = z.infer<typeof EventTarget>; export type EventSearchHit = z.infer<typeof EventSearchHit>;
