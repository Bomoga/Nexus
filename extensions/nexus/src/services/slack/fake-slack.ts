// In-memory SlackService seeded from the contract fixtures. No network, no tokens.
import type { Channel, ChatMessage, SlackStatus, SlackUser, Thread } from "../../contracts";
import { demoScenario } from "../../contracts/fixtures/scenario";
import type { BotPostOptions, Disposable, HistoryPage, PostOptions, SlackMessageEvent, SlackService } from "./types";

type Listener = { fn: (evt: SlackMessageEvent) => void; channelIds?: string[] };

export class FakeSlack implements SlackService {
  private readonly messagesByChannel = new Map<string, ChatMessage[]>();
  private readonly listeners = new Set<Listener>();
  private readonly channelList: Channel[];
  private readonly userList: SlackUser[];
  private readonly statusValue: SlackStatus;
  private counter = 0;
  private pendingChanged: ChatMessage | undefined;
  private nextPostFailure: string | undefined;

  constructor() {
    this.channelList = structuredClone(demoScenario.channels);
    this.userList = structuredClone(demoScenario.users);
    this.statusValue = structuredClone(demoScenario.slackStatus);
    for (const m of structuredClone(demoScenario.thread.messages)) this.store(m, false);   // fixture replyCounts already count their replies
  }

  async postAsUser(opts: PostOptions): Promise<ChatMessage> {
    const channel = this.channel(opts.channelId);
    if (!channel.isMember) throw new Error(`user is not a member of ${channel.name}`);
    this.consumeFailure();
    const me = this.statusValue.postsAs;
    if (!me) throw new Error("no user token: refusing to post as the app");
    return this.post(opts, { id: me.userId, name: me.name.toLowerCase(), isBot: false }, "user");
  }

  async postAsBot(opts: BotPostOptions): Promise<ChatMessage> {
    const channel = this.channel(opts.channelId);
    if (!channel.botIsMember) throw new Error(`bot is not a member of ${channel.name}`);
    this.consumeFailure();
    const bot = this.userList.find(u => u.isBot);
    const msg = this.post(opts, { id: bot?.id ?? "U_NEXUSBOT", name: bot?.name ?? "nexus", isBot: true }, "bot");
    if (opts.blocks !== undefined) msg.blocks = opts.blocks;
    return msg;
  }

  async updateBotMessage(channelId: string, ts: string, text: string, blocks?: unknown): Promise<ChatMessage> {
    this.channel(channelId);
    const msg = this.messagesByChannel.get(channelId)?.find(m => m.ts === ts);
    if (!msg || msg.sentVia !== "bot") throw new Error(`no bot message ${channelId}:${ts}`);
    msg.text = text;
    if (blocks !== undefined) msg.blocks = blocks;
    this.emit({ type: "message_changed", message: structuredClone(msg) });
    return structuredClone(msg);
  }

  async channels(): Promise<Channel[]> { return structuredClone(this.channelList); }

  async history(channelId: string, cursor?: string, limit = 50): Promise<HistoryPage> {
    this.channel(channelId);
    const top = (this.messagesByChannel.get(channelId) ?? []).filter(m => !m.threadTs).sort((a, b) => Number(b.ts) - Number(a.ts));
    const start = cursor ? Number(cursor) : 0;
    const page = top.slice(start, start + limit);
    const next = start + limit < top.length ? String(start + limit) : undefined;
    return { messages: structuredClone(page), nextCursor: next, fromCache: true };
  }

  async getThread(channelId: string, threadTs: string): Promise<Thread> {
    this.channel(channelId);
    const all = this.messagesByChannel.get(channelId) ?? [];
    const messages = all.filter(m => m.ts === threadTs || m.threadTs === threadTs).sort((a, b) => Number(a.ts) - Number(b.ts));
    return structuredClone({ channelId, threadTs, messages });
  }

  async users(ids?: string[]): Promise<SlackUser[]> {
    return structuredClone(ids ? this.userList.filter(u => ids.includes(u.id)) : this.userList);
  }

  async status(): Promise<SlackStatus> { return structuredClone(this.statusValue); }

  onMessage(listener: (evt: SlackMessageEvent) => void, channelIds?: string[]): Disposable {
    const entry: Listener = { fn: listener, channelIds };
    this.listeners.add(entry);
    return { dispose: () => { this.listeners.delete(entry); } };
  }

  /** Test helper: simulate a message arriving from Slack. */
  receive(message: ChatMessage): void {
    this.channel(message.channelId);
    this.store(message);
    this.emit({ type: "message", message: structuredClone(message) });
  }

  /** Test helper: the next postAsUser or postAsBot rejects with this reason (a failed send for the UI's retry path). */
  failNextPost(reason: string): void { this.nextPostFailure = reason; }

  private consumeFailure(): void {
    const reason = this.nextPostFailure;
    if (reason !== undefined) { this.nextPostFailure = undefined; throw new Error(reason); }
  }

  private channel(id: string): Channel {
    const c = this.channelList.find(x => x.id === id);
    if (!c) throw new Error(`unknown channel ${id}`);
    return c;
  }

  private post(opts: PostOptions, author: ChatMessage["author"], sentVia: ChatMessage["sentVia"]): ChatMessage {
    // clientId is echoed only on the returned copy: Slack's own events and history never carry it.
    const ts = `${1762485400 + ++this.counter}.000000`;
    const msg: ChatMessage = { id: `${opts.channelId}:${ts}`, channelId: opts.channelId, ts, author, text: opts.text, codeRefs: [], sentVia };
    if (opts.threadTs) msg.threadTs = opts.threadTs;
    this.store(msg);
    this.emit({ type: "message", message: structuredClone(msg) });
    const confirmed = structuredClone(msg);
    if (opts.clientId !== undefined) confirmed.clientId = opts.clientId;
    return confirmed;
  }

  private store(m: ChatMessage, countReply = true): void {
    const list = this.messagesByChannel.get(m.channelId) ?? [];
    list.push(m);
    this.messagesByChannel.set(m.channelId, list);
    if (countReply && m.threadTs && m.threadTs !== m.ts) {
      const parent = list.find(p => p.ts === m.threadTs);
      if (parent) {
        parent.replyCount = (parent.replyCount ?? 0) + 1;
        this.pendingChanged = parent;
      }
    }
  }

  private emit(evt: SlackMessageEvent): void {
    this.dispatch(evt);
    const parent = this.pendingChanged;
    if (parent) { this.pendingChanged = undefined; this.dispatch({ type: "message_changed", message: structuredClone(parent) }); }
  }

  private dispatch(evt: SlackMessageEvent): void {
    for (const l of this.listeners) {
      if (evt.type === "status" || !l.channelIds || l.channelIds.includes(evt.message.channelId)) l.fn(evt);
    }
  }
}
