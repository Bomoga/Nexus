import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../contracts";
import { FakeSlack } from "./fake-slack";
import type { SlackMessageEvent } from "./types";

const PARENT = "1762485300.000100";

describe("FakeSlack", () => {
  it("increments replyCount and emits message_changed for the parent on post and receive", async () => {
    const s = new FakeSlack();
    const events: SlackMessageEvent[] = [];
    s.onMessage(e => events.push(e));
    await s.postAsUser({ channelId: "C_DEMO", text: "me too", threadTs: PARENT });
    const received: ChatMessage = { id: "C_DEMO:1762485999.000100", channelId: "C_DEMO", ts: "1762485999.000100", threadTs: PARENT, author: { id: "U_BRANDON", name: "brandon", isBot: false }, text: "hi", codeRefs: [], sentVia: "user" };
    s.receive(received);
    const changed = events.filter(e => e.type === "message_changed");
    expect(changed.map(e => e.type === "message_changed" && e.message.replyCount)).toEqual([2, 3]);
    expect((await s.getThread("C_DEMO", PARENT)).messages[0].replyCount).toBe(3);
  });

  it("throws on unknown channel and missing membership", async () => {
    const s = new FakeSlack();
    await expect(s.postAsUser({ channelId: "C_NOPE", text: "x" })).rejects.toThrow(/unknown channel/);
    await expect(s.history("C_NOPE")).rejects.toThrow(/unknown channel/);
    const channels = (s as unknown as { channelList: { id: string; isMember: boolean; botIsMember: boolean }[] }).channelList;
    channels[0].isMember = false;
    await expect(s.postAsUser({ channelId: "C_DEMO", text: "x" })).rejects.toThrow(/user is not a member/);
    channels[1].botIsMember = false;
    await expect(s.postAsBot({ channelId: "C_BUILD", text: "x" })).rejects.toThrow(/bot is not a member/);
  });

  it("failNextPost fails exactly one post", async () => {
    const s = new FakeSlack();
    s.failNextPost("rate_limited");
    await expect(s.postAsUser({ channelId: "C_DEMO", text: "x" })).rejects.toThrow("rate_limited");
    await expect(s.postAsUser({ channelId: "C_DEMO", text: "x" })).resolves.toMatchObject({ sentVia: "user" });
  });
});
