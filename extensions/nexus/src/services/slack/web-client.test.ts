import { describe, expect, it, vi } from "vitest";
import { Channel, ChatMessage, SlackUser, Thread, encodeCodeRef } from "../../contracts";
import { fx } from "../../contracts/fixtures";
import { extractCodeRefs, SlackWebClient, webClientOptions, type SlackApi } from "./web-client";

const link = encodeCodeRef(fx.codeRef);
const SHA = fx.codeRef.commit;
const base = { type: "message", team: "T1", client_msg_id: "7c1f-uuid", blocks: [{ type: "rich_text", block_id: "b1", elements: [] }] };

function makeFake() {
  return {
    auth: { test: vi.fn(async () => ({ ok: true, user_id: "U_ADRIAN", user: "adrian", team_id: "T1" } as { user_id?: string; user?: string; bot_id?: string })) },
    conversations: {
      list: vi.fn(async (a: { cursor?: string }) => a.cursor
        ? { channels: [{ id: "C2", name: "nexus-build", is_member: true }], response_metadata: { next_cursor: "" } }
        : { channels: [{ id: "C1", name: "nexus-demo", is_member: true, is_private: false }, { id: "C9", name: "other", is_member: false }], response_metadata: { next_cursor: "p2" } }),
      members: vi.fn(async (a: { channel: string; cursor?: string }) => a.channel === "C1"
        ? (a.cursor ? { members: ["U_BOT"] } : { members: ["U_ADRIAN"], response_metadata: { next_cursor: "m2" } })
        : { members: ["U_ADRIAN"] }),
      history: vi.fn(async (a: { cursor?: string }) => a.cursor
        ? { messages: [{ ...base, ts: "1.000000", user: "U_ADRIAN", text: "old" }] }
        : { messages: [
            { ...base, ts: "3.000000", thread_ts: "3.000000", user: "U_ADRIAN", text: `bug <${link}|here>`, reply_count: 2 },
            { type: "message", subtype: "bot_message", ts: "2.000000", user: "U_BOT", bot_id: "B1", username: "Nexus", text: "approve?", blocks: [{ type: "actions", elements: [{ type: "button" }] }] },
            { ...base, subtype: "channel_join", ts: "2.500000", user: "U_NEW", text: "<@U_NEW> has joined the channel" },
          ], response_metadata: { next_cursor: "page2" } }),
      replies: vi.fn(async (a: { cursor?: string }) => a.cursor
        ? { messages: [{ ...base, ts: "3.100000", thread_ts: "3.000000", user: "U_ADRIAN", text: "reply" }] }
        : { messages: [{ ...base, ts: "3.000000", thread_ts: "3.000000", user: "U_ADRIAN", text: "parent", reply_count: 1 }], response_metadata: { next_cursor: "r2" } }),
    },
    users: { info: vi.fn(async (a: { user: string }) => a.user === "U_BOT"
      ? { user: { id: "U_BOT", name: "nexus", is_bot: true, profile: { display_name: "Nexus" } } }
      : { user: { id: a.user, name: "adrian", is_bot: false, profile: { display_name: "Adrian", image_72: "https://x/a.png" } } }) },
    chat: { postMessage: vi.fn(async () => ({ ok: true, ts: "9.000100", message: { text: "hi (confirmed)" } } as { ts?: string; message?: { text?: string } })) },
  };
}

type Fake = ReturnType<typeof makeFake>;
function client(api: Fake = makeFake(), token: { token: string; source: "manual" } | null = { token: "xoxp-test", source: "manual" }) {
  const makeApi = vi.fn((_t: string, _k: string) => api as unknown as SlackApi);
  return { api, makeApi, c: new SlackWebClient({ getToken: async () => token, botUserId: "U_BOT", makeApi }) };
}

describe("extractCodeRefs", () => {
  it("extracts refs from slack-wrapped and bare links", () => {
    expect(extractCodeRefs(`see <${link}|x> and ${link}.`)).toEqual([fx.codeRef, fx.codeRef]);
  });
  it("never throws on a malformed percent escape and ignores bad links", () => {
    expect(() => extractCodeRefs(`nexus://coderef/ws/${SHA}/1-2/%E0%A4%A`)).not.toThrow();
    expect(extractCodeRefs(`nexus://coderef/ws/${SHA}/1-2/%E0%A4%A nexus://coderef/bad`)).toEqual([]);
  });
  it("keeps parentheses in paths but not a closing paren or punctuation around the link", () => {
    const ref = { ...fx.codeRef, path: "app/(auth)/page.tsx" };
    const l = encodeCodeRef(ref);
    expect(l).toContain("(auth)");
    expect(extractCodeRefs(l)).toEqual([ref]);
    expect(extractCodeRefs(`(see ${l})`)).toEqual([ref]);
    expect(extractCodeRefs(`${l}, then ${l}.`)).toEqual([ref, ref]);
  });
});

describe("SlackWebClient", () => {
  it("pages channels, keeps member channels, finds the bot across member pages", async () => {
    const { c } = client();
    const chans = await c.channels();
    expect(chans.map(x => Channel.parse(x))).toEqual([
      { id: "C1", name: "nexus-demo", isPrivate: false, isMember: true, botIsMember: true },
      { id: "C2", name: "nexus-build", isPrivate: false, isMember: true, botIsMember: false },
    ]);
  });

  it("pages history, maps messages to contracts, bot identity and blocks", async () => {
    const { c, api } = client();
    const p1 = await c.history("C1", undefined, 3);
    expect(p1.nextCursor).toBe("page2");
    expect(p1.messages.map(m => ChatMessage.parse(m).id)).toEqual(["C1:3.000000", "C1:2.000000"]);   // channel_join dropped although it has a user
    expect(p1.messages[0]).toMatchObject({ codeRefs: [fx.codeRef], replyCount: 2, sentVia: "user", author: { name: "adrian", isBot: false } });
    expect(p1.messages[0].blocks).toBeUndefined();   // humans' blocks are not mapped
    expect(p1.messages[0].text).toContain("<nexus://");   // verbatim
    expect(p1.messages[1]).toMatchObject({ sentVia: "bot", author: { id: "U_BOT", name: "nexus", isBot: true } });
    expect(p1.messages[1].blocks).toEqual([{ type: "actions", elements: [{ type: "button" }] }]);
    const p2 = await c.history("C1", "page2");
    expect(p2.nextCursor).toBeUndefined();
    expect(api.conversations.history).toHaveBeenLastCalledWith({ channel: "C1", limit: 50, cursor: "page2" });
    expect(api.users.info).toHaveBeenCalledTimes(2);   // U_ADRIAN and U_BOT, cached after
  });

  it("treats a message as bot when users.info fails (bot_id present)", async () => {
    const api = makeFake();
    api.users.info.mockRejectedValue(new Error("ratelimited"));
    const { c } = client(api);
    const p = await c.history("C1", undefined, 3);
    expect(p.messages[1]).toMatchObject({ sentVia: "bot", author: { isBot: true } });
    await c.history("C1", undefined, 3);
    expect(api.users.info).toHaveBeenCalledTimes(2);   // failed lookups negatively cached
  });

  it("pages a thread through the replies cursor", async () => {
    const { c } = client();
    const t = Thread.parse(await c.getThread("C1", "3.000000"));
    expect(t.messages.map(m => m.ts)).toEqual(["3.000000", "3.100000"]);
    expect(t.messages.map(m => m.threadTs)).toEqual([undefined, "3.000000"]);
  });

  it("stops on a repeated cursor and at the page cap (list, replies, members)", async () => {
    const api = makeFake();
    api.conversations.list.mockImplementation(async () => ({ channels: [{ id: "C1", name: "a", is_member: true }], response_metadata: { next_cursor: "same" } }));
    api.conversations.replies.mockImplementation(async () => ({ messages: [], response_metadata: { next_cursor: "same" } }));
    api.conversations.members.mockImplementation(async () => ({ members: [], response_metadata: { next_cursor: "same" } }));
    const { c } = client(api);
    expect((await c.channels())[0].botIsMember).toBe(false);
    await c.getThread("C1", "1.0");
    expect(api.conversations.list).toHaveBeenCalledTimes(2);
    expect(api.conversations.replies).toHaveBeenCalledTimes(2);
    expect(api.conversations.members).toHaveBeenCalledTimes(4);   // 2 member channels x 2 pages each

    let n = 0;
    api.conversations.replies.mockClear();
    api.conversations.replies.mockImplementation(async () => ({ messages: [], response_metadata: { next_cursor: `c${n++}` } }));
    await c.getThread("C1", "1.0");
    expect(api.conversations.replies).toHaveBeenCalledTimes(50);
  });

  it("bounds users.info concurrency", async () => {
    const api = makeFake();
    let live = 0, peak = 0;
    api.users.info.mockImplementation(async (a: { user: string }) => {
      peak = Math.max(peak, ++live); await new Promise(r => setTimeout(r, 2)); live--;
      return { user: { id: a.user, name: a.user, is_bot: false, profile: {} } } as never;
    });
    const { c } = client(api);
    const ids = Array.from({ length: 20 }, (_, i) => `U${i}`);
    expect((await c.users(ids)).map(u => SlackUser.parse(u).id)).toEqual(ids);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("reports postsAs from auth.test and the token source; a bot token never verifies", async () => {
    expect(await client().c.status()).toEqual({ postsAs: { userId: "U_ADRIAN", name: "adrian" }, userTokenSource: "manual" });
    expect(await client(undefined, null).c.status()).toEqual({ postsAs: null, userTokenSource: "none" });
    const bad = makeFake(); bad.auth.test.mockRejectedValue(new Error("invalid_auth"));
    expect((await client(bad).c.status()).postsAs).toBeNull();
    const bot = makeFake(); bot.auth.test.mockResolvedValue({ user_id: "U_BOT", user: "nexus", bot_id: "B1" });
    const b = client(bot);
    expect((await b.c.status()).postsAs).toBeNull();
    await expect(b.c.postAsUser({ channelId: "C1", text: "x" })).rejects.toThrow("not verified");
    expect(bot.chat.postMessage).not.toHaveBeenCalled();
  });

  it("posts as the user, returns Slack's confirmed text and code refs from it", async () => {
    const { c, api } = client();
    api.chat.postMessage.mockResolvedValue({ ts: "9.000100", message: { text: `<${link}|ref>` } });
    const m = ChatMessage.parse(await c.postAsUser({ channelId: "C1", text: "hi", threadTs: "3.000000", clientId: "k1" }));
    expect(api.chat.postMessage).toHaveBeenCalledWith({ channel: "C1", text: "hi", thread_ts: "3.000000" });
    expect(m).toMatchObject({ id: "C1:9.000100", sentVia: "user", threadTs: "3.000000", author: { id: "U_ADRIAN", isBot: false }, text: `<${link}|ref>`, codeRefs: [fx.codeRef] });
  });

  it("posting uses the no-retry client and reads use the retrying client", async () => {
    const { c, makeApi } = client();
    await c.postAsUser({ channelId: "C1", text: "x" });
    expect(makeApi.mock.calls.map(x => x[1]).sort()).toEqual(["post", "read"]);
    expect(webClientOptions("post")).toMatchObject({ retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 15_000 });
    expect(webClientOptions("read")).toMatchObject({ retryConfig: { retries: 2 }, rejectRateLimitedCalls: true, timeout: 15_000 });
  });

  it("never leaks the token in errors and still works if a malformed link comes back", async () => {
    await expect(client(undefined, null).c.postAsUser({ channelId: "C1", text: "x" })).rejects.toThrow("no slack user token");
    const bad = makeFake();
    bad.chat.postMessage.mockRejectedValue(Object.assign(new Error("xoxp-test boom"), { data: { error: "channel_not_found" } }));
    const err = await client(bad).c.postAsUser({ channelId: "C1", text: "x" }).catch((e: Error) => e);
    expect((err as Error).message).toBe("slack chat.postMessage failed: channel_not_found");
    const ok = makeFake();
    ok.chat.postMessage.mockResolvedValue({ ts: "9.1", message: { text: `nexus://coderef/ws/${SHA}/1-2/%E0%A4%A` } });
    expect((await client(ok).c.postAsUser({ channelId: "C1", text: "x" })).codeRefs).toEqual([]);
  });
});
