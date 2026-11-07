// L2-S1, the live check the lead runs: Socket Mode from a real extension host / node process against the real Slack app.
// Skips cleanly without SLACK_APP_TOKEN and SLACK_BOT_TOKEN (and a channel); runs only via the int vitest config, never in `npm test`.
//   SLACK_APP_TOKEN=xapp-... SLACK_BOT_TOKEN=xoxb-... SLACK_TEST_CHANNEL=C... npx vitest run -c vitest.int.config.ts src/services/slack
// Human steps while it waits: post any message in the channel, then click APPROVE on the card it posts (as a person, not a bot).
import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../../contracts";
import { createSlackService } from "./slack-service";
import type { SlackMessageEvent } from "./types";

const appToken = process.env.SLACK_APP_TOKEN;
const botToken = process.env.SLACK_BOT_TOKEN;
const channel = process.env.SLACK_TEST_CHANNEL;
const live = !!(appToken && botToken && channel);

describe.skipIf(!live)("L2-S1 live slack (socket mode + approval button)", () => {
  it("receives one message and one button click", async () => {
    const decisions: string[] = [];
    const approvals = new Map<string, ApprovalRequest>();
    const svc = createSlackService({
      getUserToken: async () => (process.env.SLACK_USER_TOKEN ? { token: process.env.SLACK_USER_TOKEN, source: "manual" } : null),
      getBotTokens: async () => ({ botToken: botToken as string, appToken: appToken as string }),
      getApproval: id => approvals.get(id),
      resolve: async (id, decision, by) => {
        decisions.push(`${id}:${decision}:${by.userId}`);
        return { won: true, approval: { id, sessionId: "s-int", action: { kind: "other", description: "L2-S1 smoke" }, reason: "integration check", requestedAt: new Date().toISOString(), decision, decidedBy: { via: "slack", userId: by.userId } } };
      },
    });
    const seen: SlackMessageEvent[] = [];
    svc.onMessage(e => seen.push(e), [channel as string]);
    expect(await svc.start()).toBe(true);
    try {
      console.log("L2-S1: post a message in the test channel now");
      await expect.poll(() => seen.some(e => e.type === "message" && !e.message.author.isBot), { timeout: 120_000 }).toBe(true);
      const approval: ApprovalRequest = { id: "apr_int", sessionId: "s-int", action: { kind: "other", description: "L2-S1 smoke" }, reason: "click APPROVE", requestedAt: new Date().toISOString() };
      const card = await svc.postApproval(channel as string, approval);
      approvals.set(approval.id, { ...approval, slackMessage: { channelId: card.channelId, ts: card.ts } });   // the host stores the card's ts
      console.log("L2-S1: click APPROVE on the card now");
      await expect.poll(() => decisions.length, { timeout: 120_000 }).toBe(1);
      expect(decisions[0]).toMatch(/^apr_int:approved:/);
    } finally {
      await svc.stop();
    }
  }, 300_000);
});
