import { z } from "zod";
import { Id, Sha } from "./common";
import { Task } from "./tasks";

export const AgentEnvelope = z.discriminatedUnion("t", [
  z.object({ t: z.literal("req"), id: z.string(), name: z.string(), body: z.unknown() }).strict(),
  z.object({ t: z.literal("res"), id: z.string(), ok: z.boolean(), body: z.unknown().optional(), error: z.string().optional() }).strict(),
  z.object({ t: z.literal("evt"), name: z.string(), body: z.unknown() }).strict(),
]);
export type AgentEnvelope = z.infer<typeof AgentEnvelope>;

// agent -> extension (every one of these goes through the GATE; §14)
export const AgentRequests = {
  "fs.read":   { req: z.object({ path: z.string() }), res: z.object({ content: z.string(), truncated: z.boolean() }) },
  "fs.write":  { req: z.object({ path: z.string(), content: z.string() }), res: z.object({ bytes: z.number().int() }) },   // outside worktree => ApprovalRequest write_outside_scope
  "fs.list":   { req: z.object({ path: z.string().default("."), depth: z.number().int().max(4).default(2) }), res: z.object({ entries: z.array(z.string()) }) },
  "cmd.run":   { req: z.object({ command: z.string(), timeoutMs: z.number().int().max(300000).default(120000) }), res: z.object({ exitCode: z.number().int(), stdoutTail: z.string(), stderrTail: z.string(), approvalId: Id.optional() }) }, // not allowlisted => waits on an ApprovalRequest
  "git.diff":  { req: z.object({}), res: z.object({ diff: z.string() }) },                                                    // git diff in the worktree, produced by the host
  "git.commit":{ req: z.object({ message: z.string() }), res: z.object({ sha: Sha, approvalId: Id }) },                      // always an ApprovalRequest(commit); resolves after a human approves
  "approval.request": { req: z.object({ kind: z.literal("other"), description: z.string(), reason: z.string() }), res: z.object({ approvalId: Id, decision: z.enum(["approved","rejected"]) }) },
  "slack.progress":   { req: z.object({ text: z.string() }), res: z.object({ ok: z.boolean() }) },                          // edits the session's single bot message in place
  "credentials.get":  { req: z.object({ provider: z.string(), callId: Id }), res: z.object({ apiKey: z.string(), baseUrl: z.string().optional(), prune: z.object({ enabled: z.boolean(), apiKey: z.string().optional(), allowModelRouting: z.literal(false) }).optional() }) }, // per call; never persisted by the agent
  "event.emit":       { req: z.object({ type: z.enum(["message", "tool_call", "tool_result", "error", "receipt"]), payload: z.unknown() }), res: z.object({ seq: z.number().int() }) }, // host assigns seq
} as const;

// extension -> agent
export const HostRequests = {
  "session.start":  { req: z.object({ session: z.object({ id: Id, taskId: Id, branch: z.string(), worktreePath: z.string(), baseCommit: Sha, model: z.object({ provider: z.string(), modelId: z.string() }) }), task: Task, systemRules: z.string(), untrustedBlocks: z.array(z.object({ label: z.string(), text: z.string() })) }), res: z.object({ accepted: z.literal(true) }) },
  "session.cancel": { req: z.object({ sessionId: Id }), res: z.object({ cancelled: z.literal(true) }) },
  "health":         { req: z.object({}), res: z.object({ ok: z.literal(true), pid: z.number().int() }) },
} as const;

// Host events to the agent: "approval.resolved" { approvalId, decision }  (wakes a waiting cmd.run / git.commit)
export const HostEvents = {
  "approval.resolved": z.object({ approvalId: Id, decision: z.enum(["approved", "rejected"]) }).strict(),
} as const;

export type AgentRequestName = keyof typeof AgentRequests;
export type HostRequestName = keyof typeof HostRequests;
