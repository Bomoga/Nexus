// The Slack service interface (L2-02/L2-03). Every value crosses as a contract type; no token value ever does.
import type { Channel, ChatMessage, SlackStatus, SlackUser, Thread } from "../../contracts";

export interface HistoryPage { messages: ChatMessage[]; nextCursor?: string; fromCache: boolean }

export interface PostOptions { channelId: string; text: string; threadTs?: string; clientId?: string }

export interface BotPostOptions extends PostOptions { blocks?: unknown }

export type SlackMessageEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "message_changed"; message: ChatMessage }
  | { type: "status"; status: SlackStatus };

export interface Disposable { dispose(): void }

export interface SlackService {
  /** Posts with the person's own user token (sentVia "user"). Never used for anything the agent says. */
  postAsUser(opts: PostOptions): Promise<ChatMessage>;
  /** Posts with the bot token (sentVia "bot"): agent and approval messages. */
  postAsBot(opts: BotPostOptions): Promise<ChatMessage>;
  /** Edits a bot message in place (progress message). */
  updateBotMessage(channelId: string, ts: string, text: string, blocks?: unknown): Promise<ChatMessage>;
  channels(): Promise<Channel[]>;
  /** Newest first, cursor paged; cache first. */
  history(channelId: string, cursor?: string, limit?: number): Promise<HistoryPage>;
  /** Structurally satisfies Lane 1's SlackPort.getThread. */
  getThread(channelId: string, threadTs: string): Promise<Thread>;
  /** All known users, or only the given ids. */
  users(ids?: string[]): Promise<SlackUser[]>;
  status(): Promise<SlackStatus>;
  /** Live messages, edits and status changes for the given channels (all when omitted). */
  onMessage(listener: (evt: SlackMessageEvent) => void, channelIds?: string[]): Disposable;
}
