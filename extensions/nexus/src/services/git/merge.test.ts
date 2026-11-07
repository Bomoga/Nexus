import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCli } from "./git-cli";
import { emptyGitConfig } from "./empty-config";

let base: string, repo: string, git: GitCli;
const env = { ...process.env, GIT_CONFIG_GLOBAL: emptyGitConfig(), GIT_CONFIG_SYSTEM: emptyGitConfig(), GIT_CONFIG_NOSYSTEM: "1" };
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
  return git.commitIn(w.worktreePath, `agent ${id}`, id, await git.diff(w.worktreePath, w.baseCommit));
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
  it("always makes a merge commit, even when a fast-forward was possible", async () => {
    const agent = await agentCommit("s1", "new.txt", "agent\n");
    const before = sh(repo, "rev-parse", "HEAD");
    const r = await git.mergeAgentBranch("s1");
    expect(r.ok).toBe(true);
    expect(r.mergeSha).not.toBe(agent);
    expect(sh(repo, "rev-parse", "HEAD^1")).toBe(before);
    expect(sh(repo, "rev-parse", "HEAD^2")).toBe(agent);
  });
  it("fires no hooks of the user's repository", async () => {
    const log = path.join(base, "hooks.log");
    await agentCommit("s1", "new.txt", "agent\n");
    write(repo, "m.txt", "m\n"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "main");
    for (const h of ["pre-merge-commit", "post-merge", "commit-msg", "reference-transaction", "post-checkout"]) {
      writeFileSync(path.join(repo, ".git/hooks", h), `#!/bin/sh\necho ${h} >> "${log}"\n`);
      chmodSync(path.join(repo, ".git/hooks", h), 0o755);
    }
    expect((await git.mergeAgentBranch("s1")).ok).toBe(true);
    expect(existsSync(log)).toBe(false);
  });
  it("records the merge under the repo's configured identity", async () => {
    await agentCommit("s1", "new.txt", "agent\n");
    process.env.GIT_COMMITTER_NAME = "Env Mallory";
    try { expect((await git.mergeAgentBranch("s1")).ok).toBe(true); } finally { delete process.env.GIT_COMMITTER_NAME; }
    expect(sh(repo, "log", "-1", "--format=%cn <%ce>")).toBe("Human Dev <human@example.com>");
  });
  it("refuses to overwrite an ignored file in the user's checkout", async () => {
    write(repo, ".gitignore", "secret.env\n"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "ignore");
    write(repo, "secret.env", "MY_REAL_SECRET=1\n");
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    write(w.worktreePath, ".gitignore", "\n"); write(w.worktreePath, "secret.env", "AGENT=1\n");
    await git.commitIn(w.worktreePath, "agent", "s1", await git.diff(w.worktreePath, w.baseCommit));
    const head = sh(repo, "rev-parse", "HEAD");
    const r = await git.mergeAgentBranch("s1");
    expect(r.ok).toBe(false);
    expect(readFileSync(path.join(repo, "secret.env"), "utf8")).toBe("MY_REAL_SECRET=1\n");
    expect(sh(repo, "rev-parse", "HEAD")).toBe(head);
    expect(sh(repo, "status", "--porcelain")).toBe("");
  });

  async function refusedWith(setup: () => void, agentFiles: Record<string, string>, keep: Record<string, string>) {
    setup();
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    write(w.worktreePath, ".gitignore", "\n");
    for (const [f, text] of Object.entries(agentFiles)) write(w.worktreePath, f, text);
    await git.commitIn(w.worktreePath, "agent", "s1", await git.diff(w.worktreePath, w.baseCommit));
    const head = sh(repo, "rev-parse", "HEAD");
    expect((await git.mergeAgentBranch("s1")).ok).toBe(false);
    for (const [f, text] of Object.entries(keep)) expect([f, readFileSync(path.join(repo, f), "utf8")]).toEqual([f, text]);
    expect(sh(repo, "rev-parse", "HEAD")).toBe(head);
  }

  it("refuses when the branch differs from an ignored file only by letter case", async () => {
    await refusedWith(() => {
      write(repo, ".gitignore", "secret.env\ndata/\n"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "ignore");
      write(repo, "secret.env", "MINE\n");
    }, { "Secret.env": "AGENT\n" }, { "secret.env": "MINE\n" });
  });

  it("refuses when the branch writes inside an ignored directory, matched case-insensitively", async () => {
    await refusedWith(() => {
      write(repo, ".gitignore", "data/\n"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "ignore");
      write(repo, "data/x", "MINE\n");
    }, { "Data/x": "AGENT\n" }, { "data/x": "MINE\n" });
  });

  it("refuses when the branch needs a directory where the user has an ignored file", async () => {
    await refusedWith(() => {
      write(repo, ".gitignore", "cache\n"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "ignore");
      write(repo, "cache", "MINE\n");
    }, { "cache/x": "AGENT\n" }, { "cache": "MINE\n" });
  });
});
