import { describe, expect, it, vi } from "vitest";
import { ChatMessage, encodeCodeRef } from "../../contracts";
import { SlackBot, type BotApi } from "./bot";
import { webClientOptions } from "./web-client";

function fakeApi() {
  return {
    auth: { test: vi.fn(async () => ({ user_id: "U_BOT", user: "nexus", bot_id: "B1" })) },
    chat: {
      postMessage: vi.fn(async (a: { text: string }) => ({ ts: "20.000100", message: { text: `${a.text} (confirmed)` } })),
      update: vi.fn(async (a: { ts: string; text: string }) => ({ ts: a.ts, message: { text: a.text, thread_ts: "20.000001" } })),
    },
  };
}
const make = (api = fakeApi(), tokens: { botToken: string; appToken: string } | null = { botToken: "xoxb-SECRET", appToken: "xapp-SECRET" }) => {
  const makeApi = vi.fn((_t: string) => api as unknown as BotApi);
  return { api, makeApi, bot: new SlackBot({ getTokens: async () => tokens, makeApi }) };
};

describe("SlackBot", () => {
  it("posts as the bot with sentVia bot and a contract-valid message", async () => {
    const { bot, api, makeApi } = make();
    const m = await bot.postAsBot({ channelId: "C1", text: "working", threadTs: "19.000100", clientId: "c1" });
    expect(api.chat.postMessage).toHaveBeenCalledWith({ channel: "C1", text: "working", thread_ts: "19.000100" });
    expect(makeApi).toHaveBeenCalledWith("xoxb-SECRET");
    expect(ChatMessage.parse(m)).toEqual(m);
    expect(m).toMatchObject({ id: "C1:20.000100", threadTs: "19.000100", sentVia: "bot", text: "working (confirmed)", clientId: "c1", author: { id: "U_BOT", name: "nexus", isBot: true } });
  });

  it("serves display text with code refs taken from the raw text", async () => {
    const { bot } = make();
    const ref = { workspaceId: "w", commit: "a".repeat(40), path: "src/a.ts", startLine: 3, endLine: 5 };
    const m = await bot.postAsBot({ channelId: "C1", text: `see <${encodeCodeRef(ref)}|src/a.ts:3-5> &lt;b&gt;` });
    expect(m.text).toBe("see src/a.ts:3-5 <b> (confirmed)");
    expect(m.codeRefs).toEqual([ref]);
  });

  it("posts Block Kit blocks and returns them on the message", async () => {
    const { bot, api } = make();
    const blocks = [{ type: "actions" }];
    const m = await bot.postAsBot({ channelId: "C1", text: "approve?", blocks });
    expect(api.chat.postMessage).toHaveBeenCalledWith({ channel: "C1", text: "approve?", blocks });
    expect(m.blocks).toEqual(blocks);
    await expect(bot.postAsBot({ channelId: "C1", text: "x", blocks: "nope" })).rejects.toThrow("blocks must be an array");
    await expect(bot.postAsBot({ channelId: "C1", text: "  " })).rejects.toThrow("empty message");
  });

  it("edits in place, clearing blocks when none are given", async () => {
    const { bot, api } = make();
    const m = await bot.updateBotMessage("C1", "20.000100", "done: 3/3");
    expect(api.chat.update).toHaveBeenCalledWith({ channel: "C1", ts: "20.000100", text: "done: 3/3", blocks: [] });
    expect(m).toMatchObject({ id: "C1:20.000100", threadTs: "20.000001", text: "done: 3/3", sentVia: "bot" });
    await bot.updateBotMessage("C1", "20.000100", "t", [{ type: "section" }]);
    expect(api.chat.update).toHaveBeenLastCalledWith({ channel: "C1", ts: "20.000100", text: "t", blocks: [{ type: "section" }] });
  });

  it("never retries a post: one call per attempt, and the real client is built with retries 0", async () => {
    const { bot, api } = make();
    api.chat.postMessage.mockRejectedValueOnce({ code: "slack_webapi_platform_error", data: { error: "not_in_channel" }, message: "xoxb-SECRET leaked" });
    await expect(bot.postAsBot({ channelId: "C1", text: "x" })).rejects.toThrow("slack chat.postMessage failed: not_in_channel");
    expect(api.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(webClientOptions("post")?.retryConfig).toEqual({ retries: 0 });
  });

  it("no token appears in any error", async () => {
    const { bot, api } = make();
    api.chat.update.mockRejectedValueOnce(new Error("Authorization: Bearer xoxb-SECRET"));
    api.auth.test.mockRejectedValueOnce(new Error("xoxb-SECRET"));
    const errors: string[] = [];
    for (const f of [() => bot.updateBotMessage("C1", "1.1", "x"), () => bot.updateBotMessage("C1", "1.1", "x")]) {
      try { await f(); } catch (e) { errors.push(String(e)); }
    }
    const none = make(undefined, null);
    await none.bot.postAsBot({ channelId: "C1", text: "x" }).catch(e => errors.push(String(e)));
    expect(errors).toHaveLength(3);
    expect(errors.join()).not.toMatch(/xoxb|SECRET|Bearer/);
  });

  it("refuses to post without a bot token and rebuilds the client when the token changes", async () => {
    let t = { botToken: "xoxb-1", appToken: "xapp-1" };
    const apis: string[] = [];
    const bot = new SlackBot({ getTokens: async () => t, makeApi: tok => { apis.push(tok); return fakeApi() as unknown as BotApi; } });
    await bot.postAsBot({ channelId: "C", text: "a" });
    await bot.postAsBot({ channelId: "C", text: "b" });
    t = { botToken: "xoxb-2", appToken: "xapp-1" };
    await bot.postAsBot({ channelId: "C", text: "c" });
    expect(apis).toEqual(["xoxb-1", "xoxb-2"]);
  });
});
