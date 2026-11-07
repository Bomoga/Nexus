import { describe, expect, it, vi } from "vitest";
import { encodeCodeRef } from "../../contracts";
import { fx } from "../../contracts/fixtures";
import { extractCodeRefs, SlackWebClient, type SlackApi } from "./web-client";

const link = encodeCodeRef(fx.codeRef);

function makeFake() {
  const api = {
    auth: { test: vi.fn(async () => ({ user_id: "U_ADRIAN", user: "adrian" })) },
    conversations: {
      list: vi.fn(async (a: { cursor?: string }) => a.cursor
        ? { channels: [{ id: "C2", name: "nexus-build", is_member: true }], response_metadata: { next_cursor: "" } }
        : { channels: [{ id: "C1", name: "nexus-demo", is_member: true, is_private: false }, { id: "C9", name: "other", is_member: false }], response_metadata: { next_cursor: "p2" } }),
      members: vi.fn(async (a: { channel: string }) => ({ members: a.channel === "C1" ? ["U_ADRIAN", "U_BOT"] : ["U_ADRIAN"] })),
      history: vi.fn(async (a: { cursor?: string }) => a.cursor
        ? { messages: [{ ts: "1.000000", user: "U_ADRIAN", text: "old" }] }
        : { messages: [
            { ts: "3.000000", thread_ts: "3.000000", user: "U_ADRIAN", text: `bug <${link}|here>`, reply_count: 2 },
            { ts: "2.000000", bot_id: "B1", username: "Nexus", text: "progress" },
            { ts: "2.500000", subtype: "channel_join", text: "joined" },
          ], response_metadata: { next_cursor: "page2" } }),
      replies: vi.fn(async () => ({ messages: [
        { ts: "3.000000", thread_ts: "3.000000", user: "U_ADRIAN", text: "parent", reply_count: 1 },
        { ts: "3.100000", thread_ts: "3.000000", user: "U_ADRIAN", text: "reply" } ] })),
    },
    users: { info: vi.fn(async (a: { user: string }) => ({ user: { id: a.user, name: "adrian", is_bot: false, profile: { display_name: "Adrian", image_72: "https://x/a.png" } } })) },
    chat: { postMessage: vi.fn(async () => ({ ts: "9.000100" })) },
  };
  return api;
}

function client(api = makeFake(), token: { token: string; source: "manual" } | null = { token: "xoxp-test", source: "manual" }) {
  return { api, c: new SlackWebClient({ getToken: async () => token, botUserId: "U_BOT", makeApi: () => api as unknown as SlackApi }) };
}

describe("SlackWebClient", () => {
  it("extracts code refs and ignores malformed links", () => {
    expect(extractCodeRefs(`see <${link}|x> and nexus://coderef/bad`)).toEqual([fx.codeRef]);
  });

  it("pages channels, keeps only member channels and computes botIsMember", async () => {
    const { c } = client();
    expect(await c.channels()).toEqual([
      { id: "C1", name: "nexus-demo", isPrivate: false, isMember: true, botIsMember: true },
      { id: "C2", name: "nexus-build", isPrivate: false, isMember: true, botIsMember: false },
    ]);
  });

  it("pages history with a cursor and maps messages, code refs and bot authors", async () => {
    const { c, api } = client();
    const p1 = await c.history("C1", undefined, 3);
    expect(p1.nextCursor).toBe("page2");
    expect(p1.messages.map(m => m.id)).toEqual(["C1:3.000000", "C1:2.000000"]);
    expect(p1.messages[0]).toMatchObject({ codeRefs: [fx.codeRef], replyCount: 2, sentVia: "user", author: { name: "adrian", isBot: false } });
    expect(p1.messages[0].threadTs).toBeUndefined();
    expect(p1.messages[0].text).toContain("<nexus://");   // verbatim
    expect(p1.messages[1]).toMatchObject({ sentVia: "bot", author: { id: "B1", name: "Nexus", isBot: true } });
    const p2 = await c.history("C1", "page2");
    expect(p2.nextCursor).toBeUndefined();
    expect(api.conversations.history).toHaveBeenLastCalledWith({ channel: "C1", limit: 50, cursor: "page2" });
    expect(api.users.info).toHaveBeenCalledTimes(1);   // cached across calls
  });

  it("maps a thread", async () => {
    const { c } = client();
    const t = await c.getThread("C1", "3.000000");
    expect(t.messages.map(m => m.threadTs)).toEqual([undefined, "3.000000"]);
  });

  it("reports postsAs from auth.test and the token source", async () => {
    expect(await client().c.status()).toEqual({ postsAs: { userId: "U_ADRIAN", name: "adrian" }, userTokenSource: "manual" });
    expect(await client(undefined, null).c.status()).toEqual({ postsAs: null, userTokenSource: "none" });
    const bad = makeFake(); bad.auth.test.mockRejectedValue(new Error("invalid_auth"));
    expect((await client(bad).c.status()).postsAs).toBeNull();
  });

  it("posts as the user with sentVia user, in a thread when asked", async () => {
    const { c, api } = client();
    const m = await c.postAsUser({ channelId: "C1", text: "hi", threadTs: "3.000000", clientId: "k1" });
    expect(api.chat.postMessage).toHaveBeenCalledWith({ channel: "C1", text: "hi", thread_ts: "3.000000" });
    expect(m).toMatchObject({ id: "C1:9.000100", sentVia: "user", threadTs: "3.000000", author: { id: "U_ADRIAN", isBot: false } });
  });

  it("refuses to post without a verified user and never leaks the token in errors", async () => {
    await expect(client(undefined, null).c.postAsUser({ channelId: "C1", text: "x" })).rejects.toThrow("no slack user token");
    const bad = makeFake();
    bad.chat.postMessage.mockRejectedValue(Object.assign(new Error("xoxp-test boom"), { data: { error: "channel_not_found" } }));
    const err = await client(bad).c.postAsUser({ channelId: "C1", text: "x" }).catch((e: Error) => e);
    expect((err as Error).message).toBe("slack chat.postMessage failed: channel_not_found");
  });

  it("returns users by id", async () => {
    const { c } = client();
    expect(await c.users(["U_ADRIAN"])).toEqual([{ id: "U_ADRIAN", name: "adrian", displayName: "Adrian", isBot: false, avatarUrl: "https://x/a.png" }]);
  });
});
