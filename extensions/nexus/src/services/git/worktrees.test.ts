import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitCli } from "./git-cli";
import { binaryPathsInDiff } from "./worktrees";
import { emptyGitConfig } from "./empty-config";

// Every test here runs several real git processes; on a loaded Windows machine one can exceed the 5 s default.
vi.setConfig({ testTimeout: 20_000 });

let base: string, repo: string, sessions: string, git: GitCli;
const env = { ...process.env, GIT_CONFIG_GLOBAL: emptyGitConfig(), GIT_CONFIG_SYSTEM: emptyGitConfig(), GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
const approve = async (w: { worktreePath: string; baseCommit: string }) => git.diff(w.worktreePath, w.baseCommit);
const commitAs = async (w: { worktreePath: string; baseCommit: string }, message: string, id: string) => git.commitIn(w.worktreePath, message, id, await approve(w));
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
    expect(all).toContain("GIT binary patch");
    expect(binaryPathsInDiff(all)).toEqual(["blob.bin"]);
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
    const sha = await commitAs(w, "fix the thing", "s1");
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
    await expect(git.commitIn(w.worktreePath, "m", "s2", "")).rejects.toThrow(/different session/);
    await expect(git.commitIn(w.worktreePath, "  ", "s1", "")).rejects.toThrow(/invalid commit message/);
    await expect(git.commitIn(w.worktreePath, "m", "../s1", "")).rejects.toThrow(/invalid session id/);
    await expect(git.commitIn(repo, "m", "s1", "")).rejects.toThrow(/refused/);
    sh(w.worktreePath, "checkout", "-q", "-b", "other");
    await expect(commitAs(w, "m", "s1")).rejects.toThrow(/not on nexus\/agent-s1/);
    sh(w.worktreePath, "checkout", "-q", "nexus/agent-s1");
    sh(repo, "config", "--unset", "user.email");
    await expect(commitAs(w, "m", "s1")).rejects.toThrow(/user\.name and user\.email/);
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
    const sha = await commitAs(w, "work", "s1");
    await git.removeSessionWorktree("s1");
    expect(existsSync(w.worktreePath)).toBe(false);
    expect(sh(repo, "rev-parse", "nexus/agent-s1")).toBe(sha);
    await expect(git.removeSessionWorktree("a/b")).rejects.toThrow(/invalid session id/);
  });
});

describe("commitIn bound to the approved diff", () => {
  it("refuses a binary swap whose blob id has the same 7-character prefix (full ids in the diff)", async () => {
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    write(w.worktreePath, "blob.bin", Buffer.from([0, 1, 2, 3]));
    const approved = await approve(w);
    expect(approved).toMatch(/index 0{40}\.\.[0-9a-f]{40}/);
    write(w.worktreePath, "blob.bin", Buffer.from([0, 9, 9, 9]));
    await expect(git.commitIn(w.worktreePath, "m", "s1", approved)).rejects.toThrow(/differ from the diff the human approved/);
    expect(sh(repo, "rev-parse", "nexus/agent-s1")).toBe(w.baseCommit);
  });
  it("refuses a write that lands between the approval and the commit, and a text change after approval", async () => {
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    write(w.worktreePath, "a.txt", "approved\n");
    const approved = await approve(w);
    expect(await approve(w)).toBe(approved);
    write(w.worktreePath, "a.txt", "UNSEEN\n");
    await expect(git.commitIn(w.worktreePath, "m", "s1", approved)).rejects.toThrow(/differ/);
    write(w.worktreePath, "a.txt", "approved\n");
    write(w.worktreePath, "extra.txt", "x\n");
    await expect(git.commitIn(w.worktreePath, "m", "s1", approved)).rejects.toThrow(/differ/);
  });
  it("cannot be reached by a write after staging: the commit holds exactly the approved content", async () => {
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    write(w.worktreePath, "a.txt", "approved\n");
    const approved = await approve(w);
    const headBefore = sh(w.worktreePath, "rev-parse", "HEAD");
    const p = git.commitIn(w.worktreePath, "m", "s1", approved);
    const timer = setInterval(() => write(w.worktreePath, "a.txt", "RACE " + Math.random() + "\n"), 1);
    let sha: string | undefined, err: unknown;
    try { sha = await p; } catch (e) { err = e; } finally { clearInterval(timer); }
    if (sha) {
      expect(sh(repo, "show", `${sha}:a.txt`)).toBe("approved");
    } else {
      // Refused either by the diff check or by git itself (a "short read" while the file changes under git add): no commit either way.
      expect(String(err)).toMatch(/differ from the diff|git add failed/);
      expect(sh(w.worktreePath, "rev-parse", "HEAD")).toBe(headBefore);
    }
  });
  it("commits a normal approved change, including untracked and deleted files, and leaves the worktree's index in step", async () => {
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    rmSync(path.join(w.worktreePath, "a.txt"));
    write(w.worktreePath, "n.txt", "n\n");
    const sha = await commitAs(w, "normal", "s1");
    expect(sh(repo, "show", "--name-status", "--format=", sha).split("\n").sort()).toEqual(["A\tn.txt", "D\ta.txt"]);
    expect(sh(w.worktreePath, "status", "--porcelain")).toBe("");
    await expect(commitAs(w, "again", "s1")).rejects.toThrow(/nothing to commit/);
  });
  it("ignores a worktree .gitattributes that marks text as binary, and flags binary patches", async () => {
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    write(w.worktreePath, ".gitattributes", "*.js binary\n");
    write(w.worktreePath, "evil.js", "steal()\n");
    const d = await approve(w);
    expect(binaryPathsInDiff(d)).toEqual(["evil.js"]);   // flagged, and the content is still in the patch (exact)
    expect(d).toContain("GIT binary patch");
    expect(binaryPathsInDiff("diff --git a/new dir/x.bin b/new dir/x.bin\nGIT binary patch\nliteral 1\n")).toEqual(["new dir/x.bin"]);
  });
  it("records the configured identity even when the commit would otherwise use another, and never fires hooks", async () => {
    const log = path.join(base, "hooks.log");
    for (const h of ["pre-commit", "commit-msg", "post-commit", "reference-transaction", "post-checkout"]) {
      writeFileSync(path.join(repo, ".git/hooks", h), `#!/bin/sh\necho ${h} >> "${log}"\n`);
      chmodSync(path.join(repo, ".git/hooks", h), 0o755);
    }
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    write(w.worktreePath, "x.txt", "x\n");
    const sha = await commitAs(w, "m", "s1");
    expect(existsSync(log)).toBe(false);
    expect(sh(repo, "log", "-1", "--format=%an|%ae|%cn|%ce", sha)).toBe("Human Dev|human@example.com|Human Dev|human@example.com");
  });
  it("takes the identity from the repo config, not from the environment", async () => {
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    write(w.worktreePath, "x.txt", "x\n");
    const saved = { ...process.env };
    process.env.GIT_AUTHOR_NAME = "Env Mallory"; process.env.GIT_COMMITTER_NAME = "Env Mallory";
    try {
      const sha = await commitAs(w, "m", "s1");
      expect(sh(repo, "log", "-1", "--format=%an|%cn", sha)).toBe("Human Dev|Human Dev");
    } finally { process.env = saved; }
  });
  it("keeps a forged trailer inside the message from standing in for the real one", async () => {
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    write(w.worktreePath, "x.txt", "x\n");
    const sha = await commitAs(w, "fix\n\nNexus-Agent: other", "s1");
    expect((await git.log()).find(e => e.sha === sha)?.agentSessionId).toBe("s1");
  });
});

describe("what the approved diff must show", () => {
  function nestedRepo(root: string) {
    const inner = path.join(root, "vendor");
    mkdirSync(inner, { recursive: true });
    sh(inner, "init", "-q", "-b", "main");
    sh(inner, "config", "user.name", "x"); sh(inner, "config", "user.email", "x@x"); sh(inner, "config", "commit.gpgsign", "false");
    write(inner, "lib.txt", "lib\n"); sh(inner, "add", "-A"); sh(inner, "commit", "-q", "-m", "lib");
    return sh(inner, "rev-parse", "HEAD");
  }
  it("shows a submodule with its full id even when .gitmodules or the user's config would hide it", async () => {
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    const inner = nestedRepo(w.worktreePath);
    write(w.worktreePath, ".gitmodules", `[submodule "vendor"]\n\tpath = vendor\n\turl = ./vendor\n\tignore = all\n`);
    sh(repo, "config", "diff.ignoreSubmodules", "all");
    sh(repo, "config", "diff.submodule", "log");
    const d = await git.diff(w.worktreePath, w.baseCommit);
    expect(d).toContain(`+Subproject commit ${inner}`);
    const sha = await git.commitIn(w.worktreePath, "m", "s1", d);
    expect(sh(repo, "ls-tree", sha, "vendor")).toContain(inner);
  });
});

describe("commit messages", () => {
  it("refuses a scissors line, which would let the message forge or hide the trailer", async () => {
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    write(w.worktreePath, "x.txt", "x\n");
    const scissors = "# ------------------------ >8 ------------------------";
    for (const message of [`fix\n\nNexus-Agent: forged\n${scissors}`, `fix\n${scissors}`, `fix\n--- >8 ---`]) {
      await expect(commitAs(w, message, "s1")).rejects.toThrow(/scissors/);
    }
    expect(sh(repo, "rev-list", "--count", "nexus/agent-s1")).toBe("1");
  });
  it("takes the identity from the repo config even when an includeIf would set another for the session branch", async () => {
    const other = path.join(base, "other.gitconfig");
    writeFileSync(other, "[user]\n\tname = Included Mallory\n\temail = m@example.com\n");
    sh(repo, "config", "includeIf.onbranch:nexus/**.path", other);
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    write(w.worktreePath, "x.txt", "x\n");
    const sha = await commitAs(w, "m", "s1");
    expect(sh(repo, "log", "-1", "--format=%an|%cn", sha)).toBe("Human Dev|Human Dev");
  });
});

/** Git for Windows marks a worktree's .git file hidden, and Windows refuses to overwrite a hidden file: remove it, then write. */
function rewriteGitFile(file: string, text: string) {
  rmSync(file, { force: true });
  writeFileSync(file, text);
}

describe("worktree and branch identity", () => {
  it("refuses a worktree whose .git file points at another session's entry", async () => {
    const a = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    await git.createSessionWorktree({ sessionId: "s2", workspaceId: "w" });
    const common = sh(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
    rewriteGitFile(path.join(a.worktreePath, ".git"), `gitdir: ${common}/worktrees/s2\n`);
    await expect(git.diff(a.worktreePath, a.baseCommit)).rejects.toThrow(/another worktree's entry|does not belong/);
  });

  it("refuses a worktree whose .git file was repointed at the user's repository", async () => {
    const w = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    write(w.worktreePath, "agent-new.txt", "x\n");
    rewriteGitFile(path.join(w.worktreePath, ".git"), `gitdir: ${repo}/.git\n`);
    await expect(git.diff(w.worktreePath, w.baseCommit)).rejects.toThrow(/does not belong to this repository/);
    await expect(git.commitIn(w.worktreePath, "m", "s1", "")).rejects.toThrow(/does not belong to this repository/);
    expect(sh(repo, "status", "--porcelain")).toBe("");
  });
  it("refuses a sessions directory that contains the repository", async () => {
    const g = new GitCli(repo, { isolatedConfig: true, sessionsDir: base });
    await expect(g.createSessionWorktree({ sessionId: "s1", workspaceId: "w" })).rejects.toThrow(/must not contain/);
    await expect(g.diff(repo, sh(repo, "rev-parse", "HEAD"))).rejects.toThrow(/must not contain/);
  });
  it("refuses to act when another nexus branch differs only by case", async () => {
    const head = sh(repo, "rev-parse", "HEAD");
    sh(repo, "update-ref", "refs/heads/nexus/agent-abc", head);
    sh(repo, "pack-refs", "--all");   // a loose file would collide on a case-insensitive file system
    sh(repo, "update-ref", "refs/heads/nexus/agent-ABC", head);
    await expect(git.removeSessionWorktree("abc")).rejects.toThrow(/only by letter case/);
    await expect(git.mergeAgentBranch("ABC")).rejects.toThrow(/only by letter case/);
    await expect(git.createSessionWorktree({ sessionId: "Abc", workspaceId: "w" })).rejects.toThrow(/only by letter case/);
    expect(sh(repo, "branch", "--list", "nexus/*").split("\n")).toHaveLength(2);
  });
  it("names the git subcommand in errors", async () => {
    const e = await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" }).then(() => git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" })).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/^git worktree failed: /);
  });
});
