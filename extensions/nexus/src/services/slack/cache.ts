// SlackCache (L2-04): a local copy of Slack history so slack.history answers from disk first and only fetches the gap.
// One JSONL file per channel under an injected directory: `<dir>/<channelId>.jsonl`. Each line is a ChatMessage (a later line for the
// same ts replaces the earlier one) or a tombstone `{"deleted":"<ts>"}`. An in-memory index by ts is loaded lazily per channel.
// Message text is UNTRUSTED (section 14): stored as is, never executed. No vscode import, no network, never polls.
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ChatMessage as ChatMessageSchema } from "../../contracts";
import type { ChatMessage } from "../../contracts";
import type { BotPostOptions, Disposable, HistoryPage, PostOptions, SlackMessageEvent, SlackService } from "./types";

/** Slack ids are alphanumeric (fixtures use underscores). Anything else could name a path outside the directory. */
const CHANNEL_ID = /^[A-Za-z0-9_]{1,64}$/;
const CURSOR_PREFIX = "c:";
const TOMBSTONE = z.object({ deleted: z.string().regex(/^\d+\.\d+$/) }).strict();

const DEFAULT_MAX_MESSAGES = 5000;
const DEFAULT_PAGE = 50;
/** Bounds on how far one call may chase Slack's pages. */
const MAX_GAP_PAGES = 10;
const MAX_WALK_PAGES = 20;
/** A local echo older than this is dropped: a lost send result must not leave it forever. */
const ECHO_TTL_MS = 2 * 60_000;
/** A live event matching an echo's text counts as its confirmation only within this window. */
const ECHO_MATCH_MS = 30_000;

/** Compares Slack ts strings exactly ("seconds.micros") without float rounding. */
export function compareTs(a: string, b: string): number {
  const [as = "0", af = ""] = a.split(".");
  const [bs = "0", bf = ""] = b.split(".");
  if (as.length !== bs.length) return as.length - bs.length;
  if (as !== bs) return as < bs ? -1 : 1;
  const w = Math.max(af.length, bf.length);
  const x = af.padEnd(w, "0"), y = bf.padEnd(w, "0");
  return x === y ? 0 : x < y ? -1 : 1;
}

export interface SlackCacheOptions {
  /** Where the per-channel files live; created if missing. */
  dir: string;
  /** The SlackService whose history fills gaps (and, in wrap(), the one being fronted). */
  fetcher: Pick<SlackService, "history">;
  /** Newest messages kept per channel. Default 5000. */
  maxMessages?: number;
  /** Scroll-back held in memory past the cap, across ALL channels; the least recently paged channel's is dropped first. Default maxMessages. */
  maxCarryTotal?: number;
  /** Test seams. */
  now?: () => number;
  rename?: (from: string, to: string) => void;
  appendFile?: (file: string, data: string) => void;
}

export interface CacheStats { skippedLines: number }

/** What a background refresh tells onFill listeners: a message that was not cached, or a cached one whose content changed. */
export interface FillEvent { type: "message" | "message_changed"; message: ChatMessage }

interface UpstreamState { nextCursor: string | undefined; done: boolean }

interface ChannelState {
  byTs: Map<string, ChatMessage>;
  lineCount: number;
  upstream?: UpstreamState;
  /** Older messages fetched from Slack while the cache was full: served, never stored (compaction would evict them at once). */
  carry: Map<string, ChatMessage>;
}

interface Echo { msg: ChatMessage; at: number }

const isTop = (m: ChatMessage) => !m.threadTs || m.threadTs === m.ts;

export class SlackCache {
  private readonly dir: string;
  private readonly fetcher: Pick<SlackService, "history">;
  private readonly maxMessages: number;
  private readonly maxCarryTotal: number;
  /** Channels with scroll-back in memory, least recently paged first. */
  private readonly carryOrder = new Map<string, true>();
  private readonly slack: number;
  private readonly now: () => number;
  private readonly rename: (from: string, to: string) => void;
  private readonly appendFile: (file: string, data: string) => void;
  private readonly channels = new Map<string, ChannelState>();
  /** Local echoes of sends not yet confirmed. Memory only: a crash must not leave a ghost message on disk. */
  private readonly pending = new Map<string, Echo[]>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly fillListeners = new Set<(evt: FillEvent) => void>();
  private skipped = 0;

  constructor(opts: SlackCacheOptions) {
    this.dir = opts.dir;
    this.fetcher = opts.fetcher;
    this.maxMessages = Math.max(1, opts.maxMessages ?? DEFAULT_MAX_MESSAGES);
    this.maxCarryTotal = Math.max(1, opts.maxCarryTotal ?? this.maxMessages);
    this.slack = Math.max(1, Math.floor(this.maxMessages / 10));
    this.now = opts.now ?? Date.now;
    this.rename = opts.rename ?? fs.renameSync;
    this.appendFile = opts.appendFile ?? fs.appendFileSync;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  stats(): CacheStats { return { skippedLines: this.skipped }; }

  /** Resolves when every background gap refresh started so far has finished (tests and shutdown). */
  async idle(): Promise<void> { while (this.refreshing.size > 0) await Promise.allSettled([...this.refreshing.values()]); }

  /** Called for each message a background refresh adds or changes, so a view can show it without polling. */
  onFill(listener: (evt: FillEvent) => void): Disposable {
    this.fillListeners.add(listener);
    return { dispose: () => { this.fillListeners.delete(listener); } };
  }

  /**
   * Newest first. No cursor: the newest cached page now (fromCache true) and a background refresh of the gap newer than the latest
   * cached ts; if nothing is cached yet, Slack is asked and awaited. A cursor (this cache's own `c:<ts>`, meaning "older than ts")
   * pages through the cache and asks Slack only past the cached range. Pages fetched while the cache is full are served, not stored.
   */
  async history(channelId: string, cursor?: string, limit = DEFAULT_PAGE): Promise<HistoryPage> {
    const state = this.load(channelId);
    const boundary = parseCursor(cursor);
    const size = Math.max(1, limit);

    if (boundary === undefined) {
      if (!this.hasTop(state)) {
        await this.refresh(channelId, size, new Set(), false);
        return this.newestPage(channelId, state, size, false);
      }
      const page = this.newestPage(channelId, state, size, true);
      void this.startRefresh(channelId, size, new Set(page.messages.map(m => m.ts)));
      return page;
    }

    const pool = new Map<string, ChatMessage>();
    const consider = (m: ChatMessage) => { if (isTop(m) && compareTs(m.ts, boundary) < 0) pool.set(m.ts, m); };
    for (const m of state.byTs.values()) consider(m);
    for (const m of state.carry.values()) consider(m);

    let fromCache = true;
    let guard = 0;
    while (pool.size < size && !state.upstream?.done && guard++ < MAX_WALK_PAGES) {
      fromCache = false;
      const res = await this.fetchNext(channelId, state, size);
      const room = this.maxMessages - state.byTs.size;
      const fresh = res.filter(m => !state.byTs.has(m.ts)).length;
      const { leftover } = this.applyBatch(channelId, res, fresh <= room);
      for (const m of res) consider(m);
      for (const m of leftover) if (isTop(m)) state.carry.set(m.ts, m);
    }
    this.trimCarry(channelId, state);

    const sorted = [...pool.values()].sort((a, b) => compareTs(b.ts, a.ts));
    const messages = sorted.slice(0, size);
    const more = sorted.length > size || !state.upstream?.done;
    const last = messages[messages.length - 1];
    const nextCursor = more ? (last ? CURSOR_PREFIX + last.ts : cursor) : undefined;
    return { messages: structuredClone(messages), nextCursor, fromCache };
  }

  /** Stores a message from any source (live event, send confirmation, gap fill). Idempotent by ts. */
  ingest(message: ChatMessage): void {
    const parsed = ChatMessageSchema.safeParse(message);
    if (!parsed.success || !CHANNEL_ID.test(message.channelId)) return;
    const msg = parsed.data;
    if (msg.pending) {
      const list = this.freshEchoes(msg.channelId);
      const i = msg.clientId === undefined ? -1 : list.findIndex(p => p.msg.clientId === msg.clientId);
      if (i >= 0) list[i] = { msg, at: this.now() }; else list.push({ msg, at: this.now() });
      this.pending.set(msg.channelId, list);
      return;
    }
    this.confirmEcho(msg);
    this.applyBatch(msg.channelId, [msg], true);
  }

  /** Removes a message (a deletion). */
  remove(channelId: string, ts: string): void {
    const state = this.load(channelId);
    if (!state.byTs.delete(ts)) return;
    this.append(channelId, state, [JSON.stringify({ deleted: ts })]);
  }

  /** Drops a local echo whose send failed. */
  dropPending(channelId: string, clientId: string): void {
    const rest = (this.pending.get(channelId) ?? []).filter(p => p.msg.clientId !== clientId);
    if (rest.length) this.pending.set(channelId, rest); else this.pending.delete(channelId);
  }

  /** Returns a SlackService whose history, onMessage and posts go through this cache. Types are unchanged. */
  wrap(service: SlackService): SlackService {
    return wrapService(this, service);
  }

  // ---- internals ----

  /** Echoes younger than the TTL; the stale ones are dropped. */
  private freshEchoes(channelId: string): Echo[] {
    const cutoff = this.now() - ECHO_TTL_MS;
    const list = (this.pending.get(channelId) ?? []).filter(e => e.at > cutoff);
    if (list.length) this.pending.set(channelId, list); else this.pending.delete(channelId);
    return list;
  }

  /** A confirmed message retires its echo: by clientId, else the oldest recent echo with the same text (a live event can beat the send result). */
  private confirmEcho(msg: ChatMessage): void {
    const list = this.freshEchoes(msg.channelId);
    if (list.length === 0) return;
    let i = msg.clientId === undefined ? -1 : list.findIndex(e => e.msg.clientId === msg.clientId);
    if (i < 0 && msg.sentVia === "user" && !msg.author.isBot) {
      const t = this.now();
      // Only the sender's own message can retire an echo: an echo with no known author is retired only by its clientId.
      i = list.findIndex(e => t - e.at <= ECHO_MATCH_MS && e.msg.text === msg.text && e.msg.threadTs === msg.threadTs
        && e.msg.author.id !== "" && e.msg.author.id === msg.author.id);
    }
    if (i >= 0) { list.splice(i, 1); if (list.length === 0) this.pending.delete(msg.channelId); }
  }

  private file(channelId: string): string {
    if (!CHANNEL_ID.test(channelId)) throw new Error("invalid channel id");
    const full = path.join(this.dir, `${channelId}.jsonl`);
    return full;
  }

  private load(channelId: string): ChannelState {
    const known = this.channels.get(channelId);
    if (known) return known;
    const file = this.file(channelId);
    const state: ChannelState = { byTs: new Map(), lineCount: 0, carry: new Map() };
    let dirty = false;
    let raw = "";
    try { raw = fs.readFileSync(file, "utf8"); } catch { /* no file yet */ }
    if (raw.length > 0) {
      if (!raw.endsWith("\n")) dirty = true;   // torn last line: appending would glue onto it, so rewrite clean below
      for (const line of raw.split("\n")) {
        if (line.trim() === "") continue;
        state.lineCount++;
        let value: unknown;
        try { value = JSON.parse(line); } catch { this.skipped++; dirty = true; continue; }
        const tomb = TOMBSTONE.safeParse(value);
        if (tomb.success) { state.byTs.delete(tomb.data.deleted); continue; }
        const msg = ChatMessageSchema.safeParse(value);
        if (!msg.success || msg.data.channelId !== channelId) { this.skipped++; dirty = true; continue; }
        state.byTs.set(msg.data.ts, toStored(msg.data));
      }
      if (state.byTs.size > this.maxMessages || state.lineCount > state.byTs.size * 2 + 16) dirty = true;
    }
    this.channels.set(channelId, state);
    if (dirty) this.compact(channelId, state);
    return state;
  }

  /**
   * Validates a batch and writes it with ONE append. A cached message whose content changed is replaced; unknown ones are stored only
   * when storeNew. Returns what was added, what changed, and the unknown ones left unstored.
   */
  private applyBatch(channelId: string, batch: ChatMessage[], storeNew: boolean) {
    const state = this.load(channelId);
    const added: ChatMessage[] = [], changed: ChatMessage[] = [], leftover: ChatMessage[] = [];
    const lines: string[] = [];
    for (const raw of batch) {
      const parsed = ChatMessageSchema.safeParse(raw);
      if (!parsed.success || parsed.data.channelId !== channelId || parsed.data.pending) continue;
      const msg = toStored(parsed.data);
      const had = state.byTs.get(msg.ts);
      if (had && isDeepStrictEqual(had, msg)) continue;
      if (!had && !storeNew) { leftover.push(msg); continue; }
      state.byTs.set(msg.ts, msg);
      lines.push(JSON.stringify(msg));
      (had ? changed : added).push(msg);
    }
    if (lines.length) this.append(channelId, state, lines);
    return { added, changed, leftover };
  }

  private append(channelId: string, state: ChannelState, lines: string[]): void {
    this.appendFile(this.file(channelId), lines.join("\n") + "\n");
    state.lineCount += lines.length;
    if (state.byTs.size > this.maxMessages + this.slack || state.lineCount > this.maxMessages * 2 + 16) {
      try { this.compact(channelId, state); } catch { /* best effort: the old file is intact, the next append retries */ }
    }
  }

  /** Keeps the newest maxMessages and replaces the file atomically (temp file, then rename). A failure leaves the old file untouched. */
  private compact(channelId: string, state: ChannelState): void {
    const keep = [...state.byTs.values()].sort((a, b) => compareTs(a.ts, b.ts)).slice(-this.maxMessages);
    const file = this.file(channelId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, keep.map(m => JSON.stringify(m) + "\n").join(""));
    this.rename(tmp, file);
    state.byTs = new Map(keep.map(m => [m.ts, m]));
    state.lineCount = keep.length;
  }

  private hasTop(state: ChannelState): boolean {
    for (const m of state.byTs.values()) if (isTop(m)) return true;
    return false;
  }

  private newestPage(channelId: string, state: ChannelState, limit: number, fromCache: boolean): HistoryPage {
    const top = [...state.byTs.values()].filter(isTop).sort((a, b) => compareTs(b.ts, a.ts));
    const messages = top.slice(0, limit);
    const echoes = this.freshEchoes(channelId).map(e => e.msg).filter(m => !m.threadTs).sort((a, b) => compareTs(b.ts, a.ts));
    messages.unshift(...echoes);
    const more = top.length > limit || !state.upstream?.done;
    const last = top[Math.min(limit, top.length) - 1];
    const nextCursor = more && last ? CURSOR_PREFIX + last.ts : undefined;
    return { messages: structuredClone(messages), nextCursor, fromCache };
  }

  /** The carry is memory-only scroll-back. If it outgrows the cap, drop the newest (already shown); Slack's position is kept so paging never re-walks. */
  private trimCarry(channelId: string, state: ChannelState): void {
    if (state.carry.size > this.maxMessages) {
      const keep = [...state.carry.values()].sort((a, b) => compareTs(b.ts, a.ts)).slice(-this.maxMessages);
      state.carry = new Map(keep.map(m => [m.ts, m]));
      // Known limit: the dropped middle is not refetched on a later walk of the same channel (SlackService.history has no
      // "older than" parameter to resume from). The first walk is complete; only re-paging past the cap twice skips it.
    }
    // Across channels: this channel becomes the most recently paged; drop whole carries from the least recent until under the total.
    this.carryOrder.delete(channelId);
    if (state.carry.size > 0) this.carryOrder.set(channelId, true);
    let total = 0;
    for (const id of this.carryOrder.keys()) total += this.channels.get(id)?.carry.size ?? 0;
    for (const id of this.carryOrder.keys()) {
      if (total <= this.maxCarryTotal) break;
      if (id === channelId) continue;
      const other = this.channels.get(id);
      if (!other) { this.carryOrder.delete(id); continue; }
      total -= other.carry.size;
      other.carry = new Map();
      other.upstream = undefined;   // its Slack position belonged to the dropped scroll-back: paging there starts over
      this.carryOrder.delete(id);
    }
  }

  /** Total scroll-back held in memory across channels (tests and diagnostics). */
  carrySize(): number {
    let total = 0;
    for (const s of this.channels.values()) total += s.carry.size;
    return total;
  }

  private startRefresh(channelId: string, limit: number, served: Set<string>): Promise<void> {
    const running = this.refreshing.get(channelId);
    if (running) return running;
    const p = this.refresh(channelId, limit, served).catch(() => undefined).finally(() => { this.refreshing.delete(channelId); });
    this.refreshing.set(channelId, p);
    return p;
  }

  /**
   * Fetches Slack's newest pages until one reaches the latest cached ts (or the page cap). Each page is stored with one append.
   * Listeners hear about messages that were new or changed, except those already in the page the caller received.
   */
  private async refresh(channelId: string, limit: number, served: Set<string>, announceAdded = true): Promise<void> {
    const state = this.load(channelId);
    let latest: string | undefined;
    for (const m of state.byTs.values()) if (isTop(m) && (latest === undefined || compareTs(m.ts, latest) > 0)) latest = m.ts;
    let cursor: string | undefined;
    let reachedEnd = false;
    for (let i = 0; i < MAX_GAP_PAGES; i++) {
      const res = await this.fetcher.history(channelId, cursor, limit);
      const { added, changed } = this.applyBatch(channelId, res.messages, true);
      this.notify(added.filter(m => announceAdded && !served.has(m.ts)).map(message => ({ type: "message" as const, message })));
      this.notify(changed.map(message => ({ type: "message_changed" as const, message })));
      cursor = res.nextCursor;
      if (!cursor) { reachedEnd = true; break; }
      let oldest: string | undefined;
      for (const m of res.messages) if (oldest === undefined || compareTs(m.ts, oldest) < 0) oldest = m.ts;
      if (latest === undefined || oldest === undefined || compareTs(oldest, latest) <= 0) break;
    }
    state.upstream ??= { nextCursor: cursor, done: reachedEnd };
    if (reachedEnd) state.upstream = { nextCursor: undefined, done: true };
  }

  private notify(events: FillEvent[]): void {
    for (const evt of events) for (const l of this.fillListeners) { try { l(evt); } catch { /* isolate the listener */ } }
  }

  /** One page of Slack's own cursor chain, from where this session left off (the newest page if none). Returns its messages. */
  private async fetchNext(channelId: string, state: ChannelState, limit: number): Promise<ChatMessage[]> {
    const up = state.upstream ?? { nextCursor: undefined, done: false };
    const res = await this.fetcher.history(channelId, up.nextCursor, limit);
    state.upstream = { nextCursor: res.nextCursor, done: !res.nextCursor || res.nextCursor === up.nextCursor };
    const valid: ChatMessage[] = [];
    for (const m of res.messages) {
      const parsed = ChatMessageSchema.safeParse(m);
      if (parsed.success && parsed.data.channelId === channelId && !parsed.data.pending) valid.push(toStored(parsed.data));
    }
    return valid;
  }
}

/** Drops fields that only mean something to the sender's UI. */
function toStored(msg: ChatMessage): ChatMessage {
  const stored = { ...msg };
  delete stored.clientId;
  delete stored.failed;
  delete stored.pending;
  return stored;
}

function parseCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  const ts = cursor.startsWith(CURSOR_PREFIX) ? cursor.slice(CURSOR_PREFIX.length) : "";
  if (!/^\d+\.\d+$/.test(ts)) throw new Error("invalid history cursor");
  return ts;
}

function wrapService(cache: SlackCache, service: SlackService): SlackService {
  type Entry = { fn: (evt: SlackMessageEvent) => void; channelIds?: string[] };
  const listeners = new Set<Entry>();
  let upstream: Disposable | undefined;
  let fill: Disposable | undefined;

  const fanOut = (evt: SlackMessageEvent) => {
    for (const l of [...listeners]) {
      if (evt.type !== "status" && l.channelIds && !l.channelIds.includes(evt.message.channelId)) continue;
      try { l.fn(evt); } catch { /* isolate the listener */ }
    }
  };
  const subscribe = () => {
    upstream = service.onMessage(evt => {
      if (evt.type !== "status") cache.ingest(evt.message);
      fanOut(evt);
    });
    fill = cache.onFill(evt => fanOut(evt));
  };
  const unsubscribe = () => { upstream?.dispose(); fill?.dispose(); upstream = fill = undefined; };

  const confirmed = (m: ChatMessage): ChatMessage => { cache.ingest(m); return m; };

  return {
    postAsUser: async (opts: PostOptions) => {
      let me: { userId: string; name: string } | null = null;
      try { me = (await service.status()).postsAs; } catch { /* unknown sender: the echo is retired only by its clientId */ }
      const echo = opts.clientId === undefined ? undefined : localEcho(opts, me);
      if (echo) cache.ingest(echo);
      try { return confirmed(await service.postAsUser(opts)); }
      catch (e) { if (opts.clientId !== undefined) cache.dropPending(opts.channelId, opts.clientId); throw e; }
    },
    postAsBot: async (opts: BotPostOptions) => confirmed(await service.postAsBot(opts)),
    updateBotMessage: async (channelId, ts, text, blocks) => confirmed(await service.updateBotMessage(channelId, ts, text, blocks)),
    channels: () => service.channels(),
    history: (channelId, cursor, limit) => cache.history(channelId, cursor, limit),
    getThread: (channelId, threadTs) => service.getThread(channelId, threadTs),
    users: ids => service.users(ids),
    status: () => service.status(),
    onMessage: (listener, channelIds) => {
      const entry: Entry = { fn: listener, channelIds };
      listeners.add(entry);
      if (listeners.size === 1) subscribe();
      return { dispose: () => { if (listeners.delete(entry) && listeners.size === 0) unsubscribe(); } };
    },
  };
}

/** The unconfirmed copy of a send: memory only, replaced by the confirmed message carrying the same clientId. */
function localEcho(opts: PostOptions, me: { userId: string; name: string } | null): ChatMessage {
  const ts = (Date.now() / 1000).toFixed(6);
  return {
    id: `${opts.channelId}:${ts}`, channelId: opts.channelId, ts, ...(opts.threadTs ? { threadTs: opts.threadTs } : {}),
    author: { id: me?.userId ?? "", name: me?.name ?? "", isBot: false }, text: opts.text, codeRefs: [], sentVia: "user", pending: true, clientId: opts.clientId,
  };
}
