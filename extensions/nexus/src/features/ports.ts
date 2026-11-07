import type { AgentEvent, AgentSession, ApprovalRequest, DecidedBy, ModelCallReceipt, NexusEvent, SwarmReview, Task, TaskPlan, Thread } from "../contracts";
import type { AgentReqOut, AgentResIn } from "../agent/process-host";

// What Lane 1's controllers need from the rest of the extension host. These are narrow, Lane-1-owned ports: Lane 2's
// services (event store, git, gate, Slack) are adapted to them when their interfaces land, so no controller imports a
// Lane 2 path and no lane waits on another. Everything crosses as contract types.

export interface Clock {
  now(): string;                       // ISO time
  newId(prefix: string): string;       // unique, time-sortable ids
}

export interface DecideResult {
  approval: ApprovalRequest;
  /** True only for the call that set the decision; every later call sees the winner with won = false. */
  won: boolean;
}

export interface StorePort {
  putTask(task: Task): Promise<void>;
  getTask(id: string): Promise<Task | undefined>;
  listTasks(): Promise<Task[]>;
  putSession(session: AgentSession): Promise<void>;
  getSession(id: string): Promise<AgentSession | undefined>;
  listSessions(): Promise<AgentSession[]>;
  appendAgentEvent(event: AgentEvent): Promise<void>;
  agentEvents(sessionId: string, fromSeq: number): Promise<AgentEvent[]>;
  putApproval(approval: ApprovalRequest): Promise<void>;
  getApproval(id: string): Promise<ApprovalRequest | undefined>;
  listApprovals(): Promise<ApprovalRequest[]>;
  /** Conditional update: sets the decision only while it is still undecided (first human answer wins, on any machine). */
  decideApproval(id: string, decision: "approved" | "rejected", decidedBy: DecidedBy, at: string): Promise<DecideResult>;
  putNexusEvent(event: NexusEvent): Promise<void>;
  putReview(review: SwarmReview): Promise<void>;
  /** The latest review for an approval, if any. */
  getReviewForApproval(approvalId: string): Promise<SwarmReview | undefined>;
  putReceipt(receipt: ModelCallReceipt): Promise<void>;
  /** Receipts oldest first, for one session or all. */
  listReceipts(sessionId?: string): Promise<ModelCallReceipt[]>;
  putPlan(plan: TaskPlan): Promise<void>;
  getPlan(id: string): Promise<TaskPlan | undefined>;
}

export interface SessionWorktree {
  branch: string;                      // nexus/agent-<id>
  worktreePath: string;
  baseCommit: string;                  // full SHA
  baseBranch: string;                  // the branch the session was based on (its family is the event's orbit)
}

export interface GitPort {
  /** Creates the session's own worktree and branch from the current commit. Never touches the user's checkout. */
  createSessionWorktree(input: { sessionId: string; workspaceId: string }): Promise<SessionWorktree>;
  /** Removes a session's worktree and branch again when the session could not start. Optional: the git service may keep them. */
  removeSessionWorktree?(sessionId: string): Promise<void>;
}

export interface SlackPort {
  getThread(channelId: string, threadTs: string): Promise<Thread>;
}

/** The requests that need the session's worktree; Lane 2's gate answers them (paths, allowlist, approvals). */
export type GateRequestName = "fs.read" | "fs.write" | "fs.list" | "cmd.run" | "git.diff" | "git.commit";

export interface GatePort {
  request<K extends GateRequestName>(session: AgentSession, name: K, body: AgentReqOut<K>): Promise<AgentResIn<K>>;
}

export type Unsubscribe = () => void;
