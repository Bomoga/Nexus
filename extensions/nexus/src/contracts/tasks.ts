import { z } from "zod";
import { Id, IsoTime, Sha } from "./common";
import { CodeRef } from "./coderef";
import { ModelCallReceipt } from "./prune";

export const TaskSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), channelId: z.string(), threadTs: z.string() }).strict(),
  z.object({ kind: z.literal("manual") }).strict(),
  z.object({ kind: z.literal("plan"), planId: Id, subtaskIndex: z.number().int().nonnegative() }).strict(), // Tier 3 breakdown
]);

export const TaskStatus = z.enum(["draft", "running", "awaiting_approval", "done", "failed", "cancelled"]);

export const Task = z.object({
  id: Id, title: z.string().min(1), brief: z.string(),
  source: TaskSource, workspaceId: z.string(), status: TaskStatus,
  sessionId: Id.optional(), createdAt: IsoTime,
  codeRefs: z.array(CodeRef).default([]),  // resolved from the source thread; the brief quotes them
  createdBy: z.object({ userId: z.string(), auth0UserId: z.string().optional() }).optional(),
}).strict();

export const SessionStatus = z.enum(["running", "awaiting_approval", "done", "failed", "cancelled"]);

export const AgentSession = z.object({
  id: Id, taskId: Id,
  model: z.object({ provider: z.string(), modelId: z.string() }).strict(),
  branch: z.string().regex(/^nexus\/agent-[A-Za-z0-9_-]+$/),
  worktreePath: z.string().min(1),
  baseCommit: Sha,
  status: SessionStatus,
  startedAt: IsoTime, endedAt: IsoTime.optional(),
  machineId: z.string(),                   // writer machine (dedupe in the shared store)
  optimizer: z.object({ enabled: z.boolean(), scope: z.enum(["text_roles","all_roles"]) }).optional(),
  slackProgress: z.object({ channelId: z.string(), threadTs: z.string(), messageTs: z.string() }).optional(), // the one progress message
}).strict();

const Base = { sessionId: Id, seq: z.number().int().nonnegative(), at: IsoTime };
export const AgentEvent = z.discriminatedUnion("type", [
  z.object({ ...Base, type: z.literal("status"), status: SessionStatus }).strict(),
  z.object({ ...Base, type: z.literal("message"), text: z.string() }).strict(),                 // model-written, label it
  z.object({ ...Base, type: z.literal("tool_call"), tool: z.string(), args: z.unknown() }).strict(),
  z.object({ ...Base, type: z.literal("tool_result"), tool: z.string(), ok: z.boolean(), summary: z.string() }).strict(),
  z.object({ ...Base, type: z.literal("file_edit"), path: z.string(), diff: z.string() }).strict(), // from git diff, never model prose
  z.object({ ...Base, type: z.literal("approval_request"), approvalId: Id }).strict(),
  z.object({ ...Base, type: z.literal("approval_resolved"), approvalId: Id, decision: z.enum(["approved","rejected"]) }).strict(),
  z.object({ ...Base, type: z.literal("commit"), sha: Sha }).strict(),
  z.object({ ...Base, type: z.literal("error"), message: z.string() }).strict(),
  z.object({ ...Base, type: z.literal("test_output"), command: z.string(), exitCode: z.number().int(), tail: z.string() }).strict(), // last 200 lines, redacted
  z.object({ ...Base, type: z.literal("receipt"), receipt: ModelCallReceipt }).strict(),           // Prune receipt for a call in this session
]);

export const ApprovalAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run_command"), command: z.string() }).strict(),
  z.object({ kind: z.literal("write_outside_scope"), path: z.string() }).strict(),
  z.object({ kind: z.literal("commit"), message: z.string() }).strict(),
  z.object({ kind: z.literal("other"), description: z.string() }).strict(),
]);

export const Decision = z.enum(["approved", "rejected"]);
export const DecidedBy = z.object({
  via: z.enum(["slack", "app", "auth0_push"]),
  userId: z.string(),                      // Slack user ID for "slack"; OS/VS Code identity label for "app"; Auth0 sub for "auth0_push"
  auth0UserId: z.string().optional(),
}).strict();

export const ApprovalRequest = z.object({
  id: Id, sessionId: Id, action: ApprovalAction,
  reason: z.string(),                      // model-written, shown verbatim, labeled
  requestedAt: IsoTime,
  decision: Decision.optional(),
  decidedBy: DecidedBy.optional(),
  decidedAt: IsoTime.optional(),
  slackMessage: z.object({ channelId: z.string(), ts: z.string() }).optional(),   // the Block Kit message with buttons
  cibaAuthReqId: z.string().optional(),   // set when an auth0_push request was started
  diffPreview: z.string().optional(),      // redacted git diff for commit approvals (what the council and the card show)
}).strict();

export type Task = z.infer<typeof Task>; export type AgentSession = z.infer<typeof AgentSession>;
export type AgentEvent = z.infer<typeof AgentEvent>; export type ApprovalRequest = z.infer<typeof ApprovalRequest>;
export type ApprovalAction = z.infer<typeof ApprovalAction>; export type DecidedBy = z.infer<typeof DecidedBy>;
