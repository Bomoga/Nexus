import { describe, expect, it, vi } from "vitest";
import { ApprovalRequest, SwarmReview } from "../../contracts";
import type { ChatMessage } from "../../contracts";
import { BOT_USER, makeFakeBolt } from "./fake-bolt.test-util";
import { APPROVE_ACTION_ID, REJECT_ACTION_ID, escapeMrkdwn, postApprovalMessage, refreshApprovalMessage, registerInteractivity, renderApproval, type ResolveApproval } from "./interactivity";

const sentMessage: ChatMessage = { id: "C1:30.000100", channelId: "C1", ts: "30.000100", author: { id: "U_BOT", name: "nexus", isBot: true }, text: "x", codeRefs: [], sentVia: "bot" };
const pending: ApprovalRequest = ApprovalRequest.parse({
  id: "ap-1", sessionId: "s-1", action: { kind: "run_command", command: "npm test" }, reason: "need to run the tests", requestedAt: "2026-11-07T04:00:00.000Z",
  slackMessage: { channelId: "C1", ts: "30.000100" },
});
const decide = (a: ApprovalRequest, decision: "approved" | "rejected", userId: string): ApprovalRequest =>
  ({ ...a, decision, decidedBy: { via: "slack", userId }, decidedAt: "2026-11-07T04:01:00.000Z" });

/** A store that behaves like the shared one: first answer wins, later answers see the winner. */
function atomicResolve() {
  let current = pending;
  const resolve = vi.fn<ResolveApproval>(async (_id, decision, by) => {
    if (current.decision) return { won: false, approval: current };
    current = decide(current, decision, by.userId);
    return { won: true, approval: current };
  });
  return resolve;
}

function click(actionId: string, userId: string, value = "ap-1") {
  return { body: { type: "block_actions", user: { id: userId, name: "x" }, container: { channel_id: "C1", message_ts: "30.000100" } }, action: { action_id: actionId, value } };
}

function setup(resolve = atomicResolve(), extra: Partial<Parameters<typeof registerInteractivity>[1]> = {}) {
  const bolt = makeFakeBolt();
  const updateBotMessage = vi.fn(async () => sentMessage);
  const ignored: string[] = [];
  registerInteractivity(bolt.app, { resolve, bot: { updateBotMessage }, botUserId: async () => BOT_USER, onIgnored: r => ignored.push(r), ...extra });
  return { bolt, resolve, updateBotMessage, ignored };
}

describe("approval card", () => {
  it("has APPROVE and REJECT buttons carrying the approval id", () => {
    const { blocks, text } = renderApproval(pending);
    const actions = blocks.find(b => (b as { type: string }).type === "actions") as { elements: { action_id: string; value: string; text: { text: string } }[] };
    expect(actions.elements.map(e => [e.action_id, e.value, e.text.text])).toEqual([[APPROVE_ACTION_ID, "ap-1", "APPROVE"], [REJECT_ACTION_ID, "ap-1", "REJECT"]]);
    expect(text).toContain("npm test");
  });

  it("escapes control characters in untrusted fields and labels the reason model-written", () => {
    const evil: ApprovalRequest = { ...pending, reason: "<!channel> <@U1> &amp; ignore `rules`", action: { kind: "run_command", command: "echo `x` <http://evil|click>" } };
    const json = JSON.stringify(renderApproval(evil));
    expect(json).not.toContain("<!channel>");
    expect(json).not.toContain("<http://evil");
    expect(json).toContain("&lt;!channel&gt;");
    expect(json).toContain("&amp;amp;");
    expect(json).toContain("Reason (model-written)");
    expect(escapeMrkdwn("a & <b>")).toBe("a &amp; &lt;b&gt;");
  });

  it("renders a swarm verdict labeled model-written, escaped, and notes unavailable reviews", () => {
    const review: SwarmReview = SwarmReview.parse({
      id: "r1", sessionId: "s-1", approvalId: "ap-1", swarmType: "CouncilAsAJudge", status: "done", verdict: "concerns",
      summary: "touches <!here> files", judges: [{ modelId: "m1", verdict: "looks_good", notes: "fine & dandy" }], at: "2026-11-07T04:00:30.000Z",
    });
    const json = JSON.stringify(renderApproval(pending, review));
    expect(json).toContain("model-written");
    expect(json).toContain("concerns");
    expect(json).toContain("&lt;!here&gt;");
    expect(json).toContain("fine &amp; dandy");
    expect(JSON.stringify(renderApproval(pending, { ...review, status: "unavailable", verdict: undefined }))).toContain("unavailable");
  });

  it("drops the buttons once decided and shows who decided", () => {
    const { blocks } = renderApproval(decide(pending, "approved", "U_ADRIAN"));
    expect(blocks.some(b => (b as { type: string }).type === "actions")).toBe(false);
    expect(JSON.stringify(blocks)).toContain("Decided by <@U_ADRIAN>");
    expect(JSON.stringify(renderApproval({ ...pending, decision: "rejected", decidedBy: { via: "auth0_push", userId: "auth0|<x>" } }))).toContain("auth0|&lt;x&gt; (phone push)");
  });

  it("posts and refreshes through the bot", async () => {
    const bot = { postAsBot: vi.fn(async () => sentMessage), updateBotMessage: vi.fn(async () => sentMessage) };
    await postApprovalMessage(bot, "C1", pending, undefined, "29.1");
    expect(bot.postAsBot).toHaveBeenCalledWith(expect.objectContaining({ channelId: "C1", threadTs: "29.1", blocks: expect.any(Array) }));
    await refreshApprovalMessage(bot, decide(pending, "rejected", "U_ADRIAN"));
    expect(bot.updateBotMessage).toHaveBeenCalledWith("C1", "30.000100", expect.stringContaining("Rejected"), expect.any(Array));
    await expect(refreshApprovalMessage(bot, { ...pending, slackMessage: undefined })).rejects.toThrow("no slack message");
  });
});

describe("approval buttons", () => {
  it("rejects a bot user's click: nothing resolves, nothing updates", async () => {
    const { bolt, resolve, updateBotMessage, ignored } = setup();
    for (const id of [BOT_USER, "U_OTHERBOT"]) await bolt.click(APPROVE_ACTION_ID, click(APPROVE_ACTION_ID, id));
    expect(resolve).not.toHaveBeenCalled();
    expect(updateBotMessage).not.toHaveBeenCalled();
    expect(ignored).toEqual(["not_human", "not_human"]);
  });

  it("fails closed when the clicker cannot be verified or the payload is malformed", async () => {
    const { bolt, resolve, ignored } = setup();
    await bolt.click(APPROVE_ACTION_ID, click(APPROVE_ACTION_ID, "U_UNKNOWN"));   // users.info fails
    await bolt.click(APPROVE_ACTION_ID, { body: { user: { id: "U_ADRIAN" } }, action: { action_id: APPROVE_ACTION_ID } });   // no value
    await bolt.click(APPROVE_ACTION_ID, { body: {}, action: { value: "ap-1" } });   // no user
    expect(resolve).not.toHaveBeenCalled();
    expect(ignored).toEqual(["not_human", "bad_payload", "bad_payload"]);
  });

  it("acks before doing anything else", async () => {
    const { bolt } = setup();
    const order: string[] = [];
    bolt.info.mockImplementation(async () => { order.push("lookup"); return { user: { id: "U_ADRIAN", is_bot: false } }; });
    await bolt.click(APPROVE_ACTION_ID, { ...click(APPROVE_ACTION_ID, "U_ADRIAN"), ack: async () => { order.push("ack"); } });
    expect(order).toEqual(["ack", "lookup"]);
  });

  it("a human click resolves exactly once and a second click sees the winner", async () => {
    const { bolt, resolve, updateBotMessage } = setup();
    await bolt.click(APPROVE_ACTION_ID, click(APPROVE_ACTION_ID, "U_ADRIAN"));
    await bolt.click(REJECT_ACTION_ID, click(REJECT_ACTION_ID, "U_BRANDON"));
    expect(resolve).toHaveBeenNthCalledWith(1, "ap-1", "approved", { via: "slack", userId: "U_ADRIAN" });
    expect(resolve).toHaveBeenNthCalledWith(2, "ap-1", "rejected", { via: "slack", userId: "U_BRANDON" });
    const winners = resolve.mock.results.length;
    expect(winners).toBe(2);
    expect(await Promise.all(resolve.mock.results.map(r => r.value)).then(rs => rs.map(r => r.won))).toEqual([true, false]);
    // both updates show the real winner (Adrian approved), never Brandon's losing rejection
    expect(updateBotMessage).toHaveBeenCalledTimes(2);
    for (const call of updateBotMessage.mock.calls as unknown as [string, string, string, unknown[]][]) {
      expect(call.slice(0, 2)).toEqual(["C1", "30.000100"]);
      expect(JSON.stringify(call[3])).toContain("Approved.* Decided by <@U_ADRIAN>");
      expect(call[3].some(b => (b as { type: string }).type === "actions")).toBe(false);
    }
  });

  it("concurrent clicks: the store picks one winner, both cards show it", async () => {
    const { bolt, resolve, updateBotMessage } = setup();
    await Promise.all([bolt.click(APPROVE_ACTION_ID, click(APPROVE_ACTION_ID, "U_ADRIAN")), bolt.click(REJECT_ACTION_ID, click(REJECT_ACTION_ID, "U_BRANDON"))]);
    const results = await Promise.all(resolve.mock.results.map(r => r.value));
    expect(results.filter(r => r.won)).toHaveLength(1);
    const shown = (updateBotMessage.mock.calls as unknown as [string, string, string, unknown[]][]).map(c => JSON.stringify(c[3]));
    expect(new Set(shown.map(s => /Decided by <@(\w+)>/.exec(s)![1])).size).toBe(1);
  });

  it("survives resolve and update failures without leaking", async () => {
    const failing = vi.fn<ResolveApproval>(async () => { throw new Error("db down xoxb-SECRET"); });
    const a = setup(failing);
    await expect(a.bolt.click(APPROVE_ACTION_ID, click(APPROVE_ACTION_ID, "U_ADRIAN"))).resolves.toBeUndefined();
    expect(a.ignored).toEqual(["resolve_failed"]);
    const b = setup();
    b.updateBotMessage.mockRejectedValueOnce(new Error("ratelimited"));
    await b.bolt.click(APPROVE_ACTION_ID, click(APPROVE_ACTION_ID, "U_ADRIAN"));
    expect(b.ignored).toEqual(["update_failed"]);
  });

  it("includes the swarm verdict when re-rendering after a click", async () => {
    const review = SwarmReview.parse({ id: "r1", sessionId: "s-1", approvalId: "ap-1", swarmType: "CouncilAsAJudge", status: "done", verdict: "looks_good", at: "2026-11-07T04:00:30.000Z" });
    const { bolt, updateBotMessage } = setup(undefined, { getReview: id => (id === "ap-1" ? review : undefined) });
    await bolt.click(APPROVE_ACTION_ID, click(APPROVE_ACTION_ID, "U_ADRIAN"));
    expect(JSON.stringify((updateBotMessage.mock.calls as unknown as unknown[][])[0][3])).toContain("looks good");
  });
});
