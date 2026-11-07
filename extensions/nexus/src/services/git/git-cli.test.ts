import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Requests } from "../../contracts";
import { GitCli } from "./git-cli";

let root: string;
let day = 0;
const win = process.platform === "win32";
const weird = win ? "weird name.txt" : "weird\nname.txt";   // a newline in a file name is not possible on Windows
let extraEnv: Record<string, string> = {};
const sh = (...args: string[]) => {
  const date = `2026-11-0${6 + Math.floor(day / 3)}T${String(10 + (day % 3)).padStart(2, "0")}:00:00-0500`;
  day++;
  return execFileSync("git", args, {
    cwd: root, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test Author", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test Author", GIT_COMMITTER_EMAIL: "t@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, ...extraEnv },
  }).trim();
};
const write = (rel: string, text: string) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); };
const commit = (msg: string) => { sh("add", "-A"); sh("-c", "commit.gpgsign=false", "commit", "-m", msg); return sh("rev-parse", "HEAD"); };

const shas: Record<string, string> = {};
let git: GitCli;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "nexus-git-"));
  sh("init", "-q", "-b", "main");
  write("a b.txt", "spaced\n");
  write(weird, "newline\n");
  write("ünï.txt", "unicode\n");
  write("src/x.ts", "one\ntwo\n");
  write("old.txt", "will be renamed\nline2\nline3\nline4\n");
  write("gone.txt", "bye\n");
  write("-dash.txt", "dash\n");
  shas.first = commit("first");
  sh("tag", "-a", "v1", "-m", "release one");
  sh("tag", "light");

  sh("switch", "-q", "-c", "lane-1");
  write("src/x.ts", "one\ntwo\nthree\n");
  write("new.txt", "a\nb\n");
  unlinkSync(path.join(root, "gone.txt"));
  renameSync(path.join(root, "old.txt"), path.join(root, "renamed.txt"));
  shas.lane = commit("lane work\n\nbody line 1\nbody line 2");

  sh("switch", "-q", "main");
  sh("switch", "-q", "-c", "nexus/agent-s1");
  write("agent.txt", "agent\n");
  shas.agent = commit("agent change\n\nNexus-Agent: s1");

  sh("switch", "-q", "main");
  write("main.txt", "m\n");
  shas.main = commit("main work");
  sh("-c", "commit.gpgsign=false", "merge", "--no-ff", "-m", "merge lane-1", "lane-1");
  shas.merge = sh("rev-parse", "HEAD");
  git = new GitCli(root, { isolatedConfig: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("GitCli read side", () => {
  it("derives a stable workspace id from the root commit", async () => {
    expect(await git.workspaceId()).toBe(createHash("sha1").update(shas.first).digest("hex"));
  });

  it("logs newest first with parents, ISO dates and the agent trailer", async () => {
    const log = await git.log();
    expect(log.map(e => e.subject)).toEqual(expect.arrayContaining(["first", "lane work", "agent change", "main work", "merge lane-1"]));
    for (const e of log) {
      expect(e.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(e.committedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d-05:00$/);
    }
    const times = log.map(e => Date.parse(e.committedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(log.find(e => e.sha === shas.agent)).toMatchObject({ agentSessionId: "s1", authorName: "Test Author" });
    expect(log.find(e => e.sha === shas.main)?.agentSessionId).toBeUndefined();
    expect(log.find(e => e.sha === shas.merge)?.parents).toHaveLength(2);
    expect(log.find(e => e.sha === shas.first)?.parents).toEqual([]);
  });

  it("filters the log by since", async () => {
    const all = await git.log();
    const cutoff = all[1].committedAt;
    const recent = await git.log({ since: cutoff });
    expect(recent.length).toBeLessThan(all.length);
    expect(recent.every(e => Date.parse(e.committedAt) >= Date.parse(cutoff))).toBe(true);
    await expect(git.log({ since: "--output=/tmp/x" })).rejects.toThrow(/invalid time/);
  });

  it("shows a commit in the git.commit.show shape with file statuses and counts", async () => {
    const d = await git.show(shas.lane);
    expect(Requests["git.commit.show"].res.parse(d)).toEqual(d);
    expect(d).toMatchObject({ sha: shas.lane, subject: "lane work", body: "body line 1\nbody line 2", author: "Test Author", parents: [shas.first] });
    const by = Object.fromEntries(d.files.map(f => [f.path, f]));
    expect(by["src/x.ts"]).toEqual({ path: "src/x.ts", status: "M", additions: 1, deletions: 0 });
    expect(by["new.txt"]).toEqual({ path: "new.txt", status: "A", additions: 2, deletions: 0 });
    expect(by["gone.txt"]).toEqual({ path: "gone.txt", status: "D", additions: 0, deletions: 1 });
    expect(by["renamed.txt"]).toMatchObject({ status: "R", additions: 0, deletions: 0 });
  });

  it("shows a root commit, odd file names and a merge commit", async () => {
    const root0 = await git.show(shas.first);
    expect(root0.parents).toEqual([]);
    const names = root0.files.map(f => f.path);
    expect(names).toEqual(expect.arrayContaining(["a b.txt", weird, "ünï.txt", "src/x.ts"]));
    expect(root0.files.every(f => f.status === "A")).toBe(true);
    const m = await git.show(shas.merge);
    expect(Requests["git.commit.show"].res.parse(m)).toEqual(m);
    expect(m.parents).toHaveLength(2);
    expect(m.files.map(f => f.path)).toContain("new.txt");   // against the first parent
  });

  it("lists branches with the current and agent flags", async () => {
    const b = await git.branches();
    expect(Requests["git.branches"].res.parse(b)).toEqual(b);
    expect(b.map(x => x.name).sort()).toEqual(["lane-1", "main", "nexus/agent-s1"]);
    expect(b.find(x => x.name === "main")).toEqual({ name: "main", head: shas.merge, isCurrent: true, isAgent: false });
    expect(b.find(x => x.name === "nexus/agent-s1")).toEqual({ name: "nexus/agent-s1", head: shas.agent, isCurrent: false, isAgent: true });
  });

  it("lists refs with annotated tags dereferenced to their commit", async () => {
    const refs = await git.refs();
    expect(refs.find(r => r.name === "v1")).toEqual({ name: "v1", kind: "tag", sha: shas.first });
    expect(refs.find(r => r.name === "light")).toEqual({ name: "light", kind: "tag", sha: shas.first });
    expect(refs.find(r => r.name === "lane-1")).toEqual({ name: "lane-1", kind: "branch", sha: shas.lane });
  });

  it("lists remote refs without the symbolic HEAD", async () => {
    sh("update-ref", "refs/remotes/origin/main", shas.main);
    sh("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const refs = await git.refs();
    expect(refs.find(r => r.kind === "remote")).toEqual({ name: "origin/main", kind: "remote", sha: shas.main });
    expect(refs.some(r => r.name === "origin/HEAD")).toBe(false);
  });

  it("answers branchesContaining, headOf and contains", async () => {
    expect((await git.branchesContaining(shas.lane)).sort()).toEqual(["lane-1", "main"]);
    expect(await git.branchesContaining(shas.agent)).toEqual(["nexus/agent-s1"]);
    expect(await git.headOf()).toBe(shas.merge);
    expect(await git.headOf("lane-1")).toBe(shas.lane);
    expect(await git.headOf("v1")).toBe(shas.first);
    await expect(git.headOf("nope")).rejects.toThrow(/unknown ref/);
    for (const bad of ["--all", "-x", "a..b", "a@{1}", "a\nb", "a\x01b", "a b", "", "a^", "a:b"]) await expect(git.headOf(bad)).rejects.toThrow(/invalid ref/);
    await expect(git.contains(shas.first, "a..b")).rejects.toThrow(/invalid ref/);
    expect(await git.contains(shas.lane)).toBe(true);
    expect(await git.contains(shas.agent)).toBe(false);
    expect(await git.contains(shas.agent, "nexus/agent-s1")).toBe(true);
    expect(await git.contains(shas.merge, "lane-1")).toBe(false);
  });

  it("reads a file at a commit, undefined when absent", async () => {
    expect(await git.fileAt(shas.first, "src/x.ts")).toBe("one\ntwo\n");
    expect(await git.fileAt(shas.lane, "src/x.ts")).toBe("one\ntwo\nthree\n");
    expect(await git.fileAt(shas.first, "a b.txt")).toBe("spaced\n");
    expect(await git.fileAt(shas.first, weird)).toBe("newline\n");
    expect(await git.fileAt(shas.first, "ünï.txt")).toBe("unicode\n");
    expect(await git.fileAt(shas.lane, "gone.txt")).toBeUndefined();
    expect(await git.fileAt(shas.first, "src")).toBeUndefined();   // a directory, not a file
    expect(await git.fileAt(shas.first, "nothing/here.ts")).toBeUndefined();
  });

  it("reports dirty files, including names with spaces and newlines", async () => {
    expect(await git.isDirty("src/x.ts")).toBe(false);
    write("src/x.ts", "changed\n");
    write(weird, "edited\n");
    write("fresh file.txt", "untracked\n");
    expect(await git.isDirty("src/x.ts")).toBe(true);
    expect(await git.isDirty(weird)).toBe(true);
    expect(await git.isDirty("fresh file.txt")).toBe(true);
    expect(await git.isDirty("a b.txt")).toBe(false);
    sh("checkout", "--", "src/x.ts", weird);
    unlinkSync(path.join(root, "fresh file.txt"));
    expect(await git.isDirty("src/x.ts")).toBe(false);
  });

  it("refuses bad SHAs and unsafe paths before running git", async () => {
    for (const bad of ["", "abc", shas.first.toUpperCase(), shas.first.slice(1), "--all", `${shas.first}\n`, "HEAD"]) {
      await expect(git.show(bad)).rejects.toThrow(/invalid commit sha/);
      await expect(git.branchesContaining(bad)).rejects.toThrow(/invalid commit sha/);
      await expect(git.contains(bad)).rejects.toThrow(/invalid commit sha/);
      await expect(git.fileAt(bad, "src/x.ts")).rejects.toThrow(/invalid commit sha/);
    }
    for (const bad of ["../secret", "src/../../secret", "/etc/passwd", "C:\\x", "..\\x", "", "a\0b", ".", "./", "./src/x.ts", "src/./x.ts", "src/", "a//b"]) {
      await expect(git.fileAt(shas.first, bad)).rejects.toThrow(/invalid path/);
      await expect(git.isDirty(bad)).rejects.toThrow(/invalid path/);
    }
  });

  it("reads and checks paths literally, after `--`", async () => {
    expect(await git.fileAt(shas.first, "-dash.txt")).toBe("dash\n");
    expect(await git.fileAt(shas.first, "-no-such")).toBeUndefined();
    expect(await git.fileAt(shas.first, ":(glob)*")).toBeUndefined();
    expect(await git.fileAt(shas.first, ":(top)src/x.ts")).toBeUndefined();
    expect(await git.fileAt(shas.first, "src/x.t?")).toBeUndefined();
    write("-dash.txt", "changed\n");
    expect(await git.isDirty("-dash.txt")).toBe(true);
    expect(await git.isDirty(":(glob)*")).toBe(false);   // a pathspec magic string is a literal name, not "everything"
    expect(await git.isDirty("*.txt")).toBe(false);
    sh("checkout", "--", "-dash.txt");
  });

  it("returns false and [] for a well-formed but unknown sha", async () => {
    const unknown = "a".repeat(40);
    expect(await git.contains(unknown)).toBe(false);
    expect(await git.branchesContaining(unknown)).toEqual([]);
    await expect(git.show(unknown)).rejects.toThrow(/git show failed/);
    await expect(git.fileAt(unknown, "src/x.ts")).rejects.toThrow(/git ls-tree failed/);
  });

  it("ignores inherited GIT_* overrides", async () => {
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = path.join(tmpdir(), "nexus-no-such-git-dir");
    process.env.GIT_WORK_TREE = tmpdir();
    try {
      expect(await git.headOf()).toBe(shas.merge);
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.dir;
      if (saved.tree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = saved.tree;
    }
  });

  it("does not run repo hooks or fsmonitor", async () => {
    const marker = path.join(root, "hook-ran");
    const fsmon = path.join(root, "fsmon.sh");
    writeFileSync(fsmon, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    sh("config", "core.fsmonitor", fsmon);
    try {
      await git.isDirty("src/x.ts");
      expect(existsSync(marker)).toBe(false);
    } finally {
      sh("config", "--unset", "core.fsmonitor");
      unlinkSync(fsmon);
    }
  });

  it("applies since after git, and needs a strict ISO time", async () => {
    // Skewed history: a child committed earlier than its parent. git's own --since cutoff is not a filter on every commit.
    const cutoff = "2026-11-08T00:00:00-05:00";
    const log = await git.log({ since: cutoff });
    expect(log.every(e => Date.parse(e.committedAt) >= Date.parse(cutoff))).toBe(true);
    for (const bad of ["yesterday", "2026-11-08", "2026-11-08 10:00:00", "--all", ""]) await expect(git.log({ since: bad })).rejects.toThrow(/invalid time/);
  });

  it("includes commits reachable only from a remote, a tag, or a detached HEAD", async () => {
    const tree = sh("rev-parse", "HEAD^{tree}");
    const remoteOnly = sh("commit-tree", tree, "-m", "remote only");
    sh("update-ref", "refs/remotes/origin/only", remoteOnly);
    const tagOnly = sh("commit-tree", tree, "-m", "tag only");
    sh("update-ref", "refs/tags/only", tagOnly);
    const log = await git.log();
    expect(log.map(e => e.sha)).toEqual(expect.arrayContaining([remoteOnly, tagOnly]));

    sh("switch", "-q", "--detach", "main");
    write("detached.txt", "d\n");
    const detached = commit("detached work");
    expect((await git.log()).map(e => e.sha)).toContain(detached);
    expect(await git.headOf()).toBe(detached);
    expect((await git.branches()).some(b => b.isCurrent)).toBe(false);
    sh("switch", "-q", "main");
  });

  it("cannot be fooled by \\x1f in a subject or author name", async () => {
    sh("switch", "-q", "--detach", "main");
    write("forge.txt", "f\n");
    sh("add", "-A");
    extraEnv = { GIT_AUTHOR_NAME: "Evil\x1f2026-01-01T00:00:00+00:00\x1fFake subject" };
    let forged: string;
    try {
      sh("-c", "commit.gpgsign=false", "commit", "-m", "real\x1fsubject\x1fwith\x1fseparators\n\nbody\x1fkept");
      forged = sh("rev-parse", "HEAD");
    } finally { extraEnv = {}; }
    const entry = (await git.log()).find(e => e.sha === forged)!;
    expect(entry.subject).toBe("real\x1fsubject\x1fwith\x1fseparators");
    expect(entry.authorName).toBe("Evil\x1f2026-01-01T00:00:00+00:00\x1fFake subject");
    expect(entry.committedAt).toMatch(/-05:00$/);
    expect(entry.parents).toHaveLength(1);
    const shown = await git.show(forged);
    expect(shown).toMatchObject({ subject: entry.subject, author: entry.authorName, at: entry.committedAt, body: "body\x1fkept" });
    expect(Requests["git.commit.show"].res.parse(shown)).toEqual(shown);
    sh("switch", "-q", "main");
  });

  it("reports truncated results through the logger", async () => {
    const warnings: string[] = [];
    const logged = new GitCli(root, { isolatedConfig: true, logger: { warn: m => warnings.push(m) } });
    await logged.log();
    expect(warnings).toEqual([]);   // small repo: nothing truncated, nothing logged
  });

  it("refuses an empty repository clearly", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "nexus-git-empty-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: empty, env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull } });
      const g = new GitCli(empty, { isolatedConfig: true });
      await expect(g.workspaceId()).rejects.toThrow(/repository has no commits/);
      expect(await g.log()).toEqual([]);
      expect(await g.branches()).toEqual([]);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });

  it("leaves the write half to L2-06", async () => {
    await expect(git.createSessionWorktree({ sessionId: "s", workspaceId: "w" })).rejects.toThrow(/not implemented in L2-05/);
    await expect(git.mergeAgentBranch("s")).rejects.toThrow(/not implemented in L2-05/);
    await expect(git.diff("/x", shas.first)).rejects.toThrow(/not implemented in L2-05/);
    await expect(git.commitIn("/x", "m", "s")).rejects.toThrow(/not implemented in L2-05/);
    await expect(git.removeSessionWorktree("s")).rejects.toThrow(/not implemented in L2-05/);
  });
});
