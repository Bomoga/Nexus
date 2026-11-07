import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fx } from "../../contracts/fixtures";
import type { AgentSession } from "../../contracts";
import { redact } from "../../shared/redact";
import { FakeGit } from "../git/fake-git";
import { splitCommand } from "./commands";
import { createGate, type SpawnFn } from "./gate";
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
const gate = (extra: { allow?: string[]; spawn?: SpawnFn } = {}) =>
  createGate({ git, approvals, allowlist: () => extra.allow ?? [], redact, ...(extra.spawn ? { spawn: extra.spawn } : {}) });

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
