import type { z } from "zod";
import type { AgentRequestName, AgentRequests, AgentSession, ApprovalAction, ApprovalRequest } from "../../contracts";

// The agent gate's public surface (PLAN 5.2 L2-13). Every tool request from an agent session passes through here.
// `request` matches Lane 1's GatePort, so its controllers can use a Gate directly.

/** The requests that need the session's worktree. */
export type GateRequestName = Extract<AgentRequestName, "fs.read" | "fs.write" | "fs.list" | "cmd.run" | "git.diff" | "git.commit">;

export type GateRequest<K extends GateRequestName> = z.output<(typeof AgentRequests)[K]["req"]>;
export type GateResponse<K extends GateRequestName> = z.input<(typeof AgentRequests)[K]["res"]>;

export interface Gate {
  /** Resolves a path inside the session's worktree, or waits on a human; never writes outside it silently. */
  request<K extends GateRequestName>(session: AgentSession, name: K, body: GateRequest<K>): Promise<GateResponse<K>>;
}

/** What the gate needs from Lane 1's approvals controller, so the gate imports no Lane 1 code. */
export interface ApprovalsHook {
  /** Creates the request and resolves once a human decides. There is no timeout: an undecided request keeps waiting. */
  create(input: { session: AgentSession; action: ApprovalAction; reason: string; diffPreview?: string }): Promise<GateApprovalOutcome>;
}

export interface GateApprovalOutcome {
  approvalId: ApprovalRequest["id"];
  decision: NonNullable<ApprovalRequest["decision"]>;
}
