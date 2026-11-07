import { describe, expect, it, vi } from "vitest";
import { SlackStatus } from "../../contracts";
import { BOT_USER, TEAM, makeFakeBolt, users } from "./fake-bolt.test-util";
import { APPROVE_ACTION_ID } from "./interactivity";
import { createSlackService } from "./slack-service";
import type { SlackMessageEvent, SlackService } from "./types";
import type { SlackApi } from "./web-client";
import type { BotApi } from "./bot";

const tokens = { botToken: "xoxb-SECRET", appToken: "xapp-SECRET" };

function build() {
  const bolt = makeFakeBolt();
  const userApi = {
    auth: { test: vi.fn(async () => ({ user_id: "U_ADRIAN", user: "adrian" })) },
    conversations: {
      list: vi.fn(async () => ({ channels: [{ id: "C1", name: "nexus-demo", is_member: true }] })),
      members: vi.fn(async () => ({ members: [BOT_USER] })),
      history: vi.fn(async () => ({ messages: [{ ts: "1.1", user: "U_ADRIAN", text: "hello" }] })),
      replies: vi.fn(async () => ({ messages: [] })),
    },
    users: { info: vi.fn(async (a: { user: string }) => ({ user: users[a.user] })) },
    chat: { postMessage: vi.fn(async () => ({ ts: "9.1", message: { text: "from me" } })) },
  };
  const botApi = {
    auth: { test: vi.fn(async () => ({ user_id: BOT_USER, user: "nexus", bot_id: "B1", team_id: TEAM })) },
    chat: { postMessage: vi.fn(async () => ({ ts: "9.2" })), update: vi.fn(async (a: { ts: string; text: string }) => ({ ts: a.ts })) },
  };
  const approval = { id: "ap-1", sessionId: "s", action: { kind: "run_command" as const, command: "x" }, reason: "r", requestedAt: "2026-11-07T04:00:00.000Z", slackMessage: { channelId: "C1", ts: "9.2" } };
  const getApproval = vi.fn(() => approval);
  const resolve = vi.fn(async () => ({ won: true, approval: { id: "ap-1", sessionId: "s", action: { kind: "run_command" as const, command: "x" }, reason: "r", requestedAt: "2026-11-07T04:00:00.000Z", decision: "approved" as const, decidedBy: { via: "slack" as const, userId: "U_ADRIAN" } } }));
  const svc = createSlackService({
    getUserToken: async () => ({ token: "xoxp-SECRET", source: "manual" }),
    getBotTokens: async () => tokens,
    resolve, getApproval,
    webOptions: { makeApi: () => userApi as unknown as SlackApi },
    makeBotApi: () => botApi as unknown as BotApi,
    socketOptions: { makeApp: () => bolt.app, sleep: async () => undefined },
  });
  return { svc, bolt, userApi, botApi, resolve };
}

describe("createSlackService", () => {
  it("implements the whole SlackService interface", () => {
    const svc: SlackService = build().svc;
    for (const m of ["postAsUser", "postAsBot", "updateBotMessage", "channels", "history", "getThread", "users", "status", "onMessage"] as const) expect(typeof svc[m]).toBe("function");
  });

  it("reads and posts as the user through the user token; bot posts use the bot token only", async () => {
    const { svc, userApi, botApi } = build();
    expect(await svc.channels()).toEqual([expect.objectContaining({ id: "C1", botIsMember: true })]);   // the bot's id reached the web client
    expect((await svc.history("C1")).messages[0].text).toBe("hello");
    const mine = await svc.postAsUser({ channelId: "C1", text: "from me" });
    expect(mine).toMatchObject({ sentVia: "user", author: { id: "U_ADRIAN" } });
    const agent = await svc.postAsBot({ channelId: "C1", text: "progress", threadTs: "1.1" });
    expect(agent).toMatchObject({ sentVia: "bot", author: { id: BOT_USER, isBot: true } });
    await svc.updateBotMessage("C1", "9.2", "progress 2");
    expect(userApi.chat.postMessage).toHaveBeenCalledTimes(1);   // the agent never used the user token
    expect(botApi.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(botApi.chat.update).toHaveBeenCalledTimes(1);
  });

  it("status combines the socket, the user identity and the bot name", async () => {
    const { svc } = build();
    expect(SlackStatus.parse(await svc.status())).toEqual({ connected: false, postsAs: { userId: "U_ADRIAN", name: "adrian" }, userTokenSource: "manual", botName: "nexus" });
    await svc.start();
    expect((await svc.status()).connected).toBe(true);
  });

  it("feeds live messages and status changes to subscribers, filtered by channel", async () => {
    const { svc, bolt } = build();
    await svc.start();
    const all: SlackMessageEvent[] = [], other: SlackMessageEvent[] = [];
    const sub = svc.onMessage(e => all.push(e), ["C1"]);
    svc.onMessage(e => other.push(e), ["C9"]);
    await bolt.message({ type: "message", channel: "C1", user: "U_BRANDON", ts: "40.1", text: "live" });
    bolt.connection(false);
    await vi.waitFor(() => expect(all.map(e => e.type)).toEqual(["message", "status"]));
    expect(other.map(e => e.type)).toEqual(["status"]);
    expect(all[1]).toMatchObject({ status: { connected: false } });
    sub.dispose();
    await bolt.message({ type: "message", channel: "C1", user: "U_BRANDON", ts: "40.2", text: "later" });
    expect(all).toHaveLength(2);
  });

  it("wires the approval buttons: a human click resolves and edits the card via the bot", async () => {
    const { svc, bolt, resolve, botApi } = build();
    await svc.start();
    await bolt.click(APPROVE_ACTION_ID, { body: { team: { id: TEAM }, user: { id: "U_ADRIAN" }, container: { channel_id: "C1", message_ts: "9.2" }, message: { ts: "9.2", user: BOT_USER, bot_id: "B1" } }, action: { block_id: "nexus.approval", value: "ap-1" } });
    expect(resolve).toHaveBeenCalledWith("ap-1", "approved", { via: "slack", userId: "U_ADRIAN" });
    expect(botApi.chat.update).toHaveBeenCalledWith(expect.objectContaining({ channel: "C1", ts: "9.2" }));
    await bolt.click(APPROVE_ACTION_ID, { body: { team: { id: TEAM }, user: { id: BOT_USER }, container: { channel_id: "C1", message_ts: "9.2" }, message: { ts: "9.2", user: BOT_USER, bot_id: "B1" } }, action: { block_id: "nexus.approval", value: "ap-1" } });
    expect(resolve).toHaveBeenCalledTimes(1);
    await svc.stop();
  });

  it("posts an approval card with working buttons through postApproval", async () => {
    const { svc, botApi } = build();
    await svc.postApproval("C1", { id: "ap-1", sessionId: "s", action: { kind: "commit", message: "fix" }, reason: "done", requestedAt: "2026-11-07T04:00:00.000Z" });
    const call = botApi.chat.postMessage.mock.calls[0] as unknown as [{ blocks: { type: string }[] }];
    expect(call[0].blocks.at(-1)?.type).toBe("actions");
  });

  it("reuses one web client while the bot token cannot answer, instead of rebuilding per call", async () => {
    const { userApi } = build();
    const makeApi = vi.fn(() => userApi as unknown as SlackApi);
    const svc = createSlackService({ getUserToken: async () => ({ token: "xoxp-SECRET", source: "manual" }), getBotTokens: async () => null, resolve: vi.fn(), getApproval: () => undefined, webOptions: { makeApi } });
    await svc.channels(); await svc.channels(); await svc.history("C1");
    expect(makeApi).toHaveBeenCalledTimes(2);   // one reader and one poster, built once
  });

  it("no token reaches an error", async () => {
    const svc = createSlackService({ getUserToken: async () => null, getBotTokens: async () => null, resolve: vi.fn(), getApproval: () => undefined });
    const errs: string[] = [];
    await svc.channels().catch(e => errs.push(String(e)));
    await svc.postAsBot({ channelId: "C", text: "x" }).catch(e => errs.push(String(e)));
    expect(errs).toEqual(["Error: no slack user token", "Error: no slack bot token"]);
    expect(await svc.status()).toMatchObject({ connected: false, postsAs: null, userTokenSource: "none" });
  });
});
