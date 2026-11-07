// The git service's public surface (PLAN 5.2 L2-05, L2-06, L2-07, L2-13, L2-14). Implemented by git-cli.ts and
// worktrees.ts in wave 2; faked by fake-git.ts. createSessionWorktree and removeSessionWorktree match Lane 1's GitPort.
// Every SHA is a full 40-char lowercase hex string and every time is ISO 8601 with an offset (git %cI): the store refuses others.
import type { Req, Res } from "../../contracts";

export type CommitDetail = Res<"git.commit.show">;
export type BranchInfo = Res<"git.branches">[number];
export type MergeResult = Res<"git.mergeAgentBranch">;
export type CommitLookup = Req<"git.commit.show">;

/** A full 40-char lowercase hex SHA. */
export type FullSha = string;

/** One commit as the watcher needs it. */
export interface LogEntry {
  sha: FullSha;
  parents: FullSha[];
  authorName: string;
  /** ISO 8601 with an offset (git %cI). */
  committedAt: string;
  subject: string;
  /** The Nexus-Agent trailer's session id, when an agent made this commit. */
  agentSessionId?: string;
}

/** A ref the watcher diffs between scans: local branches, tags and remote branches. */
export interface RefInfo {
  name: string;          // "main", "lane-2", "v1", "origin/main"
  kind: "branch" | "tag" | "remote";
  sha: FullSha;          // for an annotated tag, the commit it points at
}

export interface SessionWorktree {
  branch: string;        // nexus/agent-<id>
  worktreePath: string;
  baseCommit: FullSha;
  baseBranch: string;    // non-empty: its family is the event's orbit, so a detached HEAD is refused
}

export interface GitService {
  /** sha1 of the first root commit: stable per repo. */
  workspaceId(): Promise<string>;
  /** Newest first, across all refs, committed at or after `since` when given. */
  log(options?: { since?: string }): Promise<LogEntry[]>;
  show(sha: FullSha): Promise<CommitDetail>;
  branches(): Promise<BranchInfo[]>;
  /** Every branch, tag and remote ref with the commit it points at. */
  refs(): Promise<RefInfo[]>;
  /** Branch names whose history contains the commit (git branch --contains), for mapping a merge's source orbit. */
  branchesContaining(sha: FullSha): Promise<string[]>;
  /** Full SHA of a ref, HEAD by default. */
  headOf(ref?: string): Promise<FullSha>;
  /** True if `sha` is an ancestor of (or equal to) `ref`, HEAD by default. */
  contains(sha: FullSha, ref?: string): Promise<boolean>;
  /** A file's text at a commit (git show <commit>:<path>), or undefined if it did not exist there. `path` is repo-relative. */
  fileAt(commit: FullSha, path: string): Promise<string | undefined>;
  /** True if the file has uncommitted changes in the user's checkout. */
  isDirty(path: string): Promise<boolean>;

  createSessionWorktree(input: { sessionId: string; workspaceId: string }): Promise<SessionWorktree>;
  removeSessionWorktree(sessionId: string): Promise<void>;
  /** Unified diff of the worktree against `baseCommit`, limited to `paths` when given. Produced by git, never by a model. */
  diff(worktreePath: string, baseCommit: FullSha, paths?: string[]): Promise<string>;
  /** Commits everything in the worktree to its session branch as the human's identity, with a `Nexus-Agent: <sessionId>` trailer. */
  commitIn(worktreePath: string, message: string, sessionId: string): Promise<FullSha>;
  /** Merges nexus/agent-<id> into the user's current branch; a conflict aborts cleanly with ok false. Never pushes. */
  mergeAgentBranch(sessionId: string): Promise<MergeResult>;
}
