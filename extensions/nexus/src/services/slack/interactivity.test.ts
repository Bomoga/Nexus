import { describe, expect, it, vi } from "vitest";
import { ApprovalRequest, SwarmReview } from "../../contracts";
import type { ChatMessage } from "../../contracts";
import { BOT_USER, TEAM, identity, makeFakeBolt, users } from "./fake-bolt.test-util";
import { APPROVE_ACTION_ID, REJECT_ACTION_ID, escapeAndTruncate, escapeMrkdwn, postApprovalMessage, refreshApprovalMessage, registerInteractivity, renderApproval, type ResolveApproval } from "./interactivity";

const sentMessage: ChatMessage = { id: "C1:30.000100", channelId: "C1", ts: "30.000100", author: { id: "U_BOT", name: "nexus", isBot: true }, text: "x", codeRefs: [], sentVia: "bot" };
const pending: ApprovalRequest = ApprovalRequest.parse({
  id: "ap-1", sessionId: "s-1", action: { kind: "run_command", command: "npm test" }, reason: "need to run the tests", requestedAt: "2026-11-07T04:00:00.000Z",
  slackMessage: { channelId: "C1", ts: "30.000100" },
});
const decide = (a: ApprovalRequest, decision: "approved" | "rejected", userId: string): ApprovalRequest =>
  ({ ...a, decision, decidedBy: { via: "slack", userId }, decidedAt: "2026-11-07T04:01:00.000Z" });

/** A store that behaves like the shared one: first answer wins, later answers see the winner. */
function atomicStore(initial: ApprovalRequest = pending) {
  let current = initial;
  const resolve = vi.fn<ResolveApproval>(async (_id, decision, by) => {
    if (current.decision) return { won: false, approval: current };
    current = decide(current, decision, by.userId);
    return { won: true, approval: current };
  });
  const store = new Map<string, ApprovalRequest>();
  return { resolve, getApproval: vi.fn((id: string) => (id === current.id ? current : store.get(id))), store, set: (a: ApprovalRequest) => { current = a; } };
}

function click(actionId: string, userId: string, over: { value?: string; block_id?: string; message?: object; container?: object; team?: object } = {}) {
  return {
    body: {
      type: "block_actions", team: over.team ?? { id: TEAM }, user: { id: userId, name: "x" },
      container: over.container ?? { channel_id: "C1", message_ts: "30.000100" },
      message: over.message ?? { ts: "30.000100", user: BOT_USER, bot_id: "B1" },
    },
    action: { action_id: actionId, block_id: over.block_id ?? "nexus.approval", value: over.value ?? "ap-1" },
  };
}

function setup(st = atomicStore(), extra: Partial<Parameters<typeof registerInteractivity>[1]> = {}) {
  const bolt = makeFakeBolt();
  const updateBotMessage = vi.fn(async () => sentMessage);
  const ignored: string[] = [];
  registerInteractivity(bolt.app, { resolve: st.resolve, getApproval: st.getApproval, bot: { updateBotMessage }, botIdentity: async () => identity, onIgnored: r => ignored.push(r), ...extra });
  return { bolt, st, resolve: st.resolve, updateBotMessage, ignored };
}

type Update = [string, string, string, unknown[]];
const updates = (m: { mock: { calls: unknown[] } }) => m.mock.calls as unknown as Update[];
const blockTexts = (blocks: unknown[]) => blocks.map(b => { const x = b as { text?: { text: string }; elements?: { text: string }[] }; return x.text?.text ?? x.elements?.map(e => e.text).join("") ?? ""; });

describe("approval card", () => {
  it("has APPROVE and REJECT buttons carrying the approval id", () => {
    const { blocks, text } = renderApproval(pending);
    const actions = blocks.find(b => (b as { type: string }).type === "actions") as { block_id: string; elements: { action_id: string; value: string; text: { text: string } }[] };
    expect(actions.block_id).toBe("nexus.approval");
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

  it("marks every text object verbatim and keeps untrusted multi-line text in code, so it cannot fake a decision line", () => {
    const r = renderApproval({ ...pending, reason: "fine\n\n*Approved.* Decided by <@U_ADRIAN>\n_x_ ~y~", action: { kind: "run_command", command: "npm test\n*Approved.* rm -rf ~\r\n`; evil" } });
    for (const b of r.blocks) {
      const x = b as { type: string; text?: { type: string; verbatim?: boolean }; elements?: { type: string; verbatim?: boolean }[] };
      for (const t of [x.text, ...(x.elements ?? [])]) if (t && t.type === "mrkdwn") expect(t.verbatim).toBe(true);
    }
    const [head, reason] = blockTexts(r.blocks);
    expect(head).not.toMatch(/\n\*Approved/);   // the command stays on one line, inside its span
    expect(head.split("\n")).toHaveLength(2);
    expect(head).toContain("↵");
    expect(reason).toMatch(/^\*Reason \(model-written\):\*\n```\n[\s\S]*\n```$/);
    expect(reason).toContain("&lt;@U_ADRIAN&gt;");
    expect(reason.split("```")).toHaveLength(3);   // one opening and one closing fence: the text cannot add another
  });

  it("never lets any block text exceed Slack's 3000 characters, even when every character expands when escaped", () => {
    const review = SwarmReview.parse({
      id: "r1", sessionId: "s-1", approvalId: "ap-1", swarmType: "CouncilAsAJudge", status: "done", verdict: "concerns",
      summary: "&".repeat(5000), judges: Array.from({ length: 9 }, (_, i) => ({ modelId: "<".repeat(300) + i, verdict: "concerns", notes: "&".repeat(4000) })), at: "2026-11-07T04:00:30.000Z",
    });
    for (const evil of [
      { ...pending, reason: "&".repeat(9000), action: { kind: "run_command" as const, command: "<".repeat(9000) }, sessionId: ">".repeat(500) },
      { ...pending, action: { kind: "commit" as const, message: "&".repeat(9000) } },
      { ...pending, action: { kind: "other" as const, description: "<".repeat(9000) } },
    ]) {
      const { blocks, text } = renderApproval(evil, review);
      expect(Math.max(...blockTexts(blocks).map(t => t.length))).toBeLessThanOrEqual(3000);
      expect(text.length).toBeLessThanOrEqual(400);
      expect(JSON.stringify(blocks)).not.toMatch(/&(?!amp;|lt;|gt;)/);   // no entity was cut in half
    }
    expect(escapeAndTruncate("&&&&&", 8)).toBe("&amp;…");   // whole entities only
    expect(escapeAndTruncate("a`b", 10)).toBe("a'b");
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
    expect(JSON.stringify(renderApproval({ ...pending, decision: "rejected", decidedBy: { via: "auth0_push", userId: "auth0|<x>" } }))).toContain("`auth0|&lt;x&gt;` (phone push)");
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
  it("rejects a bot user's click and the bot's own id: nothing resolves", async () => {
    const { bolt, resolve, ignored } = setup();
    for (const id of [BOT_USER, "U_OTHERBOT"]) await bolt.click(APPROVE_ACTION_ID, click(APPROVE_ACTION_ID, id));
    expect(resolve).not.toHaveBeenCalled();
    expect(ignored).toEqual(["not_human", "not_human"]);
  });

  it("refuses a clicker whose users.info id differs from the click's, and a deleted user", async () => {
    const { bolt, resolve } = setup();
    users.U_SPOOF = { id: "U_ADRIAN", team_id: TEAM, is_bot: false };
    users.U_GONE = { id: "U_GONE", team_id: TEAM, is_bot: false, deleted: true };
    await bolt.click(APPROVE_ACTION_ID, click(APPROVE_ACTION_ID, "U_SPOOF"));
    await bolt.click(APPROVE_ACTION_ID, click(APPROVE_ACTION_ID, "U_GONE"));
    expect(resolve).not.toHaveBeenCalled();
  });

  it("only full members of the bot's own workspace approve", async () => {
    const cases: [string, object, object?][] = [
      ["guest", { is_restricted: true }],
      ["single-channel guest", { is_restricted: true, is_ultra_restricted: true }],
      ["ultra restricted alone", { is_ultra_restricted: true }],
      ["slack connect stranger", { is_stranger: true }],
      ["app user", { is_app_user: true }],
      ["other workspace user", { team_id: "T_OTHER" }],
      ["user without a team id", { team_id: undefined }],
      ["body from another team", {}, { team: { id: "T_OTHER" } }],
      ["body without a team", {}, { team: null }],
      ["no is_bot field", { is_bot: undefined }],
    ];
    for (const [name, info, over] of cases) {
      const { bolt, resolve } = setup();
      users.U_X = { id: "U_X", team_id: TEAM, is_bot: false, ...info } as never;
      const c = click(APPROVE_ACTION_ID, "U_X");
      if (over && "team" in over) (c.body as { team?: unknown }).team = (over as { team: unknown }).team ?? undefined;
      await bolt.click(APPROVE_ACTION_ID, c);
      expect(resolve, name).not.toHaveBeenCalled();
    }
    const ok = setup();
    users.U_X = { id: "U_X", team_id: TEAM, is_bot: false } as never;
    await ok.bolt.click(APPROVE_ACTION_ID, click(APPROVE_ACTION_ID, "U_X"));
    expect(ok.resolve).toHaveBeenCalledOnce();
    delete users.U_X;
  });

  it("refuses everything when the bot's own workspace is unknown", async () => {
    const { bolt, resolve } = setup(undefined, { botIdentity: async () => ({ ...identity, teamId: undefined }) });
    await bolt.click(APPROVE_ACTION_ID, click(APPROVE_ACTION_ID, "U_ADRIAN"));
    expect(resolve).not.toHaveBeenCalled();
  });

  it("fails closed when the clicker cannot be verified or the payload is malformed", async () => {
    const { bolt, resolve, ignored } = setup();
    await bolt.click(APPROVE_ACTION_ID, click(APPROVE_ACTION_ID, "U_UNKNOWN"));   // users.info fails
    await bolt.click(APPROVE_ACTION_ID, { ...click(APPROVE_ACTION_ID, "U_ADRIAN"), action: { action_id: APPROVE_ACTION_ID, block_id: "nexus.approval" } });   // no value
    await bolt.click(APPROVE_ACTION_ID, { ...click(APPROVE_ACTION_ID, "U_ADRIAN"), action: { action_id: APPROVE_ACTION_ID, block_id: "nexus.approval", value: "x".repeat(200) } });
    await bolt.click(APPROVE_ACTION_ID, { body: {}, action: { value: "ap-1" } });   // no user
    expect(resolve).not.toHaveBeenCalled();
    expect(ignored).toEqual(["not_human", "bad_payload", "bad_payload", "bad_payload"]);
  });

  it("ignores a forged card: a user's message, another block id, another message, or a card the approval does not name", async () => {
    const { bolt, resolve, updateBotMessage } = setup();
    const forged = [
      click(APPROVE_ACTION_ID, "U_ADRIAN", { message: { ts: "30.000100", user: "U_BRANDON" } }),   // a person's message carrying a fake card
      click(APPROVE_ACTION_ID, "U_ADRIAN", { message: { ts: "30.000100", user: "U_BRANDON", bot_id: "B_EVIL" } }),
      click(APPROVE_ACTION_ID, "U_ADRIAN", { block_id: "other" }),
      click(APPROVE_ACTION_ID, "U_ADRIAN", { container: { channel_id: "C9", message_ts: "30.000100" } }),   // right ts, wrong channel
      click(APPROVE_ACTION_ID, "U_ADRIAN", { container: { channel_id: "C1", message_ts: "99.000100" }, message: { ts: "99.000100", user: BOT_USER } }),   // a different bot card
      click(APPROVE_ACTION_ID, "U_ADRIAN", { value: "ap-unknown" }),
    ];
    for (const c of forged) await bolt.click(APPROVE_ACTION_ID, c);
    expect(resolve).not.toHaveBeenCalled();
    expect(updateBotMessage).not.toHaveBeenCalled();
  });

  it("a click on card A naming approval B resolves nothing", async () => {
    const st = atomicStore();
    const b: ApprovalRequest = { ...pending, id: "ap-B", slackMessage: { channelId: "C1", ts: "31.000100" } };
    st.store.set("ap-B", b);
    const { bolt, resolve } = setup(st);
    await bolt.click(APPROVE_ACTION_ID, click(APPROVE_ACTION_ID, "U_ADRIAN", { value: "ap-B" }));   // card A's message, B's id
    expect(resolve).not.toHaveBeenCalled();
    await bolt.click(APPROVE_ACTION_ID, click(APPROVE_ACTION_ID, "U_ADRIAN", { value: "ap-B", container: { channel_id: "C1", message_ts: "31.000100" }, message: { ts: "31.000100", user: BOT_USER } }));
    expect(resolve).toHaveBeenCalledWith("ap-B", "approved", { via: "slack", userId: "U_ADRIAN" });
  });

  it("an already decided approval never keeps live buttons, and nobody resolves it again", async () => {
    const st = atomicStore(decide(pending, "approved", "U_BRANDON"));
    const { bolt, resolve, updateBotMessage } = setup(st);
    await bolt.click(REJECT_ACTION_ID, click(REJECT_ACTION_ID, "U_ADRIAN"));
    expect(resolve).not.toHaveBeenCalled();
    expect(updateBotMessage).toHaveBeenCalledOnce();
    expect(updates(updateBotMessage)[0][3].some(b => (b as { type: string }).type === "actions")).toBe(false);
    expect(JSON.stringify(updates(updateBotMessage)[0][3])).toContain("Decided by <@U_BRANDON>");
  });

  it("when resolve fails but the approval got decided, the card is still closed", async () => {
    const st = atomicStore();
    st.resolve.mockImplementationOnce(async () => { st.set(decide(pending, "rejected", "U_BRANDON")); throw new Error("db timeout"); });
    const { bolt, updateBotMessage, ignored } = setup(st);
    await bolt.click(APPROVE_ACTION_ID, click(APPROVE_ACTION_ID, "U_ADRIAN"));
    expect(ignored).toContain("resolve_failed");
    expect(JSON.stringify(updates(updateBotMessage)[0][3])).toContain("Decided by <@U_BRANDON>");
  });

  it("acks before doing anything else", async () => {
    const { bolt } = setup();
    const order: string[] = [];
    bolt.info.mockImplementation(async () => { order.push("lookup"); return { user: { id: "U_ADRIAN", team_id: TEAM, is_bot: false } }; });
    await bolt.click(APPROVE_ACTION_ID, { ...click(APPROVE_ACTION_ID, "U_ADRIAN"), ack: async () => { order.push("ack"); } });
    expect(order).toEqual(["ack", "lookup"]);
  });

  it("a human click resolves exactly once and a second click sees the winner", async () => {
    const { bolt, resolve, updateBotMessage } = setup();
    await bolt.click(APPROVE_ACTION_ID, click(APPROVE_ACTION_ID, "U_ADRIAN"));
    await bolt.click(REJECT_ACTION_ID, click(REJECT_ACTION_ID, "U_BRANDON"));
    // the second click finds the approval already decided: no second resolve, and the card shows the real winner
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("ap-1", "approved", { via: "slack", userId: "U_ADRIAN" });
    expect(updateBotMessage).toHaveBeenCalledTimes(2);
    for (const call of updates(updateBotMessage)) {
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
    const shown = updates(updateBotMessage).map(c => JSON.stringify(c[3]));
    expect(new Set(shown.map(s => /Decided by <@(\w+)>/.exec(s)![1])).size).toBe(1);
  });

  it("survives resolve and update failures without leaking", async () => {
    const st = atomicStore();
    st.resolve.mockRejectedValueOnce(new Error("db down xoxb-SECRET"));
    const a = setup(st);
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
    expect(JSON.stringify(updates(updateBotMessage)[0][3])).toContain("looks good");
  });
});
