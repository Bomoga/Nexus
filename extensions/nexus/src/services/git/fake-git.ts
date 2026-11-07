// In-memory GitService for tests and fixture-first development. Touches no repository.
import { fx } from "../../contracts/fixtures";
import type { BranchInfo, CommitDetail, GitService, LogEntry, MergeResult, SessionWorktree } from "./types";

const clone = <T>(value: T): T => structuredClone(value);
const SHA = fx.session.baseCommit;

export class FakeGit implements GitService {
  private commits: LogEntry[] = [{ sha: SHA, parents: [], authorName: "Adrian", committedAt: "2026-11-06T22:00:00-05:00", subject: "add cart module" }];
  private worktrees = new Map<string, SessionWorktree>();
  private diffs = new Map<string, string>();
  /** Test hook: the next mergeAgentBranch conflicts. */
  conflictNextMerge = false;
  /** Test hook: createSessionWorktree fails as it would on a detached HEAD. */
  detachedHead = false;

  async workspaceId() { return "ws_fake"; }
  async log() { return clone(this.commits); }
  async show(sha: string): Promise<CommitDetail> {
    const c = this.commits.find(x => x.sha === sha);
    if (!c) throw new Error(`unknown commit ${sha}`);
    return { sha: c.sha, subject: c.subject, body: "", author: c.authorName, at: c.committedAt, parents: [...c.parents], files: [] };
  }
  async branches(): Promise<BranchInfo[]> {
    const agents = [...this.worktrees.values()].map(w => ({ name: w.branch, head: w.baseCommit, isCurrent: false, isAgent: true }));
    return [{ name: "main", head: this.commits[0].sha, isCurrent: true, isAgent: false }, ...agents];
  }
  async headOf() { return this.commits[0].sha; }

  async createSessionWorktree(input: { sessionId: string; workspaceId: string }): Promise<SessionWorktree> {
    if (this.detachedHead) throw new Error("cannot start a session on a detached HEAD");
    const w = { branch: `nexus/agent-${input.sessionId}`, worktreePath: `/fake/sessions/${input.sessionId}`, baseCommit: this.commits[0].sha, baseBranch: "main" };
    this.worktrees.set(input.sessionId, w);
    return clone(w);
  }
  async removeSessionWorktree(sessionId: string) { this.worktrees.delete(sessionId); }

  /** Test hook: what diff() returns for a worktree. */
  setDiff(worktreePath: string, diff: string) { this.diffs.set(worktreePath, diff); }
  async diff(worktreePath: string) { return this.diffs.get(worktreePath) ?? ""; }

  async commitIn(worktreePath: string, message: string, sessionId: string) {
    if (![...this.worktrees.values()].some(w => w.worktreePath === worktreePath)) throw new Error(`unknown worktree ${worktreePath}`);
    const sha = (this.commits.length.toString(16) + SHA).slice(0, 40);
    this.commits.unshift({ sha, parents: [this.commits[0].sha], authorName: "Adrian", committedAt: "2026-11-06T23:00:00-05:00", subject: message.split("\n")[0], agentSessionId: sessionId });
    return sha;
  }

  async mergeAgentBranch(sessionId: string): Promise<MergeResult> {
    if (!this.worktrees.has(sessionId)) return { ok: false, message: `no branch for session ${sessionId}` };
    if (this.conflictNextMerge) { this.conflictNextMerge = false; return { ok: false, message: "merge conflict; aborted, nothing changed" }; }
    return { ok: true, mergeSha: this.commits[0].sha, message: "merged" };
  }
}
