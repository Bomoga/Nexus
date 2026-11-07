import { describe, expect, it, vi } from "vitest";
import { ChatMessage } from "../../contracts";
import { encodeCodeRef } from "../../contracts";
import { fx } from "../../contracts/fixtures";
import { makeFakeBolt } from "./fake-bolt.test-util";
import { SlackSocket, createBoltApp } from "./socket";
import type { SlackMessageEvent } from "./types";

const tokens = { botToken: "xoxb-SECRET-bot", appToken: "xapp-SECRET-app" };

function setup(over: Partial<ConstructorParameters<typeof SlackSocket>[0]> = {}) {
  const bolt = makeFakeBolt();
  const socket = new SlackSocket({ getTokens: async () => tokens, makeApp: () => bolt.app, sleep: async () => undefined, ...over });
  const events: SlackMessageEvent[] = [];
  socket.onMessage(e => events.push(e));
  return { bolt, socket, events };
}

const ownPost = { type: "message", channel: "C1", user: "U_ADRIAN", bot_id: "B1", app_id: "A1", bot_profile: { id: "B1", name: "Nexus" }, ts: "10.000100", text: "mine" };

describe("SlackSocket events", () => {
  it("maps a message to a contract ChatMessage and starts Bolt", async () => {
    const { bolt, socket, events } = setup();
    expect(await socket.start()).toBe(true);
    await bolt.message({ type: "message", channel: "C1", user: "U_ADRIAN", ts: "10.000200", thread_ts: "10.000100", text: `see ${encodeCodeRef(fx.codeRef)}` });
    expect(events).toHaveLength(1);
    const msg = (events[0] as { message: ChatMessage }).message;
    expect(ChatMessage.parse(msg)).toEqual(msg);
    expect(msg).toMatchObject({ id: "C1:10.000200", threadTs: "10.000100", author: { id: "U_ADRIAN", name: "adrian", isBot: false }, sentVia: "user", codeRefs: [fx.codeRef] });
    expect(events[0].type).toBe("message");
  });

  it("maps a person's own Nexus post (user + bot_id + app_id) to human", async () => {
    const { bolt, socket, events } = setup();
    await socket.start();
    await bolt.message(ownPost);
    expect((events[0] as { message: ChatMessage }).message).toMatchObject({ author: { id: "U_ADRIAN", isBot: false }, sentVia: "user" });
  });

  it("maps the bot's own message to bot and keeps its blocks; falls back to bot_id when the user is unknown", async () => {
    const { bolt, socket, events } = setup();
    await socket.start();
    await bolt.message({ type: "message", channel: "C1", user: "U_BOT", bot_id: "B1", ts: "11.000100", text: "approve?", blocks: [{ type: "actions" }] });
    await bolt.message({ type: "message", channel: "C1", user: "U_GHOST", bot_id: "B9", ts: "11.000200", text: "?" });
    await bolt.message({ type: "message", subtype: "bot_message", channel: "C1", bot_id: "B7", username: "ci", ts: "11.000300", text: "build ok" });
    const [a, b, c] = events.map(e => (e as { message: ChatMessage }).message);
    expect(a).toMatchObject({ sentVia: "bot", author: { isBot: true }, blocks: [{ type: "actions" }] });
    expect(b).toMatchObject({ sentVia: "bot", author: { id: "U_GHOST", isBot: true } });
    expect(c).toMatchObject({ sentVia: "bot", author: { id: "B7", name: "ci", isBot: true } });
  });

  it("message_changed replaces: emits the new version with the original ts", async () => {
    const { bolt, socket, events } = setup();
    await socket.start();
    await bolt.message({ type: "message", subtype: "message_changed", channel: "C1", ts: "12.000900", message: { type: "message", user: "U_BOT", bot_id: "B1", ts: "12.000100", text: "progress 2/3" } });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("message_changed");
    expect((events[0] as { message: ChatMessage }).message).toMatchObject({ id: "C1:12.000100", text: "progress 2/3", sentVia: "bot" });
  });

  it("ignores joins, deletions, hidden and malformed events without throwing", async () => {
    const { bolt, socket, events } = setup();
    await socket.start();
    await bolt.message({ type: "message", subtype: "channel_join", channel: "C1", user: "U_ADRIAN", ts: "1.1", text: "joined" });
    await bolt.message({ type: "message", subtype: "message_deleted", channel: "C1", ts: "1.2" });
    await bolt.message({ type: "message", subtype: "message_changed", channel: "C1", ts: "1.3", hidden: true, message: { user: "U_ADRIAN", ts: "1.0", text: "x" } });
    await bolt.message({ type: "message", user: "U_ADRIAN", ts: "1.4", text: "no channel" });
    await bolt.message({} as never);
    expect(events).toEqual([]);
  });

  it("filters by channel and isolates throwing listeners", async () => {
    const { bolt, socket } = setup();
    const c1 = vi.fn(), c2 = vi.fn();
    socket.onMessage(() => { throw new Error("boom"); });
    const d1 = socket.onMessage(c1, ["C1"]);
    socket.onMessage(c2, ["C2"]);
    await socket.start();
    await bolt.message({ ...ownPost, ts: "5.1" });
    expect(c1).toHaveBeenCalledOnce();
    expect(c2).not.toHaveBeenCalled();
    d1.dispose();
    await bolt.message({ ...ownPost, ts: "5.2" });
    expect(c1).toHaveBeenCalledOnce();
  });

  it("looks a user up once; a failed lookup falls back to bot_id and is not hammered", async () => {
    const { bolt, socket, events } = setup();
    await socket.start();
    await bolt.message({ ...ownPost, ts: "6.1" });
    await bolt.message({ ...ownPost, ts: "6.2" });
    await bolt.message({ ...ownPost, user: "U_GHOST", ts: "6.3" });
    await bolt.message({ ...ownPost, user: "U_GHOST", ts: "6.4" });
    expect(bolt.info).toHaveBeenCalledTimes(2);
    expect((events[2] as { message: ChatMessage }).message.author.isBot).toBe(true);
  });
});

describe("SlackSocket connection", () => {
  it("reports connect and drop, and stop() stops Bolt", async () => {
    const { bolt, socket } = setup();
    const seen: boolean[] = [];
    socket.onConnection(c => seen.push(c));
    await socket.start();
    bolt.connection(false);
    bolt.connection(true);
    await socket.stop();
    expect(seen).toEqual([true, false, true, false]);
    expect(bolt.app.stop).toHaveBeenCalled();
    expect(socket.isConnected()).toBe(false);
  });

  it("retries with growing backoff until Bolt starts", async () => {
    const bolt = makeFakeBolt();
    bolt.app.start.mockRejectedValueOnce(new Error("invalid_auth xapp-SECRET-app")).mockRejectedValueOnce(new Error("net")).mockResolvedValue(undefined);
    const sleeps: number[] = [];
    const socket = new SlackSocket({ getTokens: async () => tokens, makeApp: () => bolt.app, initialBackoffMs: 100, maxBackoffMs: 250, sleep: async ms => { sleeps.push(ms); } });
    expect(await socket.start()).toBe(false);
    await vi.waitFor(() => expect(socket.isConnected()).toBe(true));
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(100); expect(sleeps[0]).toBeLessThan(121);
    expect(sleeps[1]).toBeGreaterThanOrEqual(200); expect(sleeps[1]).toBeLessThan(241);
  });

  it("stays down without tokens, and a stop during backoff cancels the retry", async () => {
    let calls = 0;
    const bolt = makeFakeBolt();
    let release!: () => void;
    const socket = new SlackSocket({ getTokens: async () => (calls++ === 0 ? null : tokens), makeApp: () => bolt.app, sleep: () => new Promise<void>(r => { release = r; }) });
    expect(await socket.start()).toBe(false);
    await socket.stop();
    release();
    await new Promise(r => setTimeout(r, 0));
    expect(bolt.app.start).not.toHaveBeenCalled();
  });

  it("never leaks a token through errors, logs or events", async () => {
    const spy = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const bolt = makeFakeBolt();
    bolt.app.start.mockRejectedValueOnce(new Error("bad xapp-SECRET-app"));
    const events: SlackMessageEvent[] = [];
    const socket = new SlackSocket({ getTokens: async () => tokens, makeApp: () => bolt.app, sleep: async () => undefined });
    socket.onMessage(e => events.push(e));
    await socket.start();
    await vi.waitFor(() => expect(socket.isConnected()).toBe(true));
    await bolt.message({ ...ownPost, user: "U_GHOST", text: "hi" });
    const all = JSON.stringify([events, spy.map(s => s.mock.calls)]);
    expect(all).not.toMatch(/SECRET|xoxb|xapp/);
    spy.forEach(s => s.mockRestore());
    await socket.stop();
  });
});

describe("createBoltApp", () => {
  it("builds the real Bolt app in Socket Mode without any network I/O", () => {
    const app = createBoltApp(tokens);
    expect(typeof app.start).toBe("function");
    expect(typeof app.client.users.info).toBe("function");
    expect(() => app.action("nexus.approve", async () => undefined)).not.toThrow();
  });
});
