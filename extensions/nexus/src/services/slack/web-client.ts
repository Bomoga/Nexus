// Slack reads and posting as the user (L2-02). Uses the person's own xoxp token only; nothing the agent says goes through here.
// Bot posts, in-place bot edits and live events belong to L2-03, which composes this class (it implements UserSlack, a subset of SlackService).
import { WebClient } from "@slack/web-api";
import { decodeCodeRef, type Channel, type ChatMessage, type CodeRef, type SlackStatus, type SlackUser, type Thread } from "../../contracts";
import type { HistoryPage, PostOptions, SlackService } from "./types";

export type UserSlack = Pick<SlackService, "postAsUser" | "channels" | "history" | "getThread" | "users"> & {
  status(): Promise<Pick<SlackStatus, "postsAs" | "userTokenSource">>;
};

/** Where the token came from; reported by slack.status. */
export type UserTokenSource = SlackStatus["userTokenSource"];

/** Supplies the user token on demand. Never logged, never returned. */
export type TokenProvider = () => Promise<{ token: string; source: UserTokenSource } | null>;

// Loose shapes for the parts of Slack payloads we read.
interface SlackMsg { blocks?: unknown; ts?: string; thread_ts?: string; user?: string; bot_id?: string; username?: string; bot_profile?: { name?: string }; text?: string; reply_count?: number; subtype?: string }
interface SlackChannel { id?: string; name?: string; is_private?: boolean; is_member?: boolean; is_archived?: boolean; unread_count_display?: number }
interface SlackUserInfo { id?: string; name?: string; real_name?: string; is_bot?: boolean; profile?: { display_name?: string; real_name?: string; image_72?: string } }
interface Paged { response_metadata?: { next_cursor?: string } }

/** The slice of @slack/web-api's WebClient we call; tests inject a fake. */
export interface SlackApi {
  auth: { test(): Promise<{ user_id?: string; user?: string; bot_id?: string }> };
  conversations: {
    list(a: { types: string; exclude_archived: boolean; limit: number; cursor?: string }): Promise<Paged & { channels?: SlackChannel[] }>;
    members(a: { channel: string; limit: number; cursor?: string }): Promise<Paged & { members?: string[] }>;
    history(a: { channel: string; limit: number; cursor?: string }): Promise<Paged & { messages?: SlackMsg[] }>;
    replies(a: { channel: string; ts: string; limit: number; cursor?: string }): Promise<Paged & { messages?: SlackMsg[] }>;
  };
  users: { info(a: { user: string }): Promise<{ user?: SlackUserInfo }> };
  chat: { postMessage(a: { channel: string; text: string; thread_ts?: string }): Promise<{ ts?: string; message?: SlackMsg }> };
}

export interface WebClientOptions {
  getToken: TokenProvider;
  /** The Nexus bot's user id; needed to compute Channel.botIsMember. Without it botIsMember is false. */
  botUserId?: string;
  /** Test seam; defaults to the real @slack/web-api WebClient built with webClientOptions(kind). */
  makeApi?: (token: string, kind: ApiKind) => SlackApi;
  /** How long bot-membership answers and failed user lookups are reused. */
  botMembershipTtlMs?: number;
  now?: () => number;
}

export type ApiKind = "read" | "post";

const MAX_PAGES = 50;
const CONCURRENCY = 4;

/**
 * Options for the real WebClient. Reads: bounded timeout, a short retry policy, rate limits surface as errors.
 * Posts: no automatic retry, because a late or duplicate send as the person is worse than a visible failure.
 */
export function webClientOptions(kind: ApiKind): WebClientOptions_ {
  return kind === "read"
    ? { timeout: 15_000, retryConfig: { retries: 2, factor: 2, minTimeout: 500, maxTimeout: 4_000, randomize: true }, rejectRateLimitedCalls: true }
    : { timeout: 15_000, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true };
}
type WebClientOptions_ = ConstructorParameters<typeof WebClient>[1];

const MAX_LINK = 2048;
// Both link spellings: nexus://coderef/... and nexus://nexus.nexus/coderef/... (the extension-id authority).
// Slack-wrapped links, <link|label> or <link>: exactly up to "|" or ">", never trimmed. "<" is excluded so scanning stays linear.
const WRAPPED_LINK = /<(nexus:\/\/(?:nexus\.nexus\/)?coderef\/[^|<>\s]+)[|>]/g;
// Bare links: only encodeURIComponent's output alphabet plus "/" and "%", so quotes, brackets, "&gt;" and "…" end the link.
const BARE_LINK = /(?<!<)nexus:\/\/(?:nexus\.nexus\/)?coderef\/[A-Za-z0-9\-_.!~*'()%/]+/g;

/** Trims sentence punctuation and an unbalanced closing ")" off a bare link in one linear pass. */
function trimBare(link: string): string {
  let opens = 0, closes = 0;
  for (const ch of link) { if (ch === "(") opens++; else if (ch === ")") closes++; }
  let end = link.length;
  while (end > 0) {
    const ch = link[end - 1];
    if (ch === ")" && closes > opens) { closes--; end--; }
    else if (".!~*'".includes(ch)) end--;
    else break;
  }
  return link.slice(0, end);
}

/** Extracts every valid nexus://coderef link in the text. Never throws: the text is untrusted. Text itself is never altered. */
export function extractCodeRefs(text: string): CodeRef[] {
  const candidates: { at: number; link: string }[] = [];
  for (const m of text.matchAll(WRAPPED_LINK)) candidates.push({ at: m.index, link: m[1] });
  for (const m of text.matchAll(BARE_LINK)) candidates.push({ at: m.index, link: trimBare(m[0]) });
  candidates.sort((a, b) => a.at - b.at);
  const refs: CodeRef[] = [];
  for (const { link } of candidates) {
    if (link.length > MAX_LINK) continue;
    try {
      const ref = decodeCodeRef(link.replace(/^nexus:\/\/nexus\.nexus\//, "nexus://"));   // one form for either contract version
      if (ref) refs.push(ref);
    } catch { /* malformed percent escape */ }
  }
  return refs;
}

/** Runs fn over items with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Follows next_cursor until it is empty, repeats, or MAX_PAGES is reached. Page-capped results are partial. */
async function paginate<R extends Paged>(fetchPage: (cursor?: string) => Promise<R>, onPage: (r: R) => boolean | void): Promise<void> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await fetchPage(cursor);
    if (onPage(r) === true) return;
    cursor = r.response_metadata?.next_cursor || undefined;
    if (!cursor || seen.has(cursor)) return;
    seen.add(cursor);
  }
}

function safeError(e: unknown, what: string): Error {
  // Only a short Slack error code, a rate-limit hint or "timeout" is forwarded; never the original message, which could echo headers.
  const err = e as { code?: unknown; data?: { error?: unknown }; retryAfter?: unknown; original?: { name?: unknown; code?: unknown } } | null;
  const parts: string[] = [];
  if (typeof err?.data?.error === "string" && /^[a-z0-9_]+$/.test(err.data.error)) parts.push(err.data.error);
  else if (err?.code === "slack_webapi_rate_limited_error") parts.push(typeof err.retryAfter === "number" ? `rate_limited (retry after ${err.retryAfter}s)` : "rate_limited");
  else if (/timeout|timedout|abort/i.test(String(err?.original?.name ?? "") + String(err?.original?.code ?? "") + String(err?.code ?? ""))) parts.push("timeout");
  else if (typeof err?.code === "string" && /^slack_webapi_[a-z_]+$/.test(err.code)) parts.push(err.code);
  return new Error(`slack ${what} failed${parts.length ? `: ${parts[0]}` : ""}`);
}

export class SlackWebClient implements UserSlack {
  private reader: SlackApi | undefined;
  private poster: SlackApi | undefined;
  private apiToken: string | undefined;
  private readonly failedUsers = new Map<string, number>();
  private source: UserTokenSource = "none";
  private self: { userId: string; name: string } | null | undefined;
  private readonly userCache = new Map<string, SlackUser>();
  private readonly botMembers = new Map<string, { at: number; value: boolean }>();
  private readonly now: () => number;

  constructor(private readonly opts: WebClientOptions) { this.now = opts.now ?? Date.now; }

  async status(): Promise<Pick<SlackStatus, "postsAs" | "userTokenSource">> {
    const api = await this.tryApi();
    if (!api) return { postsAs: null, userTokenSource: "none" };
    const source = this.source;
    try { return { postsAs: await this.identity(api.reader), userTokenSource: source }; }
    catch { return { postsAs: null, userTokenSource: this.source }; }
  }

  async channels(): Promise<Channel[]> {
    const api = (await this.requireApi()).reader;
    const raw: SlackChannel[] = [];
    try {
      await paginate(cursor => api.conversations.list({ types: "public_channel,private_channel", exclude_archived: true, limit: 200, cursor }),
        r => { raw.push(...(r.channels ?? [])); });
    } catch (e) { throw safeError(e, "conversations.list"); }
    const member = raw.filter(c => c.id && c.is_member);
    return mapLimit(member, CONCURRENCY, async c => ({
      id: c.id as string, name: c.name ?? c.id as string, isPrivate: !!c.is_private, isMember: true,
      botIsMember: await this.botIsMember(api, c.id as string),
      ...(c.unread_count_display !== undefined ? { unreadCount: c.unread_count_display } : {}),
    }));
  }

  /** Newest first. One page per call (cursor from the previous page); callers cache, we never poll. */
  async history(channelId: string, cursor?: string, limit = 50): Promise<HistoryPage> {
    const api = (await this.requireApi()).reader;
    let r;
    try { r = await api.conversations.history({ channel: channelId, limit, cursor }); }
    catch (e) { throw safeError(e, "conversations.history"); }
    const messages = await this.mapMessages(api, channelId, r.messages ?? []);
    const next = r.response_metadata?.next_cursor || undefined;
    if (next === cursor) return { messages, fromCache: false };   // a cursor that repeats would loop the caller
    return { messages, ...(next ? { nextCursor: next } : {}), fromCache: false };
  }

  async getThread(channelId: string, threadTs: string): Promise<Thread> {
    const api = (await this.requireApi()).reader;
    const raw: SlackMsg[] = [];
    const seenTs = new Set<string>();
    try {
      await paginate(cursor => api.conversations.replies({ channel: channelId, ts: threadTs, limit: 200, cursor }),
        r => { for (const m of r.messages ?? []) if (m.ts && !seenTs.has(m.ts)) { seenTs.add(m.ts); raw.push(m); } });
    } catch (e) { throw safeError(e, "conversations.replies"); }
    return { channelId, threadTs, messages: await this.mapMessages(api, channelId, raw) };
  }

  /** users.info is called once per unknown id (concurrently) and cached. With no ids, returns the users seen so far. */
  async users(ids?: string[]): Promise<SlackUser[]> {
    const api = (await this.requireApi()).reader;
    if (!ids) return [...this.userCache.values()];
    await this.loadUsers(api, ids);
    return ids.flatMap(id => { const u = this.userCache.get(id); return u ? [u] : []; });
  }

  async postAsUser(opts: PostOptions): Promise<ChatMessage> {
    const { reader, poster } = await this.requireApi();
    const me = await this.identity(reader).catch(() => null);
    if (!me) throw new Error("slack user token not verified: refusing to post");
    if (!opts.text.trim()) throw new Error("empty message");
    // opts.clientId is not sent to Slack: the bridge matches the pending echo to this confirmed message with it.
    let r;
    try { r = await poster.chat.postMessage({ channel: opts.channelId, text: opts.text, ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}) }); }
    catch (e) { throw safeError(e, "chat.postMessage"); }
    const ts = r.ts ?? r.message?.ts;
    if (!ts) throw new Error("slack chat.postMessage returned no ts");
    const text = r.message?.text ?? opts.text;   // Slack's confirmed copy
    return {
      id: `${opts.channelId}:${ts}`, channelId: opts.channelId, ts,
      ...(opts.threadTs ? { threadTs: opts.threadTs } : {}),
      author: { id: me.userId, name: me.name, isBot: false },
      text, codeRefs: extractCodeRefs(text), sentVia: "user",
    };
  }

  // ---- internals ----

  private async tryApi(): Promise<{ reader: SlackApi; poster: SlackApi } | null> {
    let t;
    try { t = await this.opts.getToken(); } catch { t = null; }   // the provider's message is never forwarded
    if (!t) { this.reader = undefined; this.poster = undefined; this.apiToken = undefined; this.self = undefined; this.source = "none"; return null; }
    if (!this.reader || !this.poster || this.apiToken !== t.token) {
      const make = this.opts.makeApi ?? ((token: string, kind: ApiKind) => new WebClient(token, webClientOptions(kind)) as unknown as SlackApi);
      this.apiToken = t.token;
      this.reader = make(t.token, "read");
      this.poster = make(t.token, "post");
      this.self = undefined;
    }
    this.source = t.source;
    return { reader: this.reader, poster: this.poster };
  }

  private async requireApi(): Promise<{ reader: SlackApi; poster: SlackApi }> {
    const api = await this.tryApi();
    if (!api) throw new Error("no slack user token");
    return api;
  }

  private async identity(api: SlackApi): Promise<{ userId: string; name: string } | null> {
    if (this.self !== undefined) return this.self;
    const r = await api.auth.test();
    // a bot token must never count as "posts as the person"
    const me = r.user_id && !r.bot_id ? { userId: r.user_id, name: r.user ?? r.user_id } : null;
    if (this.reader !== api) return null;   // the token was swapped while auth.test ran: stale, discard
    this.self = me;
    return me;
  }

  /** Chosen: conversations.members (paged) looked for the bot's id, cached per channel with a TTL. */
  private async botIsMember(api: SlackApi, channelId: string): Promise<boolean> {
    const bot = this.opts.botUserId;
    if (!bot) return false;
    const hit = this.botMembers.get(channelId);
    const ttl = this.opts.botMembershipTtlMs ?? 5 * 60_000;
    if (hit && this.now() - hit.at < ttl) return hit.value;
    let value = false;
    try {
      await paginate(cursor => api.conversations.members({ channel: channelId, limit: 1000, cursor }),
        r => { value = (r.members ?? []).includes(bot); return value; });
    } catch { return hit?.value ?? false; }
    this.botMembers.set(channelId, { at: this.now(), value });
    return value;
  }

  private async loadUsers(api: SlackApi, ids: string[]): Promise<void> {
    const ttl = this.opts.botMembershipTtlMs ?? 5 * 60_000;
    const missing = [...new Set(ids)].filter(id => {
      if (this.userCache.has(id)) return false;
      const failedAt = this.failedUsers.get(id);
      return failedAt === undefined || this.now() - failedAt >= ttl;
    });
    await mapLimit(missing, CONCURRENCY, async id => {
      try {
        const u = (await api.users.info({ user: id })).user;
        if (!u) { this.failedUsers.set(id, this.now()); return; }
        const displayName = u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || id;
        this.userCache.set(id, { id, name: u.name ?? id, displayName, isBot: !!u.is_bot, ...(u.profile?.image_72 ? { avatarUrl: u.profile.image_72 } : {}) });
      } catch { this.failedUsers.set(id, this.now()); /* unknown user: fall back to the raw id */ }
    });
  }

  private async mapMessages(api: SlackApi, channelId: string, raw: SlackMsg[]): Promise<ChatMessage[]> {
    const real = raw.filter(m => m.ts && (m.user || m.bot_id) && m.subtype !== "channel_join" && m.subtype !== "channel_leave");
    await this.loadUsers(api, real.flatMap(m => (m.user ? [m.user] : [])));
    return real.map(m => {
      const ts = m.ts as string;
      // A person's own post through the Nexus app also carries bot_id/app_id/bot_profile, so trust users.info when it answered;
      // bot_id is only the fallback when the lookup failed (section 14: never show agent text as human).
      const cached = m.user ? this.userCache.get(m.user) : undefined;
      const isBot = cached ? cached.isBot : !!m.bot_id;
      const id = m.user ?? (m.bot_id as string);
      const name = (m.user && this.userCache.get(m.user)?.name) || m.username || m.bot_profile?.name || id;
      const text = m.text ?? "";   // verbatim: untrusted (§14)
      return {
        id: `${channelId}:${ts}`, channelId, ts,
        ...(m.thread_ts && m.thread_ts !== ts ? { threadTs: m.thread_ts } : {}),
        author: { id, name, isBot },
        text, codeRefs: extractCodeRefs(text),
        ...(m.reply_count ? { replyCount: m.reply_count } : {}),
        sentVia: isBot ? "bot" : "user",
        ...(isBot && m.blocks !== undefined ? { blocks: m.blocks } : {}),   // approval buttons survive a reload; humans' blocks are never mapped
      } satisfies ChatMessage;
    });
  }
}
