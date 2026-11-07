import { z } from "zod";
import { CodeRef } from "./coderef";

export const SlackUser = z.object({
  id: z.string(), name: z.string(), displayName: z.string(),
  avatarUrl: z.string().url().optional(), isBot: z.boolean(),
}).strict();

export const Channel = z.object({
  id: z.string(), name: z.string(), isPrivate: z.boolean(),
  isMember: z.boolean(), botIsMember: z.boolean(), unreadCount: z.number().int().nonnegative().optional(),
}).strict();

export const SlackTs = z.string().regex(/^\d+\.\d+$/);

export const ChatMessage = z.object({
  id: z.string(),                          // `${channelId}:${ts}`
  channelId: z.string(),
  ts: SlackTs,
  threadTs: SlackTs.optional(),
  author: z.object({ id: z.string(), name: z.string(), isBot: z.boolean() }).strict(),
  text: z.string(),                        // UNTRUSTED (§14): never executed, only quoted into prompts
  codeRefs: z.array(CodeRef),
  replyCount: z.number().int().nonnegative().optional(),
  sentVia: z.enum(["user", "bot"]),
  pending: z.boolean().optional(),
  failed: z.boolean().optional(),          // a pending send Slack rejected; UI offers retry
  blocks: z.unknown().optional(),          // raw Block Kit for agent/approval messages (rendered by Lane 3, never executed)
}).strict();

export const Thread = z.object({ channelId: z.string(), threadTs: SlackTs, messages: z.array(ChatMessage) }).strict();

export const SlackStatus = z.object({
  connected: z.boolean(),                  // Socket Mode up
  postsAs: z.object({ userId: z.string(), name: z.string() }).nullable(),   // null => would post as app (fallback warning)
  userTokenSource: z.enum(["token_vault", "manual", "none"]),
  botName: z.string(),
}).strict();

export type SlackUser = z.infer<typeof SlackUser>; export type Channel = z.infer<typeof Channel>;
export type ChatMessage = z.infer<typeof ChatMessage>; export type Thread = z.infer<typeof Thread>;
export type SlackStatus = z.infer<typeof SlackStatus>;
