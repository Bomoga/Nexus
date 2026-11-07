// Live Slack events over Socket Mode (L2-03): message and message_changed become ChatMessages for the slack.subscribe feed.
// Every handler is async and short; a dropped or failed connection is retried with backoff; nothing here logs or returns a token.
import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import type { ChatMessage, SlackUser } from "../../contracts";
import type { BotTokenProvider, BotTokens } from "./bot";
import type { Disposable, SlackMessageEvent } from "./types";
import { isShownSlackMsg, mapSlackMessage, toSlackUser, type SlackMsg, type SlackUserInfo } from "./web-client";

/** A Slack `message` event as delivered over Socket Mode (loose: the payload is untrusted). */
export interface SlackEventMessage extends SlackMsg {
  channel?: string;
  hidden?: boolean;
  message?: SlackMsg;   // message_changed: the new version
}

export interface BoltActionArgs {
  ack(): Promise<unknown>;
  body: {
    type?: string;
    user?: { id?: string; name?: string; username?: string };
    channel?: { id?: string };
    container?: { channel_id?: string; message_ts?: string };
    message?: { ts?: string };
  };
  action: { action_id?: string; value?: string };
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
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  client: BoltClientLike;
}

const SILENT_LOGGER = {
  debug() {}, info() {}, warn() {}, error() {},   // Bolt's own logging is off: nothing from the socket layer may echo a token
  setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {},
};

/** The real Bolt App in Socket Mode with the app-level token. Constructing it does no network I/O. */
export function createBoltApp(tokens: BotTokens): BoltLike {
  const receiver = new SocketModeReceiver({ appToken: tokens.appToken, logger: SILENT_LOGGER, logLevel: LogLevel.ERROR });
  // ignoreSelf off: the bot's own posts and edits are part of the live feed too (consumers match them by id).
  const app = new App({ token: tokens.botToken, receiver, logger: SILENT_LOGGER, logLevel: LogLevel.ERROR, ignoreSelf: false });
  return {
    event: (name, handler) => { app.event(name, async ({ event }) => { await handler({ event: event as unknown as SlackEventMessage }); }); },
    action: (id, handler) => { app.action(id, async ({ ack, body, action }) => { await handler({ ack: () => ack(), body: body as unknown as BoltActionArgs["body"], action: action as unknown as BoltActionArgs["action"] }); }); },
    error: handler => { app.error(async e => { await handler(e); }); },
    onConnection: cb => {
      receiver.client.on("connected", () => cb(true));
      receiver.client.on("disconnected", () => cb(false));
    },
    start: () => app.start(),
    stop: () => app.stop(),
    client: app.client as unknown as BoltClientLike,
  };
}

export interface SocketOptions {
  getTokens: BotTokenProvider;
  /** Test seam; defaults to createBoltApp. */
  makeApp?: (tokens: BotTokens) => BoltLike;
  /** Registers more handlers (approval buttons) on the app before it starts. */
  configure?: (app: BoltLike) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type Listener = { fn: (evt: SlackMessageEvent) => void; channelIds?: string[] };

export class SlackSocket {
  private app: BoltLike | undefined;
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
    const app = this.app;
    this.app = undefined;
    this.setConnected(false);
    try { await app?.stop(); } catch { /* already down */ }
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
      app = (this.opts.makeApp ?? createBoltApp)(tokens);
      app.event("message", async ({ event }) => { await this.onEvent(app as BoltLike, event); });
      app.error(async () => { /* handler errors are already contained; never echo them */ });
      app.onConnection(up => { if (gen === this.generation) this.setConnected(up); });
      this.opts.configure?.(app);
      await app.start();
    } catch {
      try { await app?.stop(); } catch { /* never started */ }
      return false;
    }
    if (gen !== this.generation) { try { await app.stop(); } catch { /* superseded */ } return false; }
    this.app = app;
    this.setConnected(true);
    return true;
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
      const raw = changed ? evt.message : evt;
      const channelId = evt.channel;
      if (!raw || !channelId || evt.hidden || !isShownSlackMsg(raw)) return;
      if (!changed && (evt.subtype === "message_deleted" || evt.subtype === "message_replied")) return;
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
