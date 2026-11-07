import { z } from "zod";
import { Id, IsoTime } from "./common";

export const Verdict = z.enum(["looks_good", "concerns", "do_not_merge"]);

export const SwarmReview = z.object({
  id: Id, sessionId: Id, approvalId: Id,
  swarmType: z.union([z.literal("CouncilAsAJudge"), z.string()]),
  status: z.enum(["running", "done", "unavailable"]),
  verdict: Verdict.optional(),
  summary: z.string().optional(),          // model-written, labeled
  judges: z.array(z.object({ modelId: z.string(), verdict: Verdict, notes: z.string() }).strict()).optional(),
  at: IsoTime,
  durationMs: z.number().int().nonnegative().optional(),
  dataLeftMachine: z.literal(true).default(true),   // Swarms always runs remotely; the card says so
}).strict();

export const TaskPlan = z.object({
  id: Id, sourceTaskId: Id,
  swarmType: z.union([z.literal("HierarchicalSwarm"), z.string()]),
  status: z.enum(["proposed", "accepted", "rejected"]),
  subtasks: z.array(z.object({ title: z.string(), brief: z.string(), dependsOn: z.array(z.number().int().nonnegative()) }).strict()).min(2).max(4),
  createdTaskIds: z.array(Id).optional(),  // only after a human accepts
  at: IsoTime,
}).strict().refine(p => p.subtasks.every((s, i) => s.dependsOn.every(d => d < p.subtasks.length && d !== i)), "dependsOn indices valid");

export type SwarmReview = z.infer<typeof SwarmReview>; export type TaskPlan = z.infer<typeof TaskPlan>;
