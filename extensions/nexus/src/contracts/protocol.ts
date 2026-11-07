import { z } from "zod";
import * as A from "./accounts"; import * as P from "./prune"; import * as C from "./chat"; import * as T from "./tasks";
import * as S from "./swarms"; import * as E from "./events"; import { CodeRef } from "./coderef"; import { Id } from "./common";

// A plain union, not discriminatedUnion("t"): the two "res" variants share t = "res", which zod 4 rejects as a
// duplicate discriminator. Same wire shape as PLAN §2.9.
export const Envelope = z.union([
  z.object({ t: z.literal("req"),   id: z.string(), name: z.string(), body: z.unknown() }).strict(),  // webview -> ext
  z.object({ t: z.literal("res"),   id: z.string(), ok: z.literal(true), body: z.unknown() }).strict(),
  z.object({ t: z.literal("res"),   id: z.string(), ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }).strict(),
  z.object({ t: z.literal("sub"),   id: z.string(), name: z.string(), body: z.unknown() }).strict(),  // subscribe; id = subscription id
  z.object({ t: z.literal("unsub"), id: z.string() }).strict(),
  z.object({ t: z.literal("evt"),   id: z.string(), body: z.unknown() }).strict(),                    // ext -> webview, per subscription
]);
export type Envelope = z.infer<typeof Envelope>;

export const ErrorCode = z.enum(["invalid_request", "not_found", "unauthorized", "offline", "provider_error", "conflict", "cancelled", "internal"]);
export type ErrorCode = z.infer<typeof ErrorCode>;

const Empty = z.object({}).strict();
export const Requests = {
  "app.ping":            { req: Empty, res: z.object({ pong: z.literal(true), machineId: z.string(), tPlus: z.string() }) },
  "auth.status":         { req: Empty, res: z.object({ signedIn: z.boolean(), auth0UserId: z.string().optional(), name: z.string().optional(), slackViaTokenVault: z.boolean() }) },
  "store.status":        { req: Empty, res: z.object({ online: z.boolean(), outboxDepth: z.number().int(), lastSyncAt: z.string().optional() }) },
  "accounts.list":       { req: Empty, res: z.array(A.ProviderAccount) },
  "accounts.test":       { req: z.object({ accountId: Id }), res: A.ProviderAccount },               // re-runs listModels
  "models.list":         { req: z.object({ role: A.ModelRole.optional() }), res: z.array(A.ModelInfo) }, // role filters out Swarms for "agent"
  "optimizer.get":       { req: Empty, res: P.OptimizerSetting },
  "optimizer.set":       { req: P.OptimizerSetting, res: P.OptimizerSetting },
  "receipts.list":       { req: z.object({ sessionId: Id.optional(), limit: z.number().int().max(500).default(100) }), res: z.object({ receipts: z.array(P.ModelCallReceipt), summary: P.SpendSummary }) },
  "slack.status":        { req: Empty, res: C.SlackStatus },
  "slack.channels":      { req: Empty, res: z.array(C.Channel) },
  "slack.history":       { req: z.object({ channelId: z.string(), cursor: z.string().optional(), limit: z.number().int().max(200).default(50) }), res: z.object({ messages: z.array(C.ChatMessage), nextCursor: z.string().optional(), fromCache: z.boolean() }) },
  "slack.thread":        { req: z.object({ channelId: z.string(), threadTs: z.string() }), res: C.Thread },
  "slack.users":         { req: z.object({ ids: z.array(z.string()).optional() }), res: z.array(C.SlackUser) },
  "slack.post":          { req: z.object({ channelId: z.string(), text: z.string().min(1), threadTs: z.string().optional(), clientId: z.string() }), res: C.ChatMessage },   // as the USER; clientId matches the pending echo
  "tasks.createFromThread": { req: z.object({ channelId: z.string(), threadTs: z.string() }), res: T.Task },  // status "draft"
  "tasks.get":           { req: z.object({ taskId: Id }), res: T.Task },
  "tasks.list":          { req: z.object({ status: T.TaskStatus.optional() }), res: z.array(T.Task) },
  "tasks.update":        { req: z.object({ taskId: Id, title: z.string().optional(), brief: z.string().optional() }), res: T.Task }, // only while draft
  "agent.start":         { req: z.object({ taskId: Id, model: z.object({ provider: z.string(), modelId: z.string() }) }), res: T.AgentSession },
  "agent.cancel":        { req: z.object({ sessionId: Id }), res: T.AgentSession },
  "sessions.get":        { req: z.object({ sessionId: Id }), res: T.AgentSession },
  "sessions.list":       { req: z.object({ status: T.SessionStatus.optional() }), res: z.array(T.AgentSession) },
  "approvals.list":      { req: z.object({ sessionId: Id.optional(), pendingOnly: z.boolean().default(false) }), res: z.array(T.ApprovalRequest) },
  "approvals.resolve":   { req: z.object({ approvalId: Id, decision: T.Decision }), res: T.ApprovalRequest },   // via "app"; conditional write, returns the winner
  "swarms.review.get":   { req: z.object({ approvalId: Id }), res: S.SwarmReview.nullable() },
  "swarms.review.rerun": { req: z.object({ approvalId: Id }), res: S.SwarmReview },
  "tasks.decompose":     { req: z.object({ taskId: Id }), res: S.TaskPlan },                          // status "proposed"
  "tasks.plan.get":      { req: z.object({ planId: Id }), res: S.TaskPlan },
  "tasks.plan.accept":   { req: z.object({ planId: Id }), res: S.TaskPlan },                         // creates Tasks, sets createdTaskIds
  "tasks.plan.reject":   { req: z.object({ planId: Id }), res: S.TaskPlan },
  "events.query":        { req: E.EventQuery, res: z.array(E.NexusEvent) },
  "events.search":       { req: z.object({ q: z.string().min(1), limit: z.number().int().max(50).default(20) }), res: z.array(E.EventSearchHit) }, // whole store
  "events.activity":     { req: z.object({ from: z.string(), to: z.string() }), res: z.array(E.ActivityBucket) },
  "git.commit.show":     { req: z.object({ sha: z.string() }), res: z.object({ sha: z.string(), subject: z.string(), body: z.string(), author: z.string(), at: z.string(), parents: z.array(z.string()), files: z.array(z.object({ path: z.string(), status: z.enum(["A","M","D","R"]), additions: z.number().int(), deletions: z.number().int() })) }) },
  "git.branches":        { req: Empty, res: z.array(z.object({ name: z.string(), head: z.string(), isCurrent: z.boolean(), isAgent: z.boolean() })) },
  "git.mergeAgentBranch":{ req: z.object({ sessionId: Id }), res: z.object({ ok: z.boolean(), mergeSha: z.string().optional(), message: z.string() }) }, // aborts cleanly on conflict
  "coderef.create":      { req: z.object({ path: z.string(), startLine: z.number().int(), endLine: z.number().int() }), res: z.object({ ref: CodeRef, link: z.string(), snippet: z.string() }) },
  "coderef.open":        { req: z.object({ ref: CodeRef }), res: z.object({ opened: z.enum(["at_commit", "current"]), stale: z.boolean() }) },
  "ui.openTarget":       { req: E.EventTarget, res: Empty },
  "ui.openExternal":     { req: z.object({ url: z.string().url().refine(u => u.startsWith("https://"), "https only") }), res: Empty },   // host validates again, then opens in the system browser
  "ui.setTimeWindow":   { req: z.object({ window: E.TimeWindow }), res: Empty },
} as const;

export const Subscriptions = {
  "slack.subscribe":          { req: z.object({ channelIds: z.array(z.string()) }), evt: z.discriminatedUnion("type", [
                                 z.object({ type: z.literal("message"), message: C.ChatMessage }),
                                 z.object({ type: z.literal("message_changed"), message: C.ChatMessage }),
                                 z.object({ type: z.literal("status"), status: C.SlackStatus }) ]) },
  "agent.subscribe":          { req: z.object({ sessionId: Id, fromSeq: z.number().int().nonnegative().default(0) }), evt: T.AgentEvent }, // replays from fromSeq, then live
  "approvals.subscribe":      { req: Empty, evt: T.ApprovalRequest },                                 // every create/resolve, any machine
  "swarms.review.subscribe":  { req: z.object({ approvalId: Id.optional() }), evt: S.SwarmReview },
  "events.subscribe":         { req: Empty, evt: E.NexusEvent },
  "receipts.subscribe":       { req: z.object({ sessionId: Id.optional() }), evt: P.ModelCallReceipt },
  "store.subscribe":          { req: Empty, evt: z.object({ online: z.boolean(), outboxDepth: z.number().int() }) },
  "tasks.subscribe":          { req: Empty, evt: T.Task },
} as const;

export type RequestName = keyof typeof Requests;
export type Req<N extends RequestName> = z.infer<(typeof Requests)[N]["req"]>;
export type Res<N extends RequestName> = z.infer<(typeof Requests)[N]["res"]>;
export type SubscriptionName = keyof typeof Subscriptions;
export type SubEvt<N extends SubscriptionName> = z.infer<(typeof Subscriptions)[N]["evt"]>;
