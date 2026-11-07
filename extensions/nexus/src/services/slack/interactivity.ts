// Approval messages as Block Kit and their button clicks (L2-03). A click counts only when it is on the bot's own stored card and comes
// from a full, human member of the bot's own workspace (section 14). The shared store, not this module, decides who won.
import { Id, type ApprovalRequest, type SwarmReview } from "../../contracts";
import type { BotIdentity } from "./bot";
import type { BoltLike } from "./socket";
import type { SlackService } from "./types";

export const APPROVE_ACTION_ID = "nexus.approve";
export const REJECT_ACTION_ID = "nexus.reject";
export const APPROVAL_BLOCK_ID = "nexus.approval";

export type SlackDecision = "approved" | "rejected";
export interface ResolveResult { won: boolean; approval: ApprovalRequest }
/** approvals.resolve in the host. First human answer wins; `won` is false when someone had already decided. */
export type ResolveApproval = (approvalId: string, decision: SlackDecision, by: { via: "slack"; userId: string }) => Promise<ResolveResult>;

export type BotMessages = Pick<SlackService, "postAsBot" | "updateBotMessage">;

const MAX_APPROVAL_ID = 128;
const VERDICT_LABEL = { looks_good: "looks good", concerns: "concerns", do_not_merge: "do not merge" } as const;

const ENTITY: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** Escapes Slack mrkdwn control characters. Everything not authored by Nexus (reasons, commands, summaries, notes) passes through this. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/[&<>]/g, c => ENTITY[c]);
}

/**
 * Escapes first, then cuts so the ESCAPED text is at most `max` characters, always on a whole entity (never inside "&amp;").
 * Backticks become "'" so the text cannot close the code span or block it is shown in.
 */
export function escapeAndTruncate(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    const piece = ch === "`" ? "'" : (ENTITY[ch] ?? ch);
    if (out.length + piece.length > max - 1) return `${out}…`;
    out += piece;
  }
  return out;
}

/** Untrusted text on one line inside an inline code span: newlines and tabs collapse, so it cannot break out of the span. */
function inline(text: string, max: number): string {
  return `\`${escapeAndTruncate(text.replace(/[\r\n\t\u2028\u2029]+/g, " ↵ "), max)}\``;
}

/** Untrusted multi-line text inside a code block: Slack does not interpret *, _, ~ or links there, and a fake decision line stays quoted. */
function block(text: string, max: number): string {
  return `\`\`\`\n${escapeAndTruncate(text, max)}\n\`\`\``;
}

const mrkdwn = (text: string) => ({ type: "mrkdwn", text, verbatim: true });   // verbatim: no auto-linking of @names, #channels or urls

function describeAction(action: ApprovalRequest["action"]): string {
  switch (action.kind) {
    case "run_command": return `Run command: ${inline(action.command, 1_000)}`;
    case "write_outside_scope": return `Write outside the session worktree: ${inline(action.path, 500)}`;
    case "commit": return `Commit: ${inline(action.message, 1_000)}`;
    case "other": return `Other: ${inline(action.description, 1_000)}`;
  }
}

/** The Slack-visible name of whoever decided. Slack ids render as mentions; anything else is untrusted text in a code span. */
function deciderLabel(by: NonNullable<ApprovalRequest["decidedBy"]>): string {
  if (by.via === "slack" && /^[UW][A-Z0-9_]{2,}$/.test(by.userId)) return `<@${by.userId}>`;
  const via = by.via === "auth0_push" ? "phone push" : by.via === "app" ? "Nexus" : "Slack";
  return `${inline(by.userId, 100)} (${via})`;
}

function reviewSection(review: SwarmReview): unknown[] {
  const note = (text: string) => [{ type: "context", elements: [mrkdwn(text)] }];
  if (review.status === "running") return note("_Swarm review running (model-written, advisory)…_");
  if (review.status === "unavailable" || !review.verdict) return note("_Swarm review unavailable: decide without it._");
  const head = `*Swarm review* (model-written, advisory; ran off this machine): *${VERDICT_LABEL[review.verdict]}*`;
  const out: unknown[] = [{ type: "section", text: mrkdwn(review.summary ? `${head}\n${block(review.summary, 800)}` : head) }];
  const judges = (review.judges ?? []).slice(0, 6);   // slice first, then escape only what is shown
  if (judges.length) out.push({ type: "context", elements: [mrkdwn(judges.map(j => `• ${inline(j.modelId, 60)}: ${VERDICT_LABEL[j.verdict]}. ${inline(j.notes, 200)}`).join("\n"))] });
  return out;
}

/** Renders the approval message: details, an optional swarm verdict, then buttons while undecided or "Decided by ..." once decided. */
export function renderApproval(approval: ApprovalRequest, review?: SwarmReview, decidedByName?: string): { text: string; blocks: unknown[] } {
  const blocks: unknown[] = [
    { type: "section", text: mrkdwn(`*Approval needed* · session ${inline(approval.sessionId, 80)}\n${describeAction(approval.action)}`) },
    { type: "section", text: mrkdwn(`*Reason (model-written):*\n${block(approval.reason, 1_200)}`) },
  ];
  if (review) blocks.push(...reviewSection(review));
  if (approval.decision && approval.decidedBy) {
    const verb = approval.decision === "approved" ? "Approved" : "Rejected";
    blocks.push({ type: "section", text: mrkdwn(`*${verb}.* Decided by ${deciderLabel(approval.decidedBy)}`) });
    return { text: `${verb} by ${escapeAndTruncate(decidedByName ?? approval.decidedBy.userId, 100)}: ${describeFallback(approval)}`, blocks };
  }
  blocks.push({
    type: "actions", block_id: APPROVAL_BLOCK_ID,
    elements: [
      { type: "button", action_id: APPROVE_ACTION_ID, style: "primary", value: approval.id, text: { type: "plain_text", text: "APPROVE" } },
      { type: "button", action_id: REJECT_ACTION_ID, style: "danger", value: approval.id, text: { type: "plain_text", text: "REJECT" } },
    ],
  });
  return { text: `Approval needed: ${describeFallback(approval)}`, blocks };
}

function describeFallback(approval: ApprovalRequest): string {
  const a = approval.action;
  const raw = a.kind === "run_command" ? a.command : a.kind === "write_outside_scope" ? a.path : a.kind === "commit" ? a.message : a.description;
  return escapeAndTruncate(`${a.kind}: ${raw.replace(/\s+/g, " ")}`, 200);
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

export type IgnoredReason = "bad_payload" | "bad_card" | "not_human" | "resolve_failed" | "update_failed";

export interface InteractivityDeps {
  resolve: ResolveApproval;
  bot: Pick<SlackService, "updateBotMessage">;
  /** The Nexus bot's own user id, bot id and workspace id (auth.test). Without a team id every click is refused. */
  botIdentity: () => Promise<BotIdentity>;
  /** The stored approval. A click is accepted only on the card its slackMessage points to. */
  getApproval: (approvalId: string) => ApprovalRequest | undefined | Promise<ApprovalRequest | undefined>;
  /** The swarm review to show for an approval, if there is one. */
  getReview?: (approvalId: string) => SwarmReview | undefined;
  /** Observability without secrets: why a click was ignored or failed. */
  onIgnored?: (reason: IgnoredReason) => void;
}

/** Registers the APPROVE and REJECT handlers. Each one acks first, ties the click to its card, verifies the clicker, resolves once, then updates the card. */
export function registerInteractivity(app: BoltLike, deps: InteractivityDeps): void {
  const handle = (decision: SlackDecision) => async ({ ack, body, action }: Parameters<Parameters<BoltLike["action"]>[1]>[0]): Promise<void> => {
    await ack();
    const ignore = (r: IgnoredReason) => { try { deps.onIgnored?.(r); } catch { /* observer only */ } };
    const clickerId = body.user?.id;
    const channelId = body.container?.channel_id;
    const ts = body.container?.message_ts;
    const idCheck = Id.safeParse(action.value);
    if (!idCheck.success || idCheck.data.length > MAX_APPROVAL_ID || typeof clickerId !== "string" || !clickerId || !channelId || !ts) return ignore("bad_payload");
    const approvalId = idCheck.data;

    let me: BotIdentity;
    let approval: ApprovalRequest | undefined;
    try { [me, approval] = await Promise.all([deps.botIdentity(), deps.getApproval(approvalId)]); }
    catch { return ignore("bad_card"); }

    // Tie the click to its card: our own bot's message, our own block, and the exact message the approval was posted as.
    const fromBot = body.message?.user === me.userId || (me.botId !== undefined && body.message?.bot_id === me.botId);
    if (action.block_id !== APPROVAL_BLOCK_ID || !fromBot || body.message?.ts !== ts
      || !approval || approval.id !== approvalId || approval.slackMessage?.channelId !== channelId || approval.slackMessage.ts !== ts) return ignore("bad_card");

    const update = async (a: ApprovalRequest) => {
      const { text, blocks } = renderApproval(a, deps.getReview?.(a.id));
      try { await deps.bot.updateBotMessage(channelId, ts, text, blocks); } catch { ignore("update_failed"); }
    };

    // Already decided somewhere: this card must not keep live buttons, whoever clicked.
    if (approval.decision) return void await update(approval);

    // Only a full, human member of the bot's own workspace decides. Fail closed.
    try {
      const u = (await app.client.users.info({ user: clickerId })).user;
      const sameTeam = !!me.teamId && body.team?.id === me.teamId && u?.team_id === me.teamId;
      if (!u || u.id !== clickerId || clickerId === me.userId || !sameTeam
        || u.is_bot !== false || u.deleted || u.is_restricted || u.is_ultra_restricted || u.is_stranger || u.is_app_user) return ignore("not_human");
    } catch { return ignore("not_human"); }

    try {
      const result = await deps.resolve(approvalId, decision, { via: "slack", userId: clickerId });
      await update(result.approval);   // the clicker when they won, whoever decided first on a conflict
    } catch {
      ignore("resolve_failed");
      // whatever happened, a card whose approval is now decided must not keep its buttons
      try { const latest = await deps.getApproval(approvalId); if (latest?.decision) await update(latest); } catch { /* best effort */ }
    }
  };
  app.action(APPROVE_ACTION_ID, handle("approved"));
  app.action(REJECT_ACTION_ID, handle("rejected"));
}
