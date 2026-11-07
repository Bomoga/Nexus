import { existsSync } from "node:fs";
import { link, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fx } from "../../contracts/fixtures";
import type { AgentSession } from "../../contracts";
import { redact } from "../../shared/redact";
import { FakeGit } from "../git/fake-git";
import { absolutePath, splitCommand, windowsPlan } from "./commands";
import { writeFileAt } from "./fs";
import { createGate, type GateDeps, type SpawnFn } from "./gate";
import type { ApprovalsHook } from "./types";

type Pending = { action: { kind: string; [k: string]: unknown }; diffPreview?: string; resolve: (d: "approved" | "rejected") => void };

let dir: string, outside: string, session: AgentSession, git: FakeGit, pending: Pending[];
const approvals: ApprovalsHook = {
  create: ({ action, diffPreview }) => new Promise(resolve => {
    const id = `apr_${pending.length + 1}`;
    pending.push({ action, ...(diffPreview === undefined ? {} : { diffPreview }), resolve: decision => resolve({ approvalId: id, decision }) });
  }),
};
const flush = () => new Promise(r => setTimeout(r, 20));
const gate = (extra: { allow?: string[] } & Partial<GateDeps> = {}) =>
  createGate({ git, approvals, redact, ...extra, allowlist: () => extra.allow ?? [] });

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "gate-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "gate-out-")));
  session = { ...fx.session, worktreePath: dir };
  git = new FakeGit();
  pending = [];
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });

describe("fs", () => {
  it("writes, reads and lists inside the worktree", async () => {
    const g = gate();
    await g.request(session, "fs.write", { path: "src/a.txt", content: "hello" });
    expect(await g.request(session, "fs.read", { path: "src/a.txt" })).toEqual({ content: "hello", truncated: false });
    expect((await g.request(session, "fs.list", { path: ".", depth: 2 })).entries).toEqual(["src/", "src/a.txt"]);
    expect(pending).toHaveLength(0);
  });

  it("refuses to read outside, including through .. and a symlink", async () => {
    await writeFile(path.join(outside, "secret"), "s");
    await symlink(outside, path.join(dir, "link"));
    const g = gate();
    await expect(g.request(session, "fs.read", { path: "../x" })).rejects.toThrow(/outside/);
    await expect(g.request(session, "fs.read", { path: path.join(outside, "secret") })).rejects.toThrow(/outside/);
    await expect(g.request(session, "fs.read", { path: "link/secret" })).rejects.toThrow(/outside/);
    await expect(g.request(session, "fs.list", { path: "link", depth: 1 })).rejects.toThrow(/outside/);
  });

  it("caps read size", async () => {
    await writeFile(path.join(dir, "big"), "a".repeat(300_000));
    const r = await gate().request(session, "fs.read", { path: "big" });
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBe(200_000);
  });

  it("sends a ../ write to approval and writes only once approved", async () => {
    const p = gate().request(session, "fs.write", { path: "../gate-x.txt", content: "x" });
    await flush();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.action).toEqual({ kind: "write_outside_scope", path: path.join(path.dirname(dir), "gate-x.txt") });
    pending[0]!.resolve("approved");
    expect(await p).toEqual({ bytes: 1 });
    await rm(path.join(path.dirname(dir), "gate-x.txt"));
  });

  it("sends a symlink escape to approval, naming the real target, and rejects without writing", async () => {
    await symlink(outside, path.join(dir, "link"));
    const p = gate().request(session, "fs.write", { path: "link/new.txt", content: "x" });
    const settled = p.catch((e: Error) => e);
    await flush();
    expect(pending[0]!.action).toEqual({ kind: "write_outside_scope", path: path.join(outside, "new.txt") });
    pending[0]!.resolve("rejected");
    expect(await settled).toBeInstanceOf(Error);
    await expect(readFile(path.join(outside, "new.txt"))).rejects.toThrow();
  });

  it("never writes through a symlinked file", async () => {
    await writeFile(path.join(outside, "t"), "orig");
    await symlink(path.join(outside, "t"), path.join(dir, "f"));
    const p = gate().request(session, "fs.write", { path: "f", content: "evil" }).catch((e: Error) => e);
    await flush();
    expect(pending[0]!.action.kind).toBe("write_outside_scope");
    pending[0]!.resolve("rejected");
    await p;
    expect(await readFile(path.join(outside, "t"), "utf8")).toBe("orig");
  });
});

describe("cmd.run", () => {
  it("runs an allowlisted command without approval", async () => {
    const r = await gate({ allow: ["echo hi"] }).request(session, "cmd.run", { command: "echo hi", timeoutMs: 10000 });
    expect(r).toEqual({ exitCode: 0, stdoutTail: "hi\n", stderrTail: "" });
    expect(pending).toHaveLength(0);
  });

  it("waits for approval on a non-allowlisted command and stays pending without one", async () => {
    let settled = false;
    const p = gate().request(session, "cmd.run", { command: "echo hi", timeoutMs: 10000 }).then(r => { settled = true; return r; });
    await new Promise(r => setTimeout(r, 150));
    expect(settled).toBe(false);
    expect(pending[0]!.action).toEqual({ kind: "run_command", command: "echo hi" });
    pending[0]!.resolve("approved");
    expect(await p).toMatchObject({ exitCode: 0, stdoutTail: "hi\n", approvalId: "apr_1" });
  });

  it("throws when the command is rejected and never runs it", async () => {
    const spawn = vi.fn() as unknown as SpawnFn;
    const p = gate({ spawn }).request(session, "cmd.run", { command: "touch x", timeoutMs: 1000 }).catch((e: Error) => e);
    await flush();
    pending[0]!.resolve("rejected");
    expect(await p).toBeInstanceOf(Error);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["echo a | cat", "echo a; echo b", "a && b", "echo a > f", "echo `id`", "echo $(id)", "echo a\nrm x", "cat < f", "sleep 1 &"])("refuses shell syntax: %j", async command => {
    await expect(gate({ allow: [command] }).request(session, "cmd.run", { command, timeoutMs: 1000 })).rejects.toThrow();
    expect(pending).toHaveLength(0);
  });

  it("splits quotes without a shell", () => {
    expect(splitCommand(`git commit -m "a b" 'c d' e\\ f ""`)).toEqual(["git", "commit", "-m", "a b", "c d", "e f", ""]);
    expect(splitCommand(`echo '|;&'`)).toEqual(["echo", "|;&"]);
  });

  it("matches the allowlist on exact argv", async () => {
    const g = gate({ allow: ["echo hi"] });
    void g.request(session, "cmd.run", { command: "echo hi there", timeoutMs: 1000 }).catch(() => undefined);
    await flush();
    expect(pending).toHaveLength(1);
  });

  it("passes no token from process.env to the child, and runs in the worktree", async () => {
    vi.stubEnv("SLACK_USER_TOKEN", "xoxp-1234567890-secret");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-leak");
    const r = await gate({ allow: ["env"] }).request(session, "cmd.run", { command: "env", timeoutMs: 10000 });
    vi.unstubAllEnvs();
    expect(r.stdoutTail).not.toMatch(/SLACK_USER_TOKEN|ANTHROPIC|xoxp|sk-ant/);
    const pwd = await gate({ allow: ["pwd"] }).request(session, "cmd.run", { command: "pwd", timeoutMs: 10000 });
    expect(pwd.stdoutTail.trim()).toBe(dir);
  });

  it("redacts output", async () => {
    const r = await gate({ allow: ["echo sk-ant-abcdefghijklmnopqrstuv"] }).request(session, "cmd.run", { command: "echo sk-ant-abcdefghijklmnopqrstuv", timeoutMs: 10000 });
    expect(r.stdoutTail).not.toContain("sk-ant-abcdefghijklmnopqrstuv");
  });

  it("gives an integer exit code for a timeout kill and a missing binary", async () => {
    const killed = await gate({ allow: ["sleep 5"] }).request(session, "cmd.run", { command: "sleep 5", timeoutMs: 100 });
    expect(killed.exitCode).toBe(137);
    const missing = await gate({ allow: ["no-such-binary-xyz"] }).request(session, "cmd.run", { command: "no-such-binary-xyz", timeoutMs: 1000 });
    expect(Number.isInteger(missing.exitCode)).toBe(true);
    expect(missing.exitCode).not.toBe(0);
  });

  it("returns the child's own exit code", async () => {
    await mkdir(path.join(dir, "d"));
    const r = await gate({ allow: ["ls nope"] }).request(session, "cmd.run", { command: "ls nope", timeoutMs: 10000 });
    expect(r.exitCode).toBeGreaterThan(0);
  });
});

describe("git", () => {
  it("returns the diff from git, redacted", async () => {
    git.setDiff(dir, "+key sk-ant-abcdefghijklmnopqrstuv\n+ok\n");
    const { diff } = await gate().request(session, "git.diff", {});
    expect(diff).toContain("+ok");
    expect(diff).not.toContain("sk-ant-abcdefghijklmnopqrstuv");
  });

  it("waits for approval to commit, then calls commitIn", async () => {
    git.setDiff(dir, "+change\n");
    const spy = vi.spyOn(git, "commitIn").mockResolvedValue("a".repeat(40));
    const p = gate().request(session, "git.commit", { message: "fix cart" });
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(pending[0]!.action).toEqual({ kind: "commit", message: "fix cart" });
    expect(pending[0]!.diffPreview).toBe("+change\n");
    pending[0]!.resolve("approved");
    const r = await p;
    expect(spy).toHaveBeenCalledWith(dir, "fix cart", session.id);
    expect(r.approvalId).toBe("apr_1");
    expect(r.sha).toBe("a".repeat(40));
  });

  it("throws on a rejected commit without committing", async () => {
    const spy = vi.spyOn(git, "commitIn");
    const p = gate().request(session, "git.commit", { message: "m" }).catch((e: Error) => e);
    await flush();
    pending[0]!.resolve("rejected");
    expect(await p).toBeInstanceOf(Error);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("hardening", () => {
  it("refuses .git paths at any depth and case, for read, list and write, without asking", async () => {
    await mkdir(path.join(dir, ".git", "hooks"), { recursive: true });
    await mkdir(path.join(dir, "sub"));
    await writeFile(path.join(dir, "sub", ".git"), "gitdir: x");
    const g = gate();
    for (const p of [".git/hooks/pre-commit", ".git/config", ".GIT/config", "a/.Git/x", ".git", "sub/.git", "a\\.git\\config"]) {
      await expect(g.request(session, "fs.write", { path: p, content: "x" })).rejects.toThrow(/git metadata/);
    }
    await expect(g.request(session, "fs.read", { path: ".git" })).rejects.toThrow(/git metadata/);
    await expect(g.request(session, "fs.list", { path: ".git/hooks", depth: 1 })).rejects.toThrow(/git metadata/);
    expect(pending).toHaveLength(0);
  });

  it("refuses a symlink that leads into .git and hides .git from listings", async () => {
    await mkdir(path.join(dir, ".git"));
    await symlink(".git", path.join(dir, "sneaky"));
    await expect(gate().request(session, "fs.write", { path: "sneaky/config", content: "x" })).rejects.toThrow(/git metadata/);
    expect((await gate().request(session, "fs.list", { path: ".", depth: 1 })).entries).toEqual(["sneaky"]);
  });

  it("allows names that merely start with two dots", async () => {
    await gate().request(session, "fs.write", { path: "..foo", content: "ok" });
    expect((await gate().request(session, "fs.read", { path: "..foo" })).content).toBe("ok");
    expect(pending).toHaveLength(0);
  });

  it("refuses hard-linked files for read and write and leaves the other file alone", async () => {
    await writeFile(path.join(outside, "h"), "secret-outside");
    await link(path.join(outside, "h"), path.join(dir, "h"));
    await expect(gate().request(session, "fs.read", { path: "h" })).rejects.toThrow(/hard-linked/);
    await expect(gate().request(session, "fs.write", { path: "h", content: "pwned" })).rejects.toThrow(/hard-linked/);
    expect(await readFile(path.join(outside, "h"), "utf8")).toBe("secret-outside");
  });

  it("the write guard refuses a symlink final component directly", async () => {
    await writeFile(path.join(outside, "t"), "orig");
    await symlink(path.join(outside, "t"), path.join(dir, "f"));
    expect((await lstat(path.join(dir, "f"))).isSymbolicLink()).toBe(true);
    await expect(writeFileAt(path.join(dir, "f"), "evil")).rejects.toThrow();
    expect(await readFile(path.join(outside, "t"), "utf8")).toBe("orig");
  });

  it("redacts file content returned by fs.read", async () => {
    await writeFile(path.join(dir, ".env"), "key sk-ant-abcdefghijklmnopqrstuv\n");
    const r = await gate().request(session, "fs.read", { path: ".env" });
    expect(r.content).not.toContain("sk-ant-abcdefghijklmnopqrstuv");
  });

  it("carries redacted, capped content on a write_outside_scope approval", async () => {
    const content = "sk-ant-abcdefghijklmnopqrstuv " + "y".repeat(10_000);
    void gate().request(session, "fs.write", { path: "../gate-pv.txt", content }).catch(() => undefined);
    await flush();
    const preview = pending[0]!.diffPreview!;
    expect(preview).not.toContain("sk-ant-abcdefghijklmnopqrstuv");
    expect(preview.length).toBeLessThan(4200);
    pending[0]!.resolve("rejected");
  });

  it("refuses to run git, however it is spelled, even when allowlisted", async () => {
    for (const command of ["git push origin main", "/usr/bin/git status", "GIT.EXE log", "C:\\\\bin\\\\git status"]) {
      await expect(gate({ allow: [command] }).request(session, "cmd.run", { command, timeoutMs: 1000 })).rejects.toThrow(/git\.commit/);
    }
    expect(pending).toHaveLength(0);
  });

  it("refuses an unknown or inherited request name", async () => {
    for (const name of ["constructor", "toString", "__proto__", "nope"]) {
      await expect(gate().request(session, name as never, {} as never)).rejects.toThrow(/unknown gate request/);
    }
  });

  it("refuses the commit when the worktree changed during approval", async () => {
    git.setDiff(dir, "+approved\n");
    const spy = vi.spyOn(git, "commitIn");
    const p = gate().request(session, "git.commit", { message: "m" }).catch((e: Error) => e);
    await flush();
    git.setDiff(dir, "+approved\n+evil\n");
    pending[0]!.resolve("approved");
    expect(String(await p)).toMatch(/changed during approval/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("redacts the commit diffPreview", async () => {
    git.setDiff(dir, "+k sk-ant-abcdefghijklmnopqrstuv\n");
    vi.spyOn(git, "commitIn").mockResolvedValue("c".repeat(40));
    const p = gate().request(session, "git.commit", { message: "m" });
    await flush();
    expect(pending[0]!.diffPreview).not.toContain("sk-ant-abcdefghijklmnopqrstuv");
    pending[0]!.resolve("approved");
    await p;
  });

  it("runs without a shell: metacharacters inside quotes arrive as plain arguments", async () => {
    const r = await gate({ allow: ["echo '$HOME ; *'"] }).request(session, "cmd.run", { command: "echo '$HOME ; *'", timeoutMs: 5000 });
    expect(r.stdoutTail).toBe("$HOME ; *\n");
  });

  it("kills the whole process group on timeout, including a grandchild holding stdout", async () => {
    const marker = path.join(outside, "alive");
    const script = `require('child_process').spawn('sh',['-c','sleep 1.5; touch ${marker}'],{stdio:'inherit'});setInterval(()=>{},1000)`;
    await writeFile(path.join(dir, "t.js"), script);
    const t0 = Date.now();
    const r = await gate({ allow: ["node t.js"] }).request(session, "cmd.run", { command: "node t.js", timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(1200);
    expect(r.exitCode).toBe(137);
    await new Promise(res => setTimeout(res, 2000));
    expect(existsSync(marker)).toBe(false);
  }, 10000);

  it("does not let a worktree binary shadow an allowlisted one through an empty or relative PATH entry", async () => {
    await writeFile(path.join(dir, "mytool"), "#!/bin/sh\necho SHADOWED\n", { mode: 0o755 });
    for (const PATH of ["/usr/bin:/bin:", ".:/usr/bin:/bin", ":/usr/bin:/bin", "/usr/bin:/bin::"]) {
      const r = await gate({ allow: ["mytool"], env: { PATH, HOME: "/tmp" } }).request(session, "cmd.run", { command: "mytool", timeoutMs: 5000 });
      expect(r.stdoutTail).not.toContain("SHADOWED");
      expect(r.exitCode).not.toBe(0);
    }
  });

  it("keeps only absolute PATH entries", () => {
    expect(absolutePath("/a::.:rel:/b:", "linux")).toBe("/a:/b");
    expect(absolutePath(undefined, "linux")).toBe("/usr/bin:/bin");
    expect(absolutePath("C:\\bin;.;tools;\\\\srv\\x", "win32")).toBe("C:\\bin;\\\\srv\\x");
  });
});

describe("windows", () => {
  const env = { PATH: "C:\\bin;C:\\npm\\", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
  const has = (...files: string[]) => (f: string) => files.includes(f);

  it("runs an .exe directly", () => {
    expect(windowsPlan(["node", "a.js"], env, has("C:\\bin\\node.EXE"))).toEqual({ file: "C:\\bin\\node.EXE", args: ["a.js"], verbatim: false });
  });

  it("runs a .cmd shim through cmd.exe /d /s /c with escaped arguments", () => {
    const plan = windowsPlan(["npm", "test", 'a "b" 100%'], env, has("C:\\npm\\npm.CMD"));
    expect(plan).toEqual({ file: env.ComSpec, args: ["/d", "/s", "/c", '"' + '"C:\\npm\\npm.CMD" "test" "a ""b"" 100%%"' + '"'], verbatim: true });
  });

  it("refuses cmd metacharacters in a shim's arguments", () => {
    for (const bad of ["a&b", "a|b", "a<b", "a>b", "a^b"]) {
      expect(() => windowsPlan(["npm", bad], env, has("C:\\npm\\npm.CMD"))).toThrow();
    }
  });

  it("hands the gate a win32 spawn with only the allowed environment and a taskkill on timeout", async () => {
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");
    const spawn = ((file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ file, args, env: options.env });
      const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
      if (file !== "taskkill") setTimeout(() => child.emit("exit", 0, null), 5);
      return child;
    }) as unknown as SpawnFn;
    const r = await gate({ allow: ["npm test"], spawn, platform: "win32", fileExists: has("C:\\npm\\npm.CMD"),
      env: { ...env, HOME: "h", SystemRoot: "C:\\Windows", SLACK_TOKEN: "xoxp-1" } }).request(session, "cmd.run", { command: "npm test", timeoutMs: 1000 });
    expect(r.exitCode).toBe(0);
    expect(calls[0]!.file).toBe(env.ComSpec);
    expect(Object.keys(calls[0]!.env).sort()).toEqual(["ComSpec", "HOME", "PATH", "PATHEXT", "SystemRoot"]);
  });
});
