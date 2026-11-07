// The git service's public surface (PLAN 5.2 L2-05, L2-06). Implemented by git-cli.ts and worktrees.ts in wave 2; faked by
// fake-git.ts. createSessionWorktree and removeSessionWorktree match Lane 1's GitPort, so its controllers can use it directly.
import type { Req, Res } from "../../contracts";

export type CommitDetail = Res<"git.commit.show">;
export type BranchInfo = Res<"git.branches">[number];
export type MergeResult = Res<"git.mergeAgentBranch">;
export type CommitLookup = Req<"git.commit.show">;

/** One commit as the watcher needs it. `committedAt` is ISO 8601 with an offset (git %cI), as the store requires. */
export interface LogEntry {
  sha: string;
  parents: string[];
  authorName: string;
  committedAt: string;
  subject: string;
  /** The Nexus-Agent trailer's session id, when an agent made this commit. */
  agentSessionId?: string;
}

export interface SessionWorktree {
  branch: string;        // nexus/agent-<id>
  worktreePath: string;
  baseCommit: string;    // full 40-char SHA
  baseBranch: string;    // non-empty: its family is the event's orbit, so a detached HEAD must be refused
}

export interface GitService {
  /** sha1 of the first root commit: stable per repo. */
  workspaceId(): Promise<string>;
  /** Newest first, across all refs. */
  log(options?: { since?: string }): Promise<LogEntry[]>;
  show(sha: string): Promise<CommitDetail>;
  branches(): Promise<BranchInfo[]>;
  /** Full SHA of a ref, HEAD by default. */
  headOf(ref?: string): Promise<string>;

  createSessionWorktree(input: { sessionId: string; workspaceId: string }): Promise<SessionWorktree>;
  removeSessionWorktree(sessionId: string): Promise<void>;
  /** Unified diff of the worktree against its base, produced by git, never by a model. */
  diff(worktreePath: string): Promise<string>;
  /** Commits everything in the worktree as the human's identity, with a `Nexus-Agent: <sessionId>` trailer. Returns the full SHA. */
  commitIn(worktreePath: string, message: string, sessionId: string): Promise<string>;
  /** Merges nexus/agent-<id> into the user's current branch; a conflict aborts cleanly with ok false. Never pushes. */
  mergeAgentBranch(sessionId: string): Promise<MergeResult>;
}
