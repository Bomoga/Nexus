import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCli } from "./git-cli";

let base: string, repo: string, sessions: string, git: GitCli;
const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
const write = (root: string, rel: string, text: string | Buffer) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); };

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "nexus-wt-")));
  repo = path.join(base, "repo");
  sessions = path.join(base, "sessions");
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.name", "Human Dev");
  sh(repo, "config", "user.email", "human@example.com");
  sh(repo, "config", "commit.gpgsign", "false");
  write(repo, "a.txt", "one\ntwo\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "first");
  git = new GitCli(repo, { isolatedConfig: true, sessionsDir: sessions });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("createSessionWorktree", () => {
  it("creates the worktree on nexus/agent-<id> outside the checkout and leaves the checkout alone", async () => {
    write(repo, "wip.txt", "uncommitted\n");
    const head = sh(repo, "rev-parse", "HEAD");
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    expect(w).toEqual({ branch: "nexus/agent-s1", worktreePath: path.join(sessions, "s1"), baseCommit: head, baseBranch: "main" });
    expect(sh(w.worktreePath, "symbolic-ref", "--short", "HEAD")).toBe("nexus/agent-s1");
    expect(sh(repo, "rev-parse", "HEAD")).toBe(head);
    expect(sh(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(sh(repo, "status", "--porcelain")).toBe("?? wip.txt");
  });
  it("refuses a detached HEAD, bad ids and a sessions dir inside the checkout", async () => {
    await expect(git.createSessionWorktree({ sessionId: "../x", workspaceId: "w" })).rejects.toThrow(/invalid session id/);
    await expect(git.createSessionWorktree({ sessionId: "a b", workspaceId: "w" })).rejects.toThrow(/invalid session id/);
    await expect(git.createSessionWorktree({ sessionId: "", workspaceId: "w" })).rejects.toThrow(/invalid session id/);
    await expect(new GitCli(repo, { isolatedConfig: true, sessionsDir: path.join(repo, "inside") }).createSessionWorktree({ sessionId: "s1", workspaceId: "w" })).rejects.toThrow(/outside the user's checkout/);
    sh(repo, "checkout", "-q", "--detach");
    await expect(git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" })).rejects.toThrow(/detached HEAD/);
    expect(existsSync(path.join(sessions, "s1"))).toBe(false);
  });
});

describe("diff", () => {
  it("includes edits, untracked files and binary files, and honors paths", async () => {
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    write(w.worktreePath, "a.txt", "one\ntwo\nthree\n");
    write(w.worktreePath, "new dir/new file.txt", "fresh\n");
    write(w.worktreePath, "blob.bin", Buffer.from([0, 1, 2, 3, 0, 255]));
    const all = await git.diff(w.worktreePath, w.baseCommit);
    expect(all).toContain("+three");
    expect(all).toContain("diff --git a/new dir/new file.txt b/new dir/new file.txt");
    expect(all).toContain("+fresh");
    expect(all).toMatch(/Binary files .*blob\.bin differ/);
    expect(await git.diff(w.worktreePath, w.baseCommit)).toBe(all);   // stable: the gate compares it before and after approval
    const only = await git.diff(w.worktreePath, w.baseCommit, ["a.txt"]);
    expect(only).toContain("a.txt");
    expect(only).not.toContain("new file.txt");
    await expect(git.diff(w.worktreePath, w.baseCommit, ["../x"])).rejects.toThrow(/invalid path/);
    await expect(git.diff(w.worktreePath, "main")).rejects.toThrow(/invalid commit sha/);
  });
  it("refuses a path outside the sessions directory, including the user's checkout and a symlink to it", async () => {
    const sha = sh(repo, "rev-parse", "HEAD");
    await expect(git.diff(repo, sha)).rejects.toThrow(/refused/);
    mkdirSync(sessions, { recursive: true });
    symlinkSync(repo, path.join(sessions, "link"));
    await expect(git.diff(path.join(sessions, "link"), sha)).rejects.toThrow(/refused/);
    await expect(git.diff(path.join(base, "nope"), sha)).rejects.toThrow(/does not exist/);
  });
});

describe("commitIn", () => {
  it("commits everything with the human identity and the trailer, only on the session branch", async () => {
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    write(w.worktreePath, "a.txt", "changed\n");
    write(w.worktreePath, "added.txt", "added\n");
    const sha = await git.commitIn(w.worktreePath, "fix the thing", "s1");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sh(repo, "rev-parse", "nexus/agent-s1")).toBe(sha);
    expect(sh(repo, "rev-parse", "main")).toBe(w.baseCommit);
    expect(sh(repo, "log", "-1", "--format=%an <%ae>|%cn <%ce>", sha)).toBe("Human Dev <human@example.com>|Human Dev <human@example.com>");
    expect(sh(repo, "log", "-1", "--format=%(trailers:key=Nexus-Agent,valueonly)", sha)).toBe("s1");
    expect(sh(repo, "log", "-1", "--format=%s", sha)).toBe("fix the thing");
    expect(sh(repo, "show", "--name-only", "--format=", sha).split("\n").sort()).toEqual(["a.txt", "added.txt"]);
    expect((await git.log()).find(e => e.sha === sha)?.agentSessionId).toBe("s1");
    expect(await git.diff(w.worktreePath, w.baseCommit)).toContain("+changed");
  });
  it("refuses unset identity, a wrong session, a foreign worktree and an empty message", async () => {
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    await git.createSessionWorktree({ sessionId: "s2", workspaceId: "w" });
    write(w.worktreePath, "x.txt", "x\n");
    await expect(git.commitIn(w.worktreePath, "m", "s2")).rejects.toThrow(/different session/);
    await expect(git.commitIn(w.worktreePath, "  ", "s1")).rejects.toThrow(/invalid commit message/);
    await expect(git.commitIn(w.worktreePath, "m", "../s1")).rejects.toThrow(/invalid session id/);
    await expect(git.commitIn(repo, "m", "s1")).rejects.toThrow(/refused/);
    sh(w.worktreePath, "checkout", "-q", "-b", "other");
    await expect(git.commitIn(w.worktreePath, "m", "s1")).rejects.toThrow(/not on nexus\/agent-s1/);
    sh(w.worktreePath, "checkout", "-q", "nexus/agent-s1");
    sh(repo, "config", "--unset", "user.email");
    await expect(git.commitIn(w.worktreePath, "m", "s1")).rejects.toThrow(/user\.name and user\.email/);
  });
});

describe("removeSessionWorktree", () => {
  it("removes the worktree and an untouched branch", async () => {
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    write(w.worktreePath, "junk.txt", "junk\n");
    await git.removeSessionWorktree("s1");
    expect(existsSync(w.worktreePath)).toBe(false);
    expect(sh(repo, "branch", "--list", "nexus/agent-s1")).toBe("");
    await git.removeSessionWorktree("s1");   // idempotent
  });
  it("keeps a branch that holds commits", async () => {
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    write(w.worktreePath, "x.txt", "x\n");
    const sha = await git.commitIn(w.worktreePath, "work", "s1");
    await git.removeSessionWorktree("s1");
    expect(existsSync(w.worktreePath)).toBe(false);
    expect(sh(repo, "rev-parse", "nexus/agent-s1")).toBe(sha);
    await expect(git.removeSessionWorktree("a/b")).rejects.toThrow(/invalid session id/);
  });
});
