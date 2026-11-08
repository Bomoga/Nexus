import { SocketModeClient } from "@slack/socket-mode";
import { WebAPIPlatformError } from "@slack/web-api/dist/errors.js";
import { describe, expect, it, vi } from "vitest";
import { ChatMessage } from "../../contracts";
import { encodeCodeRef } from "../../contracts";
import { fx } from "../../contracts/fixtures";
import { getIdentity, identity, makeFakeBolt } from "./fake-bolt.test-util";
import { SlackSocket, createBoltApp, hardenReconnect } from "./socket";
import type { SlackMessageEvent } from "./types";

const tokens = { botToken: "xoxb-SECRET-bot", appToken: "xapp-SECRET-app" };

function setup(over: Partial<ConstructorParameters<typeof SlackSocket>[0]> = {}) {
  const bolt = makeFakeBolt();
  const socket = new SlackSocket({ getIdentity, getTokens: async () => tokens, makeApp: () => bolt.app, sleep: async () => undefined, ...over });
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

  it("serves display text for mrkdwn, resolves mentions, keeps code refs from the raw text, and survives a failed lookup", async () => {
    const { bolt, socket, events } = setup();
    await socket.start();
    await bolt.message({ type: "message", channel: "C1", user: "U_ADRIAN", ts: "10.000300", text: `<@U_ADRIAN> Map&lt;string&gt; <${encodeCodeRef(fx.codeRef)}|here> <@U_NOBODY> &lt;@U1&gt;` });
    expect(events).toHaveLength(1);
    const msg = (events[0] as { message: ChatMessage }).message;
    expect(msg.text).toBe("@Adrian Map<string> here @U_NOBODY <@U1>");
    expect(msg.codeRefs).toEqual([fx.codeRef]);
  });

  it("converts an edited message the same way, with code refs from the raw text", async () => {
    const { bolt, socket, events } = setup();
    await socket.start();
    await bolt.message({ type: "message", subtype: "message_changed", hidden: true, channel: "C1", ts: "12.000901", event_ts: "12.000901", message: { type: "message", user: "U_ADRIAN", ts: "12.000100", text: `<@U_BRANDON> a &amp; b <${encodeCodeRef(fx.codeRef)}|ref>` } });
    const msg = (events[0] as { message: ChatMessage }).message;
    expect(events[0].type).toBe("message_changed");
    expect(msg.text).toBe("@Brandon a & b ref");
    expect(msg.codeRefs).toEqual([fx.codeRef]);
  });

  it("looks up at most 20 mentioned users per message, and none that carry their own label", async () => {
    const { bolt, socket, events } = setup();
    await socket.start();
    const many = Array.from({ length: 50 }, (_v, i) => `<@U_X${i}>`).join(" ");
    await bolt.message({ type: "message", channel: "C1", user: "U_ADRIAN", ts: "15.1", text: `${many} <@U_LABELED|bob>` });
    const asked = bolt.info.mock.calls.map(c => c[0].user);
    expect(asked.filter(u => u.startsWith("U_X"))).toHaveLength(20);
    expect(asked).not.toContain("U_LABELED");
    const msg = (events[0] as { message: ChatMessage }).message;
    expect(msg.text).toContain("@U_X49");
    expect(msg.text).toContain("@bob");
  });

  it("does not hold a live message longer than the mention-lookup limit when users.info hangs", async () => {
    const { bolt, socket, events } = setup();
    await socket.start();
    const real = bolt.info.getMockImplementation()!;
    bolt.info.mockImplementation(a => (a.user === "U_SLOW" ? new Promise(() => undefined) : real(a)));
    const t0 = Date.now();
    await bolt.message({ type: "message", channel: "C1", user: "U_ADRIAN", ts: "15.2", text: "ping <@U_SLOW>" });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect((events[0] as { message: ChatMessage }).message.text).toBe("ping @U_SLOW");
    await bolt.message({ type: "message", channel: "C1", user: "U_ADRIAN", ts: "15.3", text: "again <@U_SLOW>" });
    expect(bolt.info.mock.calls.filter(c => c[0].user === "U_SLOW")).toHaveLength(1);   // the hanging call is not started again
  }, 10_000);

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
    expect(b).toMatchObject({ sentVia: "user", author: { id: "U_GHOST", isBot: true } });
    expect(c).toMatchObject({ sentVia: "user", author: { id: "B7", name: "ci", isBot: true } });
  });

  it("does not treat another bot's approval-looking blocks as Nexus's", async () => {
    const { bolt, socket, events } = setup();
    await socket.start();
    const blocks = [{ type: "actions", elements: [{ type: "button", action_id: "nexus.approve", value: "ap-1" }] }];
    await bolt.message({ type: "message", subtype: "bot_message", channel: "C1", bot_id: "B9", username: "evil", ts: "13.1", text: "approve?", blocks });
    const m = (events[0] as { message: ChatMessage }).message;
    expect(m).toMatchObject({ sentVia: "user", author: { isBot: true } });
    expect(m.blocks).toBeUndefined();
  });

  it("treats no message as Nexus's when the bot identity has no ids", async () => {
    const { bolt, socket, events } = setup({ getIdentity: async () => ({ userId: "", name: "nexus" }) });
    await socket.start();
    await bolt.message({ type: "message", channel: "C1", user: "U_BOT", bot_id: "B1", ts: "14.1", text: "x", blocks: [{ type: "actions" }] });
    const m = (events[0] as { message: ChatMessage }).message;
    expect(m.sentVia).toBe("user");
    expect(m.blocks).toBeUndefined();
  });

  it("message_changed replaces: emits the new version with the original ts", async () => {
    const { bolt, socket, events } = setup();
    await socket.start();
    await bolt.message({ type: "message", subtype: "message_changed", hidden: true, channel: "C1", ts: "12.000900", event_ts: "12.000900", message: { type: "message", user: "U_BOT", bot_id: "B1", ts: "12.000100", text: "progress 2/3" } });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("message_changed");
    expect((events[0] as { message: ChatMessage }).message).toMatchObject({ id: "C1:12.000100", text: "progress 2/3", sentVia: "bot" });
  });

  it("ignores joins, deletions, hidden and malformed events without throwing", async () => {
    const { bolt, socket, events } = setup();
    await socket.start();
    await bolt.message({ type: "message", subtype: "channel_join", channel: "C1", user: "U_ADRIAN", ts: "1.1", text: "joined" });
    await bolt.message({ type: "message", subtype: "message_deleted", channel: "C1", ts: "1.2" });
    await bolt.message({ type: "message", subtype: "message_deleted", hidden: true, channel: "C1", ts: "1.3", deleted_ts: "1.0" });
    await bolt.message({ type: "message", subtype: "pinned_item", hidden: true, channel: "C1", user: "U_ADRIAN", ts: "1.35", text: "pinned" });
    await bolt.message({ type: "message", user: "U_ADRIAN", ts: "1.4", text: "no channel" });
    await bolt.message({} as never);
    expect(events).toEqual([]);
  });

  it("delivers a repeated event once, and each distinct edit once, with bounded memory", async () => {
    const { bolt, socket, events } = setup();
    await socket.start();
    await bolt.message({ ...ownPost, ts: "7.1" });
    await bolt.message({ ...ownPost, ts: "7.1" });   // socket redelivery after a reconnect
    const edit = (evtTs: string) => bolt.message({ type: "message", subtype: "message_changed", hidden: true, channel: "C1", ts: evtTs, message: { user: "U_ADRIAN", ts: "7.1", text: evtTs } });
    await edit("7.2"); await edit("7.2"); await edit("7.3");
    expect(events.map(e => e.type)).toEqual(["message", "message_changed", "message_changed"]);
    for (let i = 0; i < 2_100; i++) await bolt.message({ ...ownPost, ts: `8.${i}` });
    await bolt.message({ ...ownPost, ts: "7.1" });   // evicted long ago: allowed again, memory stayed bounded
    expect(events.length).toBe(3 + 2_100 + 1);
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
    const socket = new SlackSocket({ getIdentity, getTokens: async () => tokens, makeApp: () => bolt.app, initialBackoffMs: 100, maxBackoffMs: 250, sleep: async ms => { sleeps.push(ms); } });
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
    const socket = new SlackSocket({ getIdentity, getTokens: async () => (calls++ === 0 ? null : tokens), makeApp: () => bolt.app, sleep: () => new Promise<void>(r => { release = r; }) });
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
    const socket = new SlackSocket({ getIdentity, getTokens: async () => tokens, makeApp: () => bolt.app, sleep: async () => undefined });
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

describe("connection robustness", () => {
  it("restarts with its own backoff when the SDK reports the client dead", async () => {
    const apps = [makeFakeBolt(), makeFakeBolt()];
    let n = 0;
    const socket = new SlackSocket({ getIdentity, getTokens: async () => tokens, makeApp: () => apps[n++].app, sleep: async () => undefined });
    await socket.start();
    expect(socket.isConnected()).toBe(true);
    apps[0].die();
    await vi.waitFor(() => expect(n).toBe(2));
    await vi.waitFor(() => expect(socket.isConnected()).toBe(true));
    expect(apps[0].app.stop).toHaveBeenCalled();
    await socket.stop();
  });

  it("stop() cancels an attempt in flight and drops its events", async () => {
    const bolt = makeFakeBolt();
    let finish!: () => void;
    bolt.app.start.mockImplementation(() => new Promise<undefined>(r => { finish = () => r(undefined); }));
    const socket = new SlackSocket({ getIdentity, getTokens: async () => tokens, makeApp: () => bolt.app, sleep: async () => undefined });
    const events: SlackMessageEvent[] = [];
    socket.onMessage(e => events.push(e));
    const started = socket.start();
    await vi.waitFor(() => expect(bolt.app.start).toHaveBeenCalled());
    await socket.stop();
    expect(bolt.app.stop).toHaveBeenCalled();
    finish();
    expect(await started).toBe(false);
    await bolt.message({ ...ownPost, ts: "9.9" });   // superseded generation
    expect(events).toEqual([]);
    expect(socket.isConnected()).toBe(false);
  });

  it("reconnecting counts as disconnected", async () => {
    const { bolt, socket } = setup();
    const seen: boolean[] = [];
    socket.onConnection(c => seen.push(c));
    await socket.start();
    bolt.connection(false);   // the SDK's "reconnecting" state is wired to false by createBoltApp
    expect(socket.isConnected()).toBe(false);
  });
});

describe("createBoltApp", () => {
  it("does no network I/O and leaves no unhandled rejection at construction", async () => {
    const calls: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    const orig = globalThis.fetch;
    globalThis.fetch = (async (...a: unknown[]) => { calls.push(a); throw new Error("no network in unit tests"); }) as never;
    try {
      createBoltApp(tokens, identity);
      await new Promise(r => setTimeout(r, 100));
    } finally { globalThis.fetch = orig; process.off("unhandledRejection", onUnhandled); }
    expect(calls).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  it("builds the real Bolt app in Socket Mode", () => {
    const app = createBoltApp(tokens, identity);
    expect(typeof app.start).toBe("function");
    expect(typeof app.client.users.info).toBe("function");
    expect(() => app.action("nexus.approve", async () => undefined)).not.toThrow();
  });
});

describe("the SDK reconnect path (real SocketModeClient)", () => {
  const platformError = (code: string) => Object.assign(new (WebAPIPlatformError as unknown as new (m: string) => Error)(code), { data: { ok: false, error: code } });
  function client(codes: string[]) {
    const c = new SocketModeClient({ appToken: "xapp-fake", clientPingTimeout: 5, logLevel: undefined });
    let n = 0;
    (c as unknown as { webClient: { apps: { connections: { open: () => Promise<never> } } } }).webClient.apps.connections.open = async () => {
      throw platformError(codes[Math.min(n++, codes.length - 1)]);
    };
    hardenReconnect(c, 3);
    return { c, calls: () => n };
  }
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => { unhandled.push(e); };

  it("settles start() when a recoverable error turns unrecoverable, with no unhandled rejection", async () => {
    process.on("unhandledRejection", onUnhandled);
    try {
      const { c } = client(["internal_error", "invalid_auth"]);
      await expect(c.start()).rejects.toMatchObject({ data: { error: "invalid_auth" } });
      await new Promise(r => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally { process.off("unhandledRejection", onUnhandled); }
  });

  it("stops retrying a recoverable error after the cap and rejects", async () => {
    const { c, calls } = client(["internal_error"]);
    await expect(c.start()).rejects.toThrow(/too many reconnect attempts/);
    expect(calls()).toBe(4);   // the first try plus 3 reconnects
  });

  it("rejects instead of hanging when shut down during a reconnect wait", async () => {
    const c = new SocketModeClient({ appToken: "xapp-fake", clientPingTimeout: 50 });
    (c as unknown as { webClient: { apps: { connections: { open: () => Promise<never> } } } }).webClient.apps.connections.open = async () => { throw platformError("internal_error"); };
    hardenReconnect(c, 3);
    const started = c.start();
    (c as unknown as { shuttingDown: boolean }).shuttingDown = true;
    await expect(started).rejects.toThrow(/shutting down/);
  });
});

describe("SlackSocket first connect", () => {
  it("gives up on a connect that never settles, and stop() abandons one at once", async () => {
    const bolt = makeFakeBolt();
    bolt.app.start.mockImplementation(() => new Promise(() => undefined));
    const timed = new SlackSocket({ getIdentity, getTokens: async () => tokens, makeApp: () => bolt.app, connectTimeoutMs: 30, sleep: () => new Promise(() => undefined) });
    expect(await timed.start()).toBe(false);
    await timed.stop();

    const stuck = new SlackSocket({ getIdentity, getTokens: async () => tokens, makeApp: () => bolt.app, connectTimeoutMs: 60_000, sleep: () => new Promise(() => undefined) });
    const pending = stuck.start();
    await new Promise(r => setTimeout(r, 10));
    const t0 = Date.now();
    await stuck.stop();
    expect(await pending).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
