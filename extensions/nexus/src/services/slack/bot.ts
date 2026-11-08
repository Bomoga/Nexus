// Bot-token posts and in-place edits (L2-03). Everything the agent says goes out here, as the Nexus bot, never with the user token.
import { WebClient } from "@slack/web-api";
import type { ChatMessage } from "../../contracts";
import type { BotPostOptions } from "./types";
import { toDisplayText } from "./mrkdwn";
import { extractCodeRefs, safeError, webClientOptions, type SlackMsg } from "./web-client";

/** Both Slack tokens the live path needs. Supplied on demand by the host (SecretStorage or env); never logged, never returned. */
export interface BotTokens { botToken: string; appToken: string }
export type BotTokenProvider = () => Promise<BotTokens | null>;

/** The slice of @slack/web-api's WebClient the bot calls; tests inject a fake. */
export interface BotApi {
  auth: { test(): Promise<{ user_id?: string; user?: string; bot_id?: string; team_id?: string }> };
  chat: {
    postMessage(a: { channel: string; text: string; thread_ts?: string; blocks?: unknown[] }): Promise<{ ts?: string; message?: SlackMsg }>;
    update(a: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<{ ts?: string; message?: SlackMsg }>;
  };
}

export interface BotOptions {
  getTokens: BotTokenProvider;
  /** Test seam; defaults to a real WebClient built with webClientOptions("post"): no automatic retry. */
  makeApi?: (botToken: string) => BotApi;
}

/** The bot's own identity from auth.test: its user id, bot id and workspace (team) id. */
export interface BotIdentity { userId: string; name: string; botId?: string; teamId?: string }

export class SlackBot {
  private api: BotApi | undefined;
  private apiToken: string | undefined;
  private me: BotIdentity | undefined;

  constructor(private readonly opts: BotOptions) {}

  /** The bot's own user id and name (auth.test), cached per token. */
  async identity(): Promise<BotIdentity> {
    const api = await this.requireApi();
    if (this.me) return this.me;
    let r;
    try { r = await api.auth.test(); } catch (e) { throw safeError(e, "auth.test"); }
    if (!r.user_id) throw new Error("slack auth.test returned no bot user");
    const me: BotIdentity = { userId: r.user_id, name: r.user ?? r.user_id, ...(r.bot_id ? { botId: r.bot_id } : {}), ...(r.team_id ? { teamId: r.team_id } : {}) };
    if (this.api === api) this.me = me;
    return me;
  }

  async postAsBot(opts: BotPostOptions): Promise<ChatMessage> {
    if (!opts.text.trim() && opts.blocks === undefined) throw new Error("empty message");
    const blocks = opts.blocks !== undefined ? asBlocks(opts.blocks) : undefined;
    const api = await this.requireApi();
    const me = await this.identity();
    let r;
    try {
      r = await api.chat.postMessage({
        channel: opts.channelId, text: opts.text,
        ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
        ...(blocks ? { blocks } : {}),
      });
    } catch (e) { throw safeError(e, "chat.postMessage"); }   // posts are never retried: a duplicate agent message is worse than a visible failure
    const ts = r.ts ?? r.message?.ts;
    if (!ts) throw new Error("slack chat.postMessage returned no ts");
    return this.toMessage(me, opts.channelId, ts, r.message?.text ?? opts.text, opts.threadTs, opts.blocks, opts.clientId);
  }

  /** Edits a message the bot posted. With no blocks, any previous blocks are cleared so the plain text is what shows. */
  async updateBotMessage(channelId: string, ts: string, text: string, blocks?: unknown): Promise<ChatMessage> {
    if (!text.trim() && blocks === undefined) throw new Error("empty message");
    const checked = blocks !== undefined ? asBlocks(blocks) : [];
    const api = await this.requireApi();
    const me = await this.identity();
    let r;
    try { r = await api.chat.update({ channel: channelId, ts, text, blocks: checked }); }
    catch (e) { throw safeError(e, "chat.update"); }
    return this.toMessage(me, channelId, r.ts ?? ts, r.message?.text ?? text, r.message?.thread_ts, blocks);
  }

  private toMessage(me: BotIdentity, channelId: string, ts: string, text: string, threadTs: string | undefined, blocks: unknown, clientId?: string): ChatMessage {
    return {
      id: `${channelId}:${ts}`, channelId, ts,
      ...(threadTs && threadTs !== ts ? { threadTs } : {}),
      author: { id: me.userId, name: me.name, isBot: true },
      text: toDisplayText(text), codeRefs: extractCodeRefs(text), sentVia: "bot",
      ...(blocks !== undefined ? { blocks } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
    };
  }

  private async requireApi(): Promise<BotApi> {
    let t;
    try { t = await this.opts.getTokens(); } catch { t = null; }   // the provider's message is never forwarded
    if (!t) { this.api = undefined; this.apiToken = undefined; this.me = undefined; throw new Error("no slack bot token"); }
    if (!this.api || this.apiToken !== t.botToken) {
      this.apiToken = t.botToken;
      this.me = undefined;
      this.api = (this.opts.makeApi ?? ((token: string) => new WebClient(token, webClientOptions("post")) as unknown as BotApi))(t.botToken);
    }
    return this.api;
  }
}

function asBlocks(blocks: unknown): unknown[] {
  if (!Array.isArray(blocks)) throw new Error("blocks must be an array");
  return blocks;
}
