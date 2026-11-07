import { z } from "zod";

// Child -> host events that are internal to Lane 1's two processes (PLAN L1-09). The frozen agent protocol has no
// "session finished" message, so the child reports it as an AgentEnvelope `evt`; Lane 2's gate never sees it.

export const SESSION_FINISHED = "session.finished";

export const SessionFinished = z.object({
  sessionId: z.string().min(1),
  outcome: z.enum(["done", "failed", "cancelled"]),
  turns: z.number().int().nonnegative(),
  reason: z.string().optional(),
}).strict();
export type SessionFinished = z.infer<typeof SessionFinished>;
