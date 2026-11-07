// Approval messages as Block Kit and their button clicks (L2-03). A click counts only from a human workspace member:
// a bot user's click never resolves an approval (section 14). The shared store, not this module, decides who won.
import type { ApprovalRequest, SwarmReview } from "../../contracts";
import type { BoltLike } from "./socket";
import type { SlackService } from "./types";

export const APPROVE_ACTION_ID = "nexus.approve";
export const REJECT_ACTION_ID = "nexus.reject";

export type SlackDecision = "approved" | "rejected";
export interface ResolveResult { won: boolean; approval: ApprovalRequest }
/** approvals.resolve in the host. First human answer wins; `won` is false when someone had already decided. */
export type ResolveApproval = (approvalId: string, decision: SlackDecision, by: { via: "slack"; userId: string }) => Promise<ResolveResult>;

export type BotMessages = Pick<SlackService, "postAsBot" | "updateBotMessage">;

const MAX_FIELD = 2_500;   // a Block Kit section holds 3000 characters
const VERDICT_LABEL = { looks_good: "looks good", concerns: "concerns", do_not_merge: "do not merge" } as const;

/** Escapes Slack mrkdwn control characters. Everything not authored by Nexus (reasons, commands, summaries, notes) passes through this. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Untrusted text for display: escaped, backticks neutralized (so it cannot break out of a code span), truncated. */
function untrusted(text: string, max = MAX_FIELD): string {
  const t = text.length > max ? `${text.slice(0, max)}…` : text;
  return escapeMrkdwn(t).replace(/`/g, "'");
}

function describeAction(action: ApprovalRequest["action"]): string {
  switch (action.kind) {
    case "run_command": return `Run command: \`${untrusted(action.command, 1_000)}\``;
    case "write_outside_scope": return `Write outside the session worktree: \`${untrusted(action.path, 500)}\``;
    case "commit": return `Commit: ${untrusted(action.message, 1_000)}`;
    case "other": return untrusted(action.description, 1_000);
  }
}

/** The Slack-visible name of whoever decided. Slack ids render as mentions; anything else is escaped text. */
function deciderLabel(by: NonNullable<ApprovalRequest["decidedBy"]>): string {
  if (by.via === "slack" && /^[UW][A-Z0-9_]{2,}$/.test(by.userId)) return `<@${by.userId}>`;
  const via = by.via === "auth0_push" ? "phone push" : by.via === "app" ? "Nexus" : "Slack";
  return `${untrusted(by.userId, 100)} (${via})`;
}

function reviewSection(review: SwarmReview): unknown[] {
  if (review.status === "running") return [{ type: "context", elements: [{ type: "mrkdwn", text: "_Swarm review running (model-written, advisory)…_" }] }];
  if (review.status === "unavailable" || !review.verdict) return [{ type: "context", elements: [{ type: "mrkdwn", text: "_Swarm review unavailable: decide without it._" }] }];
  const head = `*Swarm review* (model-written, advisory; ran off this machine): *${VERDICT_LABEL[review.verdict]}*`;
  const summary = review.summary ? `\n${untrusted(review.summary, 800)}` : "";
  const out: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: `${head}${summary}` } }];
  if (review.judges?.length) {
    const lines = review.judges.slice(0, 6).map(j => `• \`${untrusted(j.modelId, 60)}\`: ${VERDICT_LABEL[j.verdict]}. ${untrusted(j.notes, 200)}`);
    out.push({ type: "context", elements: [{ type: "mrkdwn", text: lines.join("\n").slice(0, MAX_FIELD) }] });
  }
  return out;
}

/** Renders the approval message: details, an optional swarm verdict, then buttons while undecided or "Decided by ..." once decided. */
export function renderApproval(approval: ApprovalRequest, review?: SwarmReview, decidedByName?: string): { text: string; blocks: unknown[] } {
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `*Approval needed* · session \`${untrusted(approval.sessionId, 80)}\`\n${describeAction(approval.action)}` } },
    { type: "section", text: { type: "mrkdwn", text: `*Reason (model-written):* ${untrusted(approval.reason, 1_200)}` } },
  ];
  if (review) blocks.push(...reviewSection(review));
  if (approval.decision && approval.decidedBy) {
    const verb = approval.decision === "approved" ? "Approved" : "Rejected";
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${verb}.* Decided by ${deciderLabel(approval.decidedBy)}` } });
    return { text: `${verb} by ${decidedByName ? untrusted(decidedByName, 100) : untrusted(approval.decidedBy.userId, 100)}: ${describeFallback(approval)}`, blocks };
  }
  blocks.push({
    type: "actions", block_id: "nexus.approval",
    elements: [
      { type: "button", action_id: APPROVE_ACTION_ID, style: "primary", value: approval.id, text: { type: "plain_text", text: "APPROVE" } },
      { type: "button", action_id: REJECT_ACTION_ID, style: "danger", value: approval.id, text: { type: "plain_text", text: "REJECT" } },
    ],
  });
  return { text: `Approval needed: ${describeFallback(approval)}`, blocks };
}

function describeFallback(approval: ApprovalRequest): string {
  return describeAction(approval.action).replace(/`/g, "").slice(0, 200);
}

/** Posts the approval card as the bot. The caller stores the returned ts as ApprovalRequest.slackMessage. */
export async function postApprovalMessage(bot: BotMessages, channelId: string, approval: ApprovalRequest, review?: SwarmReview, threadTs?: string) {
  const { text, blocks } = renderApproval(approval, review);
  return bot.postAsBot({ channelId, text, blocks, ...(threadTs ? { threadTs } : {}) });
}

/** Re-renders the card in place (a swarm verdict arrived, or the approval was decided in the app or by phone push). */
export async function refreshApprovalMessage(bot: BotMessages, approval: ApprovalRequest, review?: SwarmReview) {
  if (!approval.slackMessage) throw new Error("approval has no slack message");
  const { text, blocks } = renderApproval(approval, review);
  return bot.updateBotMessage(approval.slackMessage.channelId, approval.slackMessage.ts, text, blocks);
}

export interface InteractivityDeps {
  resolve: ResolveApproval;
  bot: Pick<SlackService, "updateBotMessage">;
  /** The Nexus bot's own user id; its clicks are never accepted. */
  botUserId: () => Promise<string>;
  /** The swarm review to show for an approval, if there is one. */
  getReview?: (approvalId: string) => SwarmReview | undefined;
  /** Observability without secrets: why a click was ignored or failed. */
  onIgnored?: (reason: "not_human" | "bad_payload" | "resolve_failed" | "update_failed") => void;
}

/** Registers the APPROVE and REJECT handlers. Each one acks first, verifies the clicker, resolves once, then updates the card. */
export function registerInteractivity(app: BoltLike, deps: InteractivityDeps): void {
  const handle = (decision: SlackDecision) => async ({ ack, body, action }: Parameters<Parameters<BoltLike["action"]>[1]>[0]): Promise<void> => {
    await ack();
    const ignore = (r: Parameters<NonNullable<InteractivityDeps["onIgnored"]>>[0]) => { try { deps.onIgnored?.(r); } catch { /* observer only */ } };
    const approvalId = action.value;
    const clickerId = body.user?.id;
    if (typeof approvalId !== "string" || !approvalId || approvalId.length > 128 || typeof clickerId !== "string" || !clickerId) return ignore("bad_payload");

    // Only a human workspace member decides: look the clicker up fresh and fail closed.
    try {
      const [info, botId] = await Promise.all([app.client.users.info({ user: clickerId }), deps.botUserId()]);
      const u = info.user;
      if (!u || u.is_bot !== false || u.deleted || u.id !== clickerId || clickerId === botId) return ignore("not_human");
    } catch { return ignore("not_human"); }

    let result: ResolveResult;
    try { result = await deps.resolve(approvalId, decision, { via: "slack", userId: clickerId }); }
    catch { return ignore("resolve_failed"); }

    // The card shows the real winner: the clicker when they won, whoever decided first on a conflict.
    const channelId = body.container?.channel_id ?? body.channel?.id ?? result.approval.slackMessage?.channelId;
    const ts = body.container?.message_ts ?? body.message?.ts ?? result.approval.slackMessage?.ts;
    if (!channelId || !ts) return;
    const { text, blocks } = renderApproval(result.approval, deps.getReview?.(result.approval.id));
    try { await deps.bot.updateBotMessage(channelId, ts, text, blocks); }
    catch { ignore("update_failed"); }
  };
  app.action(APPROVE_ACTION_ID, handle("approved"));
  app.action(REJECT_ACTION_ID, handle("rejected"));
}
