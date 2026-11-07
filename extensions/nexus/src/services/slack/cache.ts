// SlackCache (L2-04): a local copy of Slack history so slack.history answers from disk first and only fetches the gap.
// One JSONL file per channel under an injected directory: `<dir>/<channelId>.jsonl`. Each line is a ChatMessage (a later line for the
// same ts replaces the earlier one) or a tombstone `{"deleted":"<ts>"}`. An in-memory index by ts is loaded lazily per channel.
// Message text is UNTRUSTED (section 14): stored as is, never executed. No vscode import, no network, never polls.
import * as fs from "node:fs";
import * as path from "node:path";
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
}

export interface CacheStats { skippedLines: number }

interface UpstreamState { nextCursor: string | undefined; done: boolean }

interface ChannelState {
  byTs: Map<string, ChatMessage>;
  lineCount: number;
  upstream?: UpstreamState;
}

export class SlackCache {
  private readonly dir: string;
  private readonly fetcher: Pick<SlackService, "history">;
  private readonly maxMessages: number;
  private readonly slack: number;
  private readonly channels = new Map<string, ChannelState>();
  /** Local echoes of sends not yet confirmed. Memory only: a crash must not leave a ghost message on disk. */
  private readonly pending = new Map<string, ChatMessage[]>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly fillListeners = new Set<(msg: ChatMessage) => void>();
  private skipped = 0;

  constructor(opts: SlackCacheOptions) {
    this.dir = opts.dir;
    this.fetcher = opts.fetcher;
    this.maxMessages = Math.max(1, opts.maxMessages ?? DEFAULT_MAX_MESSAGES);
    this.slack = Math.max(1, Math.floor(this.maxMessages / 10));
    fs.mkdirSync(this.dir, { recursive: true });
  }

  stats(): CacheStats { return { skippedLines: this.skipped }; }

  /** Resolves when every background gap refresh started so far has finished (tests and shutdown). */
  async idle(): Promise<void> { while (this.refreshing.size > 0) await Promise.allSettled([...this.refreshing.values()]); }

  /** Called with each message a background refresh adds, so a view can show the gap without polling. */
  onFill(listener: (msg: ChatMessage) => void): Disposable {
    this.fillListeners.add(listener);
    return { dispose: () => { this.fillListeners.delete(listener); } };
  }

  /**
   * Newest first. No cursor: the newest cached page now (fromCache true) and a background refresh of the gap newer than the latest
   * cached ts; if nothing is cached yet, Slack is asked and awaited. A cursor (this cache's own `c:<ts>`, meaning "older than ts")
   * pages through the cache and asks Slack only past the cached range.
   */
  async history(channelId: string, cursor?: string, limit = DEFAULT_PAGE): Promise<HistoryPage> {
    const state = this.load(channelId);
    const boundary = parseCursor(cursor);
    const size = Math.max(1, limit);

    if (boundary === undefined) {
      const top = this.topLevel(state);
      if (top.length === 0) {
        await this.refresh(channelId, size);
        return this.page(channelId, undefined, size, false);
      }
      void this.startRefresh(channelId, size);
      return this.page(channelId, undefined, size, true);
    }

    let fromCache = true;
    let guard = 0;
    while (this.olderThan(state, boundary).length < size && !(state.upstream?.done) && guard++ < MAX_WALK_PAGES) {
      fromCache = false;
      await this.fetchNext(channelId, state, size);
    }
    return this.page(channelId, boundary, size, fromCache);
  }

  /** Stores a message from any source (live event, send confirmation, gap fill). Idempotent by ts. */
  ingest(message: ChatMessage): void {
    const parsed = ChatMessageSchema.safeParse(message);
    if (!parsed.success || !CHANNEL_ID.test(message.channelId)) return;
    const msg = parsed.data;
    if (msg.clientId !== undefined) this.dropPending(msg.channelId, msg.clientId);   // Slack's confirmed copy replaces the local echo
    if (msg.pending) {
      const list = this.pending.get(msg.channelId) ?? [];
      const i = msg.clientId === undefined ? -1 : list.findIndex(p => p.clientId === msg.clientId);
      if (i >= 0) list[i] = msg; else list.push(msg);
      this.pending.set(msg.channelId, list);
      return;
    }
    this.put(this.load(msg.channelId), toStored(msg));   // local-only bookkeeping never goes to disk
  }

  /** Removes a message (a deletion). */
  remove(channelId: string, ts: string): void {
    const state = this.load(channelId);
    if (!state.byTs.delete(ts)) return;
    this.append(channelId, state, [JSON.stringify({ deleted: ts })]);
  }

  /** Drops a local echo whose send failed. */
  dropPending(channelId: string, clientId: string): void {
    const list = this.pending.get(channelId);
    if (!list) return;
    const rest = list.filter(p => p.clientId !== clientId);
    if (rest.length) this.pending.set(channelId, rest); else this.pending.delete(channelId);
  }

  /** Returns a SlackService whose history, onMessage and posts go through this cache. Types are unchanged. */
  wrap(service: SlackService): SlackService {
    return wrapService(this, service);
  }

  // ---- internals ----

  private file(channelId: string): string {
    if (!CHANNEL_ID.test(channelId)) throw new Error("invalid channel id");
    const full = path.join(this.dir, `${channelId}.jsonl`);
    return full;
  }

  private load(channelId: string): ChannelState {
    const known = this.channels.get(channelId);
    if (known) return known;
    const file = this.file(channelId);
    const state: ChannelState = { byTs: new Map(), lineCount: 0 };
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

  private put(state: ChannelState, msg: ChatMessage): void {
    state.byTs.set(msg.ts, msg);
    this.append(msg.channelId, state, [JSON.stringify(msg)]);
  }

  private append(channelId: string, state: ChannelState, lines: string[]): void {
    fs.appendFileSync(this.file(channelId), lines.join("\n") + "\n");
    state.lineCount += lines.length;
    if (state.byTs.size > this.maxMessages + this.slack || state.lineCount > this.maxMessages * 2 + 16) this.compact(channelId, state);
  }

  /** Keeps the newest maxMessages and rewrites the file atomically (temp file, then rename). */
  private compact(channelId: string, state: ChannelState): void {
    const keep = [...state.byTs.values()].sort((a, b) => compareTs(a.ts, b.ts)).slice(-this.maxMessages);
    state.byTs = new Map(keep.map(m => [m.ts, m]));
    const file = this.file(channelId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, keep.map(m => JSON.stringify(m) + "\n").join(""));
    fs.renameSync(tmp, file);
    state.lineCount = keep.length;
  }

  private topLevel(state: ChannelState): ChatMessage[] {
    return [...state.byTs.values()].filter(m => !m.threadTs || m.threadTs === m.ts).sort((a, b) => compareTs(b.ts, a.ts));
  }

  private olderThan(state: ChannelState, boundary: string | undefined): ChatMessage[] {
    const top = this.topLevel(state);
    return boundary === undefined ? top : top.filter(m => compareTs(m.ts, boundary) < 0);
  }

  private page(channelId: string, boundary: string | undefined, limit: number, fromCache: boolean): HistoryPage {
    const state = this.load(channelId);
    const older = this.olderThan(state, boundary);
    const messages = older.slice(0, limit);
    if (boundary === undefined) {
      const echoes = (this.pending.get(channelId) ?? []).filter(p => !p.threadTs).sort((a, b) => compareTs(b.ts, a.ts));
      messages.unshift(...echoes);
    }
    const more = older.length > limit || !state.upstream?.done;
    const last = older[Math.min(limit, older.length) - 1];
    const nextCursor = more && last ? CURSOR_PREFIX + last.ts : undefined;
    return { messages: structuredClone(messages), nextCursor, fromCache };
  }

  private startRefresh(channelId: string, limit: number): Promise<void> {
    const running = this.refreshing.get(channelId);
    if (running) return running;
    const p = this.refresh(channelId, limit).catch(() => undefined).finally(() => { this.refreshing.delete(channelId); });
    this.refreshing.set(channelId, p);
    return p;
  }

  /** Fetches Slack's newest pages until one reaches the latest cached ts (or the page cap). Stores them and tells onFill listeners. */
  private async refresh(channelId: string, limit: number): Promise<void> {
    const state = this.load(channelId);
    const latest = this.topLevel(state)[0]?.ts;
    let cursor: string | undefined;
    for (let i = 0; i < MAX_GAP_PAGES; i++) {
      const res = await this.fetcher.history(channelId, cursor, limit);
      for (const m of res.messages) {
        const had = state.byTs.get(m.ts);
        this.ingest({ ...m, pending: undefined });
        if (!had) for (const l of this.fillListeners) { try { l(m); } catch { /* isolate the listener */ } }
      }
      cursor = res.nextCursor;
      state.upstream ??= { nextCursor: cursor, done: !cursor };
      if (!cursor) { state.upstream = { nextCursor: undefined, done: true }; return; }
      const oldest = res.messages.reduce<string | undefined>((o, m) => (o === undefined || compareTs(m.ts, o) < 0 ? m.ts : o), undefined);
      if (latest === undefined || (oldest !== undefined && compareTs(oldest, latest) <= 0) || res.messages.length === 0) return;
    }
  }

  /** Pages past the cached range: continues Slack's own cursor chain from where this session left off (from the newest page if none). */
  private async fetchNext(channelId: string, state: ChannelState, limit: number): Promise<void> {
    const up = state.upstream ?? { nextCursor: undefined, done: false };
    const res = await this.fetcher.history(channelId, up.nextCursor, limit);
    for (const m of res.messages) this.ingest({ ...m, pending: undefined });
    state.upstream = { nextCursor: res.nextCursor, done: !res.nextCursor || res.nextCursor === up.nextCursor };
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
    fill = cache.onFill(message => fanOut({ type: "message", message }));
  };
  const unsubscribe = () => { upstream?.dispose(); fill?.dispose(); upstream = fill = undefined; };

  const confirmed = (m: ChatMessage): ChatMessage => { cache.ingest(m); return m; };

  return {
    postAsUser: async (opts: PostOptions) => {
      const echo = opts.clientId === undefined ? undefined : localEcho(opts);
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
function localEcho(opts: PostOptions): ChatMessage {
  const ts = (Date.now() / 1000).toFixed(6);
  return {
    id: `${opts.channelId}:${ts}`, channelId: opts.channelId, ts, ...(opts.threadTs ? { threadTs: opts.threadTs } : {}),
    author: { id: "", name: "", isBot: false }, text: opts.text, codeRefs: [], sentVia: "user", pending: true, clientId: opts.clientId,
  };
}
