// In-memory GitService for tests and fixture-first development. Touches no repository. Agent commits stay on their
// session branch; the user's branch moves only through mergeAgentBranch, which records a merge commit.
import { fx } from "../../contracts/fixtures";
import type { BranchInfo, CommitDetail, FullSha, GitService, LogEntry, MergeResult, RefInfo, SessionWorktree } from "./types";

const clone = <T>(value: T): T => structuredClone(value);
const BASE = fx.session.baseCommit;

export class FakeGit implements GitService {
  private commits = new Map<FullSha, LogEntry>([[BASE, { sha: BASE, parents: [], authorName: "Adrian", committedAt: "2026-11-06T22:00:00-05:00", subject: "add cart module" }]]);
  private heads = new Map<string, FullSha>([["main", BASE]]);
  private worktrees = new Map<string, SessionWorktree>();
  private files = new Map<string, string>();
  private dirty = new Set<string>();
  private diffs = new Map<string, string>();
  private counter = 0;
  /** Test hook: the next mergeAgentBranch conflicts. */
  conflictNextMerge = false;
  /** Test hook: createSessionWorktree fails as it would on a detached HEAD. */
  detachedHead = false;

  async workspaceId() { return "ws_fake"; }
  async log(options: { since?: string } = {}) {
    const since = options.since ? Date.parse(options.since) : -Infinity;
    return clone([...this.commits.values()].filter(c => Date.parse(c.committedAt) >= since).sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt)));
  }
  async show(sha: FullSha): Promise<CommitDetail> {
    const c = this.commits.get(sha);
    if (!c) throw new Error(`unknown commit ${sha}`);
    return { sha: c.sha, subject: c.subject, body: "", author: c.authorName, at: c.committedAt, parents: [...c.parents], files: [] };
  }
  async branches(): Promise<BranchInfo[]> {
    return [...this.heads].map(([name, head]) => ({ name, head, isCurrent: name === "main", isAgent: name.startsWith("nexus/agent-") }));
  }
  async refs(): Promise<RefInfo[]> { return [...this.heads].map(([name, sha]) => ({ name, kind: "branch" as const, sha })); }
  async branchesContaining(sha: FullSha) {
    const out: string[] = [];
    for (const [name, head] of this.heads) if (this.ancestor(sha, head)) out.push(name);
    return out;
  }
  async headOf(ref = "main") {
    const sha = this.heads.get(ref);
    if (!sha) throw new Error(`unknown ref ${ref}`);
    return sha;
  }
  async contains(sha: FullSha, ref = "main") { return this.ancestor(sha, await this.headOf(ref)); }

  /** Test hook: a file's text at a commit. */
  setFile(commit: FullSha, path: string, text: string) { this.files.set(`${commit}:${path}`, text); }
  async fileAt(commit: FullSha, path: string) { return this.files.get(`${commit}:${path}`); }
  /** Test hook: mark a file dirty in the user's checkout. */
  setDirty(path: string, dirty = true) { if (dirty) this.dirty.add(path); else this.dirty.delete(path); }
  async isDirty(path: string) { return this.dirty.has(path); }

  async createSessionWorktree(input: { sessionId: string; workspaceId: string }): Promise<SessionWorktree> {
    if (this.detachedHead) throw new Error("cannot start a session on a detached HEAD");
    const base = this.heads.get("main")!;
    const w = { branch: `nexus/agent-${input.sessionId}`, worktreePath: `/fake/sessions/${input.sessionId}`, baseCommit: base, baseBranch: "main" };
    this.worktrees.set(input.sessionId, w);
    this.heads.set(w.branch, base);
    return clone(w);
  }
  async removeSessionWorktree(sessionId: string) {
    const w = this.worktrees.get(sessionId);
    if (w) this.heads.delete(w.branch);
    this.worktrees.delete(sessionId);
  }

  /** Test hook: what diff() returns for a worktree, whole or per path. */
  setDiff(worktreePath: string, diff: string, path?: string) { this.diffs.set(`${worktreePath}|${path ?? ""}`, diff); }
  async diff(worktreePath: string, _baseCommit: FullSha, paths?: string[]) {
    if (!paths?.length) return this.diffs.get(`${worktreePath}|`) ?? "";
    return paths.map(p => this.diffs.get(`${worktreePath}|${p}`) ?? "").join("");
  }

  async commitIn(worktreePath: string, message: string, sessionId: string) {
    const w = [...this.worktrees.values()].find(x => x.worktreePath === worktreePath);
    if (!w) throw new Error(`unknown worktree ${worktreePath}`);
    const sha = this.newSha();
    this.commits.set(sha, { sha, parents: [this.heads.get(w.branch)!], authorName: "Adrian", committedAt: this.nextTime(), subject: message.split("\n")[0], agentSessionId: sessionId });
    this.heads.set(w.branch, sha);
    return sha;
  }

  async mergeAgentBranch(sessionId: string): Promise<MergeResult> {
    const w = this.worktrees.get(sessionId);
    if (!w) return { ok: false, message: `no branch for session ${sessionId}` };
    if (this.conflictNextMerge) { this.conflictNextMerge = false; return { ok: false, message: "merge conflict; aborted, nothing changed" }; }
    const sha = this.newSha();
    this.commits.set(sha, { sha, parents: [this.heads.get("main")!, this.heads.get(w.branch)!], authorName: "Adrian", committedAt: this.nextTime(), subject: `merge ${w.branch}` });
    this.heads.set("main", sha);
    return { ok: true, mergeSha: sha, message: "merged" };
  }

  private ancestor(sha: FullSha, head: FullSha): boolean {
    const seen = new Set<FullSha>();
    const stack = [head];
    while (stack.length) {
      const s = stack.pop()!;
      if (s === sha) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...(this.commits.get(s)?.parents ?? []));
    }
    return false;
  }
  private newSha(): FullSha { return (++this.counter).toString(16).padStart(8, "0") + BASE.slice(8); }
  private nextTime() { return new Date(Date.parse("2026-11-06T23:00:00-05:00") + this.counter * 60_000).toISOString(); }
}
