import type { ApprovalRequest, DecidedBy } from "../contracts";

export type SlackApprovalResolver = (approvalId: string, decision: "approved" | "rejected", decidedBy: DecidedBy) => Promise<{ won: boolean; approval: ApprovalRequest }>;

/** Hands the approvals controller to Lane 2's Slack buttons; until this runs a Slack click is refused. No-op when Lane 2 gave no setter. */
export function connectSlackApprovals(l2: { setSlackApprovalResolver?(resolve: SlackApprovalResolver): void }, approvals: { resolve: SlackApprovalResolver }): void {
  l2.setSlackApprovalResolver?.((approvalId, decision, decidedBy) => approvals.resolve(approvalId, decision, decidedBy));
}
