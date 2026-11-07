// Live Slack events over Socket Mode (L2-03): message and message_changed become ChatMessages for the slack.subscribe feed.
// Every handler is async and short; a dropped or failed connection is retried with backoff; nothing here logs or returns a token.
import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import type { ChatMessage, SlackUser } from "../../contracts";
import type { BotIdentity, BotTokenProvider, BotTokens } from "./bot";
import type { Disposable, SlackMessageEvent } from "./types";
import { isShownSlackMsg, mapSlackMessage, toSlackUser, type SlackMsg, type SlackUserInfo } from "./web-client";

/** A Slack `message` event as delivered over Socket Mode (loose: the payload is untrusted). */
export interface SlackEventMessage extends SlackMsg {
  channel?: string;
  hidden?: boolean;
  event_ts?: string;
  deleted_ts?: string;
  message?: SlackMsg;   // message_changed: the new version
}


export interface BoltActionArgs {
  ack(): Promise<unknown>;
  body: {
    type?: string;
    team?: { id?: string };
    user?: { id?: string; name?: string; username?: string; team_id?: string };
    channel?: { id?: string };
    container?: { channel_id?: string; message_ts?: string };
    /** The message the button sits on, as Slack reports it (used to tie a click to the bot's own card). */
    message?: { ts?: string; user?: string; bot_id?: string };
  };
  action: { action_id?: string; block_id?: string; value?: string };
}

export interface BoltClientLike {
  users: { info(a: { user: string }): Promise<{ user?: SlackUserInfo }> };
}

/** The slice of a Bolt App this module uses. The real one is createBoltApp; tests inject a fake. */
export interface BoltLike {
  event(name: "message", handler: (a: { event: SlackEventMessage }) => Promise<void>): void;
  action(id: string, handler: (a: BoltActionArgs) => Promise<void>): void;
  error(handler: (e: unknown) => Promise<void>): void;
  /** Reports Socket Mode connect and disconnect (the underlying client reconnects on its own). */
  onConnection(cb: (connected: boolean) => void): void;
  /** Called when the SDK's own reconnect path failed for good: the client is dead and must be rebuilt by the caller. */
  onDead(cb: () => void): void;
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  client: BoltClientLike;
}

const SILENT_LOGGER = {
  debug() {}, info() {}, warn() {}, error() {},   // Bolt's own logging is off: nothing from the socket layer may echo a token
  setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {},
};

/** Connection retries for apps.connections.open: short, so a bad token fails fast and SlackSocket's own backoff takes over. */
const CONNECT_RETRY = { retries: 2, factor: 1.5, minTimeout: 500, maxTimeout: 3_000 };

/**
 * The real Bolt App in Socket Mode with the app-level token. Construction does no network I/O: token verification is off and the
 * bot's ids come from our own auth.test, so Bolt never calls auth.test itself (and cannot leave an unhandled rejection).
 */
export function createBoltApp(tokens: BotTokens, identity: BotIdentity): BoltLike {
  const receiver = new SocketModeReceiver({
    appToken: tokens.appToken, logger: SILENT_LOGGER, logLevel: LogLevel.ERROR,
    installerOptions: { clientOptions: { retryConfig: CONNECT_RETRY } },
  });
  // ignoreSelf off: the bot's own posts and edits are part of the live feed too (consumers match them by id).
  const app = new App({
    token: tokens.botToken, receiver, logger: SILENT_LOGGER, logLevel: LogLevel.ERROR, ignoreSelf: false,
    tokenVerificationEnabled: false, botUserId: identity.userId, botId: identity.botId,
  });
  // The SDK reconnects by calling client.start() from a timer and drops the promise, so a failure there is an unhandled rejection and a
  // silently dead client. Wrap start: the first connect still rejects to the caller; later failures are caught and reported as "dead".
  const client = receiver.client;
  const originalStart = client.start.bind(client);
  const deadListeners: (() => void)[] = [];
  let everConnected = false;
  client.start = async () => {
    try {
      const r = await originalStart();
      everConnected = true;
      return r;
    } catch (e) {
      if (!everConnected) throw e;
      for (const cb of deadListeners) { try { cb(); } catch { /* observer */ } }
      return undefined as never;
    }
  };
  return {
    event: (name, handler) => { app.event(name, async ({ event }) => { await handler({ event: event as unknown as SlackEventMessage }); }); },
    action: (id, handler) => { app.action(id, async ({ ack, body, action }) => { await handler({ ack: () => ack(), body: body as unknown as BoltActionArgs["body"], action: action as unknown as BoltActionArgs["action"] }); }); },
    error: handler => { app.error(async e => { await handler(e); }); },
    onConnection: cb => {
      // only a live websocket counts as connected: connecting, reconnecting and disconnected are all "down"
      client.on("connected", () => cb(true));
      for (const down of ["connecting", "reconnecting", "disconnecting", "disconnected"] as const) client.on(down, () => cb(false));
    },
    onDead: cb => { deadListeners.push(cb); },
    start: () => app.start(),
    stop: () => app.stop(),
    client: app.client as unknown as BoltClientLike,
  };
}

export interface SocketOptions {
  getTokens: BotTokenProvider;
  /** The bot's own ids (auth.test), passed to Bolt so it makes no auth call of its own. */
  getIdentity: () => Promise<BotIdentity>;
  /** Test seam; defaults to createBoltApp. */
  makeApp?: (tokens: BotTokens, identity: BotIdentity) => BoltLike;
  /** Registers more handlers (approval buttons) on the app before it starts. */
  configure?: (app: BoltLike) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const SEEN_LIMIT = 2_000;

type Listener = { fn: (evt: SlackMessageEvent) => void; channelIds?: string[] };

export class SlackSocket {
  private app: BoltLike | undefined;
  private starting: BoltLike | undefined;
  private readonly seen = new Map<string, true>();
  private running = false;
  private connected = false;
  private generation = 0;
  private readonly listeners = new Set<Listener>();
  private readonly connectionListeners = new Set<(connected: boolean) => void>();
  private readonly users = new Map<string, { user?: SlackUser; at: number }>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: SocketOptions) {
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  isConnected(): boolean { return this.connected; }

  /** Starts once; the first attempt is awaited, later attempts retry in the background with exponential backoff. Resolves true when connected. */
  async start(): Promise<boolean> {
    if (this.running) return this.connected;
    this.running = true;
    const gen = ++this.generation;
    if (await this.attempt(gen)) return true;
    void this.retry(gen);
    return false;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation++;
    const apps = [this.app, this.starting];
    this.app = undefined;
    this.starting = undefined;
    this.setConnected(false);
    // also stops an attempt still in flight (its start() then rejects or resolves into a superseded generation)
    for (const app of apps) { try { await app?.stop(); } catch { /* already down */ } }
  }

  onMessage(fn: (evt: SlackMessageEvent) => void, channelIds?: string[]): Disposable {
    const l: Listener = { fn, channelIds };
    this.listeners.add(l);
    return { dispose: () => { this.listeners.delete(l); } };
  }

  /** Called with true/false when Socket Mode connects or drops. */
  onConnection(fn: (connected: boolean) => void): Disposable {
    this.connectionListeners.add(fn);
    return { dispose: () => { this.connectionListeners.delete(fn); } };
  }

  // ---- internals ----

  private async attempt(gen: number): Promise<boolean> {
    let tokens: BotTokens | null;
    try { tokens = await this.opts.getTokens(); } catch { tokens = null; }   // the provider's message is never forwarded
    if (!tokens || gen !== this.generation) return false;
    let app: BoltLike | undefined;
    try {
      const identity = await this.opts.getIdentity();
      if (gen !== this.generation) return false;
      app = (this.opts.makeApp ?? createBoltApp)(tokens, identity);
      const mine = app;
      app.event("message", async ({ event }) => { if (gen === this.generation) await this.onEvent(mine, event); });
      app.error(async () => { /* handler errors are already contained; never echo them */ });
      app.onConnection(up => { if (gen === this.generation) this.setConnected(up); });
      app.onDead(() => { void this.onDead(gen, mine); });
      this.opts.configure?.(app);
      this.starting = app;
      await app.start();
    } catch {
      if (this.starting === app) this.starting = undefined;
      try { await app?.stop(); } catch { /* never started */ }
      return false;
    }
    if (this.starting === app) this.starting = undefined;
    if (gen !== this.generation) { try { await app.stop(); } catch { /* superseded */ } return false; }
    this.app = app;
    this.setConnected(true);
    return true;
  }

  /** The SDK gave up reconnecting: drop the dead client and start over with our own backoff. */
  private async onDead(gen: number, app: BoltLike): Promise<void> {
    if (gen !== this.generation || this.app !== app) return;
    this.app = undefined;
    this.setConnected(false);
    try { await app.stop(); } catch { /* already dead */ }
    if (this.running && gen === this.generation) void this.retry(gen);
  }

  private async retry(gen: number): Promise<void> {
    let delay = this.opts.initialBackoffMs ?? 1_000;
    const max = this.opts.maxBackoffMs ?? 30_000;
    while (this.running && gen === this.generation) {
      await this.sleep(delay + Math.floor(Math.random() * delay * 0.2));   // jitter
      if (!this.running || gen !== this.generation) return;
      if (await this.attempt(gen)) return;
      delay = Math.min(delay * 2, max);
    }
  }

  private setConnected(up: boolean): void {
    if (this.connected === up) return;
    this.connected = up;
    for (const fn of [...this.connectionListeners]) { try { fn(up); } catch { /* a listener must not break the others */ } }
  }

  private async onEvent(app: BoltLike, evt: SlackEventMessage): Promise<void> {
    try {
      const changed = evt.subtype === "message_changed";
      // Slack always marks message_changed hidden: true, so that one subtype is the exception to dropping hidden events.
      if (evt.hidden && !changed) return;
      const raw = changed ? evt.message : evt;
      const channelId = evt.channel;
      if (!raw || !channelId || !isShownSlackMsg(raw)) return;
      if (!changed && (evt.subtype === "message_deleted" || evt.subtype === "message_replied")) return;
      // Socket Mode redelivers after a reconnect: one live event per message (and per edit).
      const key = changed ? `${channelId}:${raw.ts}:edit:${evt.ts ?? ""}` : `${channelId}:${raw.ts}`;
      if (this.seen.has(key)) return;
      this.seen.set(key, true);
      if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.keys().next().value as string);
      const known = raw.user ? await this.lookupUser(app, raw.user) : undefined;
      const message = mapSlackMessage(channelId, raw, known);
      this.emit({ type: changed ? "message_changed" : "message", message });
    } catch { /* an odd payload must not take the handler (and the socket) down */ }
  }

  private emit(evt: Extract<SlackMessageEvent, { message: ChatMessage }>): void {
    for (const l of [...this.listeners]) {
      if (l.channelIds && !l.channelIds.includes(evt.message.channelId)) continue;
      try { l.fn(structuredClone(evt)); } catch { /* isolate listeners */ }
    }
  }

  /** users.info, cached; a failed lookup is remembered briefly so a flood of messages does not hammer Slack. */
  private async lookupUser(app: BoltLike, id: string): Promise<SlackUser | undefined> {
    const hit = this.users.get(id);
    if (hit && (hit.user || this.now() - hit.at < 60_000)) return hit.user;
    try {
      const u = (await app.client.users.info({ user: id })).user;
      const user = u ? toSlackUser(id, u) : undefined;
      this.users.set(id, { user, at: this.now() });
      return user;
    } catch {
      this.users.set(id, { at: this.now() });
      return undefined;
    }
  }
}
