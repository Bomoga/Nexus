// The full SlackService (L2-03): SlackWebClient (user-token reads and posts) + SlackBot (bot posts and edits) + SlackSocket (live events),
// composed by delegation. The SlackService interface in types.ts is unchanged; start() and stop() are extras of this class.
import type { ApprovalRequest, Channel, ChatMessage, SlackStatus, SlackUser, SwarmReview, Thread } from "../../contracts";
import { SlackBot, type BotIdentity, type BotTokenProvider } from "./bot";
import { postApprovalMessage, refreshApprovalMessage, registerInteractivity, type ResolveApproval } from "./interactivity";
import { SlackSocket, type SocketOptions } from "./socket";
import type { BotPostOptions, Disposable, HistoryPage, PostOptions, SlackMessageEvent, SlackService } from "./types";
import { SlackWebClient, type TokenProvider, type UserSlack, type WebClientOptions } from "./web-client";

export interface ComposedParts {
  web: UserSlack;
  bot: Pick<SlackBot, "postAsBot" | "updateBotMessage" | "identity">;
  socket: Pick<SlackSocket, "onMessage" | "onConnection" | "isConnected" | "start" | "stop">;
}

export class ComposedSlackService implements SlackService {
  constructor(private readonly parts: ComposedParts) {}

  start(): Promise<boolean> { return this.parts.socket.start(); }
  stop(): Promise<void> { return this.parts.socket.stop(); }

  // user token
  postAsUser(opts: PostOptions): Promise<ChatMessage> { return this.parts.web.postAsUser(opts); }
  channels(): Promise<Channel[]> { return this.parts.web.channels(); }
  history(channelId: string, cursor?: string, limit?: number): Promise<HistoryPage> { return this.parts.web.history(channelId, cursor, limit); }
  getThread(channelId: string, threadTs: string): Promise<Thread> { return this.parts.web.getThread(channelId, threadTs); }
  users(ids?: string[]): Promise<SlackUser[]> { return this.parts.web.users(ids); }

  // bot token: the only path the agent uses
  postAsBot(opts: BotPostOptions): Promise<ChatMessage> { return this.parts.bot.postAsBot(opts); }
  updateBotMessage(channelId: string, ts: string, text: string, blocks?: unknown): Promise<ChatMessage> { return this.parts.bot.updateBotMessage(channelId, ts, text, blocks); }

  async status(): Promise<SlackStatus> {
    const [user, bot] = await Promise.all([
      this.parts.web.status().catch(() => ({ postsAs: null, userTokenSource: "none" as const })),
      this.parts.bot.identity().catch((): BotIdentity | null => null),
    ]);
    return { connected: this.parts.socket.isConnected(), postsAs: user.postsAs, userTokenSource: user.userTokenSource, botName: bot?.name ?? "nexus" };
  }

  onMessage(listener: (evt: SlackMessageEvent) => void, channelIds?: string[]): Disposable {
    const live = this.parts.socket.onMessage(listener, channelIds);
    const conn = this.parts.socket.onConnection(() => {
      void this.status().then(status => { try { listener({ type: "status", status }); } catch { /* isolate the listener */ } }, () => undefined);
    });
    return { dispose: () => { live.dispose(); conn.dispose(); } };
  }

  /** Posts the Block Kit approval card as the bot. The caller stores the returned ts as ApprovalRequest.slackMessage. */
  postApproval(channelId: string, approval: ApprovalRequest, review?: SwarmReview, threadTs?: string): Promise<ChatMessage> {
    return postApprovalMessage(this, channelId, approval, review, threadTs);
  }

  /** Re-renders an approval card (verdict arrived, or decided elsewhere). */
  refreshApproval(approval: ApprovalRequest, review?: SwarmReview): Promise<ChatMessage> { return refreshApprovalMessage(this, approval, review); }
}

export interface CreateSlackServiceOptions {
  getUserToken: TokenProvider;
  getBotTokens: BotTokenProvider;
  /** approvals.resolve in the host. */
  resolve: ResolveApproval;
  /** The stored approval; a button click is accepted only on the card its slackMessage names. */
  getApproval: (approvalId: string) => ApprovalRequest | undefined | Promise<ApprovalRequest | undefined>;
  getReview?: (approvalId: string) => SwarmReview | undefined;
  /** Called when Slack refuses the user token (see WebClientOptions.onTokenRejected). */
  onUserTokenRejected?: WebClientOptions["onTokenRejected"];
  /** Test seams, passed through. */
  webOptions?: Pick<WebClientOptions, "makeApi" | "now" | "botMembershipTtlMs">;
  makeBotApi?: ConstructorParameters<typeof SlackBot>[0]["makeApi"];
  socketOptions?: Pick<SocketOptions, "makeApp" | "initialBackoffMs" | "maxBackoffMs" | "sleep" | "now">;
}

/** Wires the real pieces together. Nothing connects until start(). */
export function createSlackService(opts: CreateSlackServiceOptions): ComposedSlackService {
  const bot = new SlackBot({ getTokens: opts.getBotTokens, makeApi: opts.makeBotApi });
  const socket = new SlackSocket({
    ...opts.socketOptions,
    getTokens: opts.getBotTokens,
    getIdentity: () => bot.identity(),
    configure: app => registerInteractivity(app, { resolve: opts.resolve, bot, botIdentity: () => bot.identity(), getApproval: opts.getApproval, getReview: opts.getReview }),
  });
  // SlackWebClient needs the bot's user id up front (Channel.botIsMember), so it is built on first use, once the bot token has answered.
  // While the bot token cannot answer, one client without a bot id is reused (so its caches survive); it is replaced once, when the id is known.
  let built: UserSlack | undefined;
  let withoutBot: UserSlack | undefined;
  const build = async (): Promise<UserSlack> => {
    if (built) return built;
    let botUserId: string | undefined;
    try { botUserId = (await bot.identity()).userId; } catch { /* no bot token yet: botIsMember reads false */ }
    const onTokenRejected = opts.onUserTokenRejected;
    if (!botUserId) return (withoutBot ??= new SlackWebClient({ getToken: opts.getUserToken, onTokenRejected, ...opts.webOptions }));
    return (built = new SlackWebClient({ getToken: opts.getUserToken, botUserId, onTokenRejected, ...opts.webOptions }));
  };
  const web: UserSlack = {
    postAsUser: async o => (await build()).postAsUser(o),
    channels: async () => (await build()).channels(),
    history: async (c, cur, l) => (await build()).history(c, cur, l),
    getThread: async (c, t) => (await build()).getThread(c, t),
    users: async ids => (await build()).users(ids),
    status: async () => (await build()).status(),
  };
  return new ComposedSlackService({ web, bot, socket });
}
