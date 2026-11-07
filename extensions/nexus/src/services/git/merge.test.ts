import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCli } from "./git-cli";

let base: string, repo: string, git: GitCli;
const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
const write = (root: string, rel: string, text: string) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); };

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "nexus-merge-")));
  repo = path.join(base, "repo");
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "Human Dev"], ["user.email", "human@example.com"], ["commit.gpgsign", "false"]]) sh(repo, "config", k, v);
  write(repo, "a.txt", "one\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "first");
  git = new GitCli(repo, { isolatedConfig: true, sessionsDir: path.join(base, "sessions") });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

async function agentCommit(id: string, file: string, text: string) {
  const w = await git.createSessionWorktree({ sessionId: id, workspaceId: "w" });
  write(w.worktreePath, file, text);
  return git.commitIn(w.worktreePath, `agent ${id}`, id);
}

describe("mergeAgentBranch", () => {
  it("merges cleanly with a merge commit and never pushes", async () => {
    const agent = await agentCommit("s1", "new.txt", "agent\n");
    write(repo, "main.txt", "m\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "main work");
    const r = await git.mergeAgentBranch("s1");
    expect(r.ok).toBe(true);
    expect(r.mergeSha).toBe(sh(repo, "rev-parse", "HEAD"));
    expect(sh(repo, "rev-list", "--parents", "-n1", "HEAD").split(" ")).toHaveLength(3);
    expect(sh(repo, "rev-parse", "HEAD^2")).toBe(agent);
    expect(sh(repo, "status", "--porcelain")).toBe("");
  });
  it("aborts a conflicting merge and leaves the checkout clean", async () => {
    await agentCommit("s1", "a.txt", "agent line\n");
    write(repo, "a.txt", "main line\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "main edit");
    const head = sh(repo, "rev-parse", "HEAD");
    const r = await git.mergeAgentBranch("s1");
    expect(r.ok).toBe(false);
    expect(r.mergeSha).toBeUndefined();
    expect(r.message).toMatch(/conflicts in a\.txt/);
    expect(sh(repo, "status", "--porcelain")).toBe("");
    expect(sh(repo, "rev-parse", "HEAD")).toBe(head);
    expect(() => sh(repo, "rev-parse", "--verify", "--quiet", "MERGE_HEAD")).toThrow();
  });
  it("refuses a dirty checkout without touching it", async () => {
    await agentCommit("s1", "new.txt", "agent\n");
    write(repo, "a.txt", "my uncommitted work\n");
    const head = sh(repo, "rev-parse", "HEAD");
    const r = await git.mergeAgentBranch("s1");
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/uncommitted changes/) });
    expect(sh(repo, "rev-parse", "HEAD")).toBe(head);
    expect(sh(repo, "status", "--porcelain")).toBe("M a.txt");
  });
  it("refuses a missing branch, a detached HEAD and a bad id; reports an already merged branch", async () => {
    expect((await git.mergeAgentBranch("nope")).ok).toBe(false);
    await expect(git.mergeAgentBranch("x/y")).rejects.toThrow(/invalid session id/);
    await agentCommit("s1", "new.txt", "agent\n");
    sh(repo, "checkout", "-q", "--detach");
    expect((await git.mergeAgentBranch("s1")).message).toMatch(/detached HEAD/);
    sh(repo, "checkout", "-q", "main");
    expect((await git.mergeAgentBranch("s1")).ok).toBe(true);
    const again = await git.mergeAgentBranch("s1");
    expect(again.ok).toBe(true);
    expect(again.message).toMatch(/already merged/);
  });
});
