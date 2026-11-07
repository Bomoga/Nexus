import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Requests } from "../../contracts";
import { GitCli } from "./git-cli";

let root: string;
let day = 0;
const sh = (...args: string[]) => {
  const date = `2026-11-0${6 + Math.floor(day / 3)}T${String(10 + (day % 3)).padStart(2, "0")}:00:00-0500`;
  day++;
  return execFileSync("git", args, {
    cwd: root, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test Author", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test Author", GIT_COMMITTER_EMAIL: "t@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
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
  write("weird\nname.txt", "newline\n");
  write("ünï.txt", "unicode\n");
  write("src/x.ts", "one\ntwo\n");
  write("old.txt", "will be renamed\nline2\nline3\nline4\n");
  write("gone.txt", "bye\n");
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
  git = new GitCli(root);
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
    expect(names).toEqual(expect.arrayContaining(["a b.txt", "weird\nname.txt", "ünï.txt", "src/x.ts"]));
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
    await expect(git.headOf("--all")).rejects.toThrow(/invalid ref/);
    expect(await git.contains(shas.lane)).toBe(true);
    expect(await git.contains(shas.agent)).toBe(false);
    expect(await git.contains(shas.agent, "nexus/agent-s1")).toBe(true);
    expect(await git.contains(shas.merge, "lane-1")).toBe(false);
  });

  it("reads a file at a commit, undefined when absent", async () => {
    expect(await git.fileAt(shas.first, "src/x.ts")).toBe("one\ntwo\n");
    expect(await git.fileAt(shas.lane, "src/x.ts")).toBe("one\ntwo\nthree\n");
    expect(await git.fileAt(shas.first, "a b.txt")).toBe("spaced\n");
    expect(await git.fileAt(shas.first, "weird\nname.txt")).toBe("newline\n");
    expect(await git.fileAt(shas.first, "ünï.txt")).toBe("unicode\n");
    expect(await git.fileAt(shas.lane, "gone.txt")).toBeUndefined();
    expect(await git.fileAt(shas.first, "src")).toBeUndefined();   // a directory, not a file
    expect(await git.fileAt(shas.first, "nothing/here.ts")).toBeUndefined();
  });

  it("reports dirty files, including names with spaces and newlines", async () => {
    expect(await git.isDirty("src/x.ts")).toBe(false);
    write("src/x.ts", "changed\n");
    write("weird\nname.txt", "edited\n");
    write("fresh file.txt", "untracked\n");
    expect(await git.isDirty("src/x.ts")).toBe(true);
    expect(await git.isDirty("weird\nname.txt")).toBe(true);
    expect(await git.isDirty("fresh file.txt")).toBe(true);
    expect(await git.isDirty("a b.txt")).toBe(false);
    sh("checkout", "--", "src/x.ts", "weird\nname.txt");
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
    for (const bad of ["../secret", "src/../../secret", "/etc/passwd", "C:\\x", "..\\x", "", "a\0b"]) {
      await expect(git.fileAt(shas.first, bad)).rejects.toThrow(/invalid path/);
      await expect(git.isDirty(bad)).rejects.toThrow(/invalid path/);
    }
  });

  it("leaves the write half to L2-06", async () => {
    await expect(git.createSessionWorktree({ sessionId: "s", workspaceId: "w" })).rejects.toThrow(/not implemented in L2-05/);
    await expect(git.mergeAgentBranch("s")).rejects.toThrow(/not implemented in L2-05/);
    await expect(git.diff("/x", shas.first)).rejects.toThrow(/not implemented in L2-05/);
    await expect(git.commitIn("/x", "m", "s")).rejects.toThrow(/not implemented in L2-05/);
    await expect(git.removeSessionWorktree("s")).rejects.toThrow(/not implemented in L2-05/);
  });
});
