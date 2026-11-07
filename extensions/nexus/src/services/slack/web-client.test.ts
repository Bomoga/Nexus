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
            { type: "message", team: "T1", ts: "2.000000", user: "U_BOT", bot_id: "B1", app_id: "A1", bot_profile: { id: "B1", name: "Nexus" }, text: "approve?", blocks: [{ type: "actions", elements: [{ type: "button" }] }] },
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
function client(api: Fake = makeFake(), token: { token: string; source: "manual" } | null = { token: "xoxp-test", source: "manual" }, poster: Fake = makeFake()) {
  const makeApi = vi.fn((_t: string, kind: string) => (kind === "post" ? poster : api) as unknown as SlackApi);
  return { api, poster, makeApi, c: new SlackWebClient({ getToken: async () => token, botUserId: "U_BOT", makeApi }) };
}

describe("extractCodeRefs", () => {
  it("extracts refs from slack-wrapped and bare links", () => {
    expect(extractCodeRefs(`see <${link}|x>, <${link}> and ${link}.`)).toEqual([fx.codeRef, fx.codeRef, fx.codeRef]);
  });
  it("never throws on a malformed percent escape and ignores bad links", () => {
    expect(() => extractCodeRefs(`nexus://coderef/ws/${SHA}/1-2/%E0%A4%A`)).not.toThrow();
    expect(extractCodeRefs(`nexus://coderef/ws/${SHA}/1-2/%E0%A4%A nexus://coderef/bad`)).toEqual([]);
  });
  it("keeps parentheses in paths but not a closing paren or punctuation around a bare link", () => {
    const ref = { ...fx.codeRef, path: "app/(auth)/page.tsx" };
    const l = encodeCodeRef(ref);
    expect(extractCodeRefs(l)).toEqual([ref]);
    expect(extractCodeRefs(`(see ${l})`)).toEqual([ref]);
    expect(extractCodeRefs(`${l}, then ${l}.`)).toEqual([ref, ref]);
  });
  it("reads the extension-id spelling of a link, wrapped and bare", () => {
    const withId = link.replace("nexus://coderef/", "nexus://nexus.nexus/coderef/");
    expect(extractCodeRefs(`<${withId}|label> and ${withId}.`)).toEqual([fx.codeRef, fx.codeRef]);
  });
  it("ends a bare link at quotes, brackets, backticks, ellipsis and escaped >", () => {
    for (const [pre, post] of [['"', '"'], ["`", "`"], ["[", "]"], ["{", "}"], ["", "…"], ["", "&gt;"]]) {
      expect(extractCodeRefs(`${pre}${link}${post}`)).toEqual([fx.codeRef]);
    }
  });
  it("takes wrapped links exactly, with no trimming", () => {
    for (const path of ["a~", "a!", "a.", "a*", "a)"]) {
      const ref = { ...fx.codeRef, path };
      expect(extractCodeRefs(`<${encodeCodeRef(ref)}|label>`)).toEqual([ref]);
      expect(extractCodeRefs(`<${encodeCodeRef(ref)}>`)).toEqual([ref]);
    }
  });
  it("is linear on adversarial input", () => {
    const t = Date.now();
    extractCodeRefs(`nexus://coderef/${")".repeat(40_000)}`);
    extractCodeRefs(`${"<nexus://coderef/a|".repeat(2_000)}`);
    extractCodeRefs(`nexus://coderef/${"a)(".repeat(13_000)}.!~`);
    extractCodeRefs(`nexus://coderef/${")".repeat(100_000)}b`);
    extractCodeRefs("<nexus://coderef/a".repeat(20_000));
    expect(Date.now() - t).toBeLessThan(500);
  });
  it("skips a link over the length cap and keeps one under it", () => {
    const under = { ...fx.codeRef, path: "a".repeat(1_900) };
    const over = { ...fx.codeRef, path: "a".repeat(2_100) };
    expect(extractCodeRefs(`<${encodeCodeRef(under)}>`)).toEqual([under]);
    expect(extractCodeRefs(`<${encodeCodeRef(over)}>`)).toEqual([]);
    expect(extractCodeRefs(encodeCodeRef(over))).toEqual([]);
  });
  it("keeps a balanced closing paren and trims trailing mrkdwn from a bare link", () => {
    const ref = { ...fx.codeRef, path: "a(b)" };
    expect(extractCodeRefs(encodeCodeRef(ref))).toEqual([ref]);
    for (const end of ["~", "*", "!", "'", "."]) expect(extractCodeRefs(`${link}${end}`)).toEqual([fx.codeRef]);
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

  it("reads a person's own Nexus post (user + bot_id + app_id + bot_profile, no client_msg_id) as human", async () => {
    const own = { type: "message", team: "T1", ts: "5.000000", user: "U_ADRIAN", bot_id: "B1", app_id: "A1", bot_profile: { id: "B1", name: "Nexus" }, text: "mine", blocks: [{ type: "rich_text" }] };
    const api = makeFake();
    api.conversations.history.mockResolvedValue({ messages: [own] } as never);
    const m = (await client(api).c.history("C1")).messages[0];
    expect(ChatMessage.parse(m)).toMatchObject({ sentVia: "user", author: { isBot: false } });
    expect(m.blocks).toBeUndefined();
    const failing = makeFake();
    failing.conversations.history.mockResolvedValue({ messages: [own] } as never);
    failing.users.info.mockRejectedValue(new Error("down"));
    expect((await client(failing).c.history("C1")).messages[0]).toMatchObject({ sentVia: "bot" });   // fallback when the lookup failed
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
    expect(b.poster.chat.postMessage).not.toHaveBeenCalled();
  });

  it("posts as the user, returns Slack's confirmed text and code refs from it", async () => {
    const { c, api, poster } = client();
    poster.chat.postMessage.mockResolvedValue({ ts: "9.000100", message: { text: `<${link}|ref>` } });
    const m = ChatMessage.parse(await c.postAsUser({ channelId: "C1", text: "hi", threadTs: "3.000000", clientId: "k1" }));
    expect(api.chat.postMessage).not.toHaveBeenCalled();
    expect(poster.chat.postMessage).toHaveBeenCalledWith({ channel: "C1", text: "hi", thread_ts: "3.000000" });
    expect(m).toMatchObject({ id: "C1:9.000100", sentVia: "user", threadTs: "3.000000", author: { id: "U_ADRIAN", isBot: false }, text: `<${link}|ref>`, codeRefs: [fx.codeRef], clientId: "k1" });
    expect("clientId" in ChatMessage.parse(await c.postAsUser({ channelId: "C1", text: "hi" }))).toBe(false);
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
    const bad = client();
    bad.poster.chat.postMessage.mockRejectedValue(Object.assign(new Error("xoxp-test boom"), { data: { error: "channel_not_found" } }));
    const err = await bad.c.postAsUser({ channelId: "C1", text: "x" }).catch((e: Error) => e);
    expect((err as Error).message).toBe("slack chat.postMessage failed: channel_not_found");
    const ok = client();
    ok.poster.chat.postMessage.mockResolvedValue({ ts: "9.1", message: { text: `nexus://coderef/ws/${SHA}/1-2/%E0%A4%A` } });
    expect((await ok.c.postAsUser({ channelId: "C1", text: "x" })).codeRefs).toEqual([]);
  });

  it("bounds the members fan-out in channels()", async () => {
    const api = makeFake();
    api.conversations.list.mockImplementation(async () => ({ channels: Array.from({ length: 20 }, (_, i) => ({ id: `C${i}`, name: `c${i}`, is_member: true })) }) as never);
    let live = 0, peak = 0;
    api.conversations.members.mockImplementation(async () => { peak = Math.max(peak, ++live); await new Promise(r => setTimeout(r, 2)); live--; return { members: [] }; });
    expect(await client(api).c.channels()).toHaveLength(20);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("does not pass a rejecting token provider's message through", async () => {
    const c = new SlackWebClient({ getToken: async () => { throw new Error("vault said xoxp-SECRET"); }, makeApi: () => makeFake() as unknown as SlackApi });
    expect(await c.status()).toEqual({ postsAs: null, userTokenSource: "none" });
    const err = await c.channels().catch((e: Error) => e);
    expect((err as Error).message).toBe("no slack user token");
    expect(String(err)).not.toContain("SECRET");
  });

  it("discards a stale auth.test after the token changed", async () => {
    let token = "xoxp-A";
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const fakes: Record<string, Fake> = { "xoxp-A": makeFake(), "xoxp-B": makeFake() };
    fakes["xoxp-A"].auth.test.mockImplementation(async () => { await gate; return { user_id: "U_A", user: "a" }; });
    fakes["xoxp-B"].auth.test.mockResolvedValue({ user_id: "U_B", user: "b" });
    const c = new SlackWebClient({ getToken: async () => ({ token, source: "manual" as const }), makeApi: t => fakes[t] as unknown as SlackApi });
    const stale = c.status();
    await new Promise(r => setTimeout(r, 0));
    token = "xoxp-B";
    expect((await c.status()).postsAs?.userId).toBe("U_B");
    release();
    expect((await stale).postsAs).toBeNull();
    expect((await c.status()).postsAs?.userId).toBe("U_B");
  });

  it("discards a stale auth.test when two calls straddle a swap in the same tick", async () => {
    let token = "xoxp-A";
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const fakes: Record<string, Fake> = { "xoxp-A": makeFake(), "xoxp-B": makeFake() };
    fakes["xoxp-A"].auth.test.mockImplementation(async () => { await gate; return { user_id: "U_A", user: "a" }; });
    fakes["xoxp-B"].auth.test.mockResolvedValue({ user_id: "U_B", user: "b" });
    const c = new SlackWebClient({ getToken: async () => ({ token, source: "manual" as const }), makeApi: t => fakes[t] as unknown as SlackApi });
    const first = c.status();
    token = "xoxp-B";
    const second = c.status();
    release();
    await Promise.all([first, second]);
    expect((await c.status()).postsAs?.userId).toBe("U_B");
  });

  it("drops the identity on a swap after auth.test completed", async () => {
    let token = "xoxp-A";
    const fakes: Record<string, Fake> = { "xoxp-A": makeFake(), "xoxp-B": makeFake() };
    fakes["xoxp-A"].auth.test.mockResolvedValue({ user_id: "U_A", user: "a" });
    fakes["xoxp-B"].auth.test.mockResolvedValue({ user_id: "U_B", user: "b" });
    const c = new SlackWebClient({ getToken: async () => ({ token, source: "manual" as const }), makeApi: t => fakes[t] as unknown as SlackApi });
    expect((await c.status()).postsAs?.userId).toBe("U_A");
    token = "xoxp-B";
    expect((await c.status()).postsAs?.userId).toBe("U_B");
  });

  it("never forwards a Slack error field that is not a plain code", async () => {
    const api = makeFake();
    api.conversations.list.mockRejectedValue({ code: "slack_webapi_platform_error", data: { error: "invalid_auth xoxp-SECRET" } });
    const err = await client(api).c.channels().catch((e: Error) => e) as Error;
    expect(err.message).not.toContain("SECRET");
    expect(err.message).toContain("slack_webapi_platform_error");
    api.conversations.list.mockRejectedValue({ code: "slack_webapi_platform_error", data: { error: "invalid_auth" } });
    expect((await client(api).c.channels().catch((e: Error) => e) as Error).message).toContain(": invalid_auth");
  });

  it("de-duplicates thread messages across pages", async () => {
    const api = makeFake();
    api.conversations.replies.mockImplementation((async (a: { cursor?: string }) => a.cursor
      ? { messages: [{ ...base, ts: "3.000000", user: "U_ADRIAN", text: "dup" }, { ...base, ts: "3.100000", thread_ts: "3.000000", user: "U_ADRIAN", text: "r" }] }
      : { messages: [{ ...base, ts: "3.000000", user: "U_ADRIAN", text: "p" }], response_metadata: { next_cursor: "r2" } }) as never);
    expect((await client(api).c.getThread("C1", "3.000000")).messages.map(m => m.ts)).toEqual(["3.000000", "3.100000"]);
  });

  it("maps rate limit and timeout failures without the token, and drops a repeated history cursor", async () => {
    const rl = makeFake();
    rl.conversations.list.mockRejectedValue(Object.assign(new Error("xoxp-test"), { code: "slack_webapi_rate_limited_error", retryAfter: 30 }));
    expect(((await client(rl).c.channels().catch((e: Error) => e)) as Error).message).toBe("slack conversations.list failed: rate_limited (retry after 30s)");
    const to = makeFake();
    to.conversations.history.mockRejectedValue(Object.assign(new Error("xoxp-test"), { code: "slack_webapi_request_error", original: { name: "TimeoutError" } }));
    expect(((await client(to).c.history("C1").catch((e: Error) => e)) as Error).message).toBe("slack conversations.history failed: timeout");
    const loop = makeFake();
    loop.conversations.history.mockResolvedValue({ messages: [], response_metadata: { next_cursor: "same" } });
    expect((await client(loop).c.history("C1", "same")).nextCursor).toBeUndefined();
  });
});
