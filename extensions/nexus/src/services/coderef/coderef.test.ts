import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeCodeRef, type CodeRef } from "../../contracts";
import { GitCli } from "../git/git-cli";
import { coderefRoute } from "./coderef-route";
import { createCodeRef } from "./create";
import { openCodeRef, type ResolveDeps } from "./resolve";
import { formatCodeRefForSlack } from "./slack-format";

let root: string;
const sh = (...args: string[]) => execFileSync("git", args, {
  cwd: root, encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull },
}).trim();
const write = (rel: string, text: string) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); };
const commit = (msg: string) => { sh("add", "-A"); sh("-c", "commit.gpgsign=false", "commit", "-q", "-m", msg); return sh("rev-parse", "HEAD"); };
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

let git: GitCli;
let first: string;
let wsId: string;

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "nexus-coderef-"));
  sh("init", "-q", "-b", "main");
  write("src/a.ts", numbered(30));
  write("src/b.ts", numbered(5));
  first = commit("first");
  git = new GitCli(root, { isolatedConfig: true });
  wsId = await git.workspaceId();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const mkDeps = (): ResolveDeps & { calls: string[] } => {
  const calls: string[] = [];
  return {
    git, calls,
    openLive: (p, s, e) => { calls.push(`live ${p} ${s}-${e}`); },
    openAtCommit: (c, p, s, e) => { calls.push(`commit ${c.slice(0, 7)} ${p} ${s}-${e}`); },
    offerCurrent: () => { calls.push("offer"); },
  };
};

describe("createCodeRef", () => {
  it("makes a full-SHA ref, a decodable link and a snippet from the commit", async () => {
    const r = await createCodeRef({ git }, "src/a.ts", 3, 5);
    expect(r.ref).toEqual({ workspaceId: wsId, commit: first, path: "src/a.ts", startLine: 3, endLine: 5 });
    expect(decodeCodeRef(r.link)).toEqual(r.ref);
    expect(r.snippet).toBe("line 3\nline 4\nline 5");
  });
  it("caps the snippet at 12 lines", async () => {
    expect((await createCodeRef({ git }, "src/a.ts", 1, 30)).snippet.split("\n")).toHaveLength(12);
  });
  it("refuses a dirty file, and takes the snippet from the commit not the working copy", async () => {
    write("src/b.ts", "changed\n");
    await expect(createCodeRef({ git }, "src/b.ts", 1, 2)).rejects.toThrow(/commit first/);
    expect((await createCodeRef({ git }, "src/a.ts", 1, 1)).snippet).toBe("line 1");
    sh("checkout", "--", "src/b.ts");
  });
  it("refuses bad paths, out-of-range lines and missing files", async () => {
    for (const p of ["/etc/passwd", "../x", "src/../x", "C:\\x", ""]) await expect(createCodeRef({ git }, p, 1, 1)).rejects.toThrow();
    await expect(createCodeRef({ git }, "src/b.ts", 4, 9)).rejects.toThrow(/out of range/);
    await expect(createCodeRef({ git }, "src/b.ts", 0, 1)).rejects.toThrow();
    await expect(createCodeRef({ git }, "src/b.ts", 3, 2)).rejects.toThrow();
    await expect(createCodeRef({ git }, "nope.ts", 1, 1)).rejects.toThrow(/not in/);
  });
});

describe("openCodeRef", () => {
  const ref = (over: Partial<CodeRef> = {}): CodeRef => ({ workspaceId: wsId, commit: first, path: "src/a.ts", startLine: 2, endLine: 4, ...over });
  it("opens live when HEAD still has the same file", async () => {
    const d = mkDeps();
    expect(await openCodeRef(d, ref())).toEqual({ opened: "current", stale: false });
    expect(d.calls).toEqual(["live src/a.ts 2-4"]);
  });
  it("opens at the commit and offers current when the file changed since", async () => {
    write("src/a.ts", "new\n" + numbered(30));
    const head = commit("shift lines");
    const d = mkDeps();
    expect(await openCodeRef(d, ref())).toEqual({ opened: "at_commit", stale: true });
    expect(d.calls).toEqual([`commit ${first.slice(0, 7)} src/a.ts 2-4`, "offer"]);
    expect(head).not.toBe(first);
  });
  it("treats a dirty file as stale", async () => {
    write("src/b.ts", "dirty\n");
    const d = mkDeps();
    expect((await openCodeRef(d, ref({ path: "src/b.ts", startLine: 1, endLine: 1 }))).stale).toBe(true);
    sh("checkout", "--", "src/b.ts");
  });
  it("refuses a foreign workspace, bad paths, unknown commits and paths", async () => {
    const d = mkDeps();
    await expect(openCodeRef(d, ref({ workspaceId: "x".repeat(40) }))).rejects.toThrow(/different repository/);
    await expect(openCodeRef(d, ref({ path: "../x" }))).rejects.toThrow();
    await expect(openCodeRef(d, ref({ commit: "a".repeat(40) }))).rejects.toThrow(/not in this repository|does not exist/);
    await expect(openCodeRef(d, ref({ path: "src/none.ts" }))).rejects.toThrow(/does not exist/);
    await expect(openCodeRef(d, ref({ endLine: 99 }))).rejects.toThrow(/do not exist/);
    expect(d.calls).toEqual([]);
  });
});

describe("coderefRoute", () => {
  it("opens a valid link and ignores malformed ones", async () => {
    const d = mkDeps();
    const route = coderefRoute(d);
    const r = await createCodeRef({ git }, "src/b.ts", 1, 2);
    expect(await route(r.link)).toBe(true);
    expect(d.calls).toHaveLength(1);
    for (const bad of ["nexus://coderef/x", "nexus://coderef/ws/zz/1-2/a%E0%A4%A", "nexus://coderef/ws/" + "a".repeat(40) + "/5-2/a.ts", ""]) {
      expect(await route(bad)).toBe(false);
    }
    expect(d.calls).toHaveLength(1);
  });
});

describe("formatCodeRefForSlack", () => {
  const r: CodeRef = { workspaceId: "w", commit: "b".repeat(40), path: "src/a<b>.ts", startLine: 1, endLine: 2 };
  it("links and fences the snippet", () => {
    const t = formatCodeRefForSlack(r, "x = 1");
    expect(t).toMatch(/^<nexus:\/\/nexus\.nexus\/coderef\/w\/b{40}\/1-2\/src%2Fa%3Cb%3E\.ts\|src\/a&lt;b&gt;\.ts:1-2>\n```\nx = 1\n```$/);
  });
  it("cannot break out of the block", () => {
    const t = formatCodeRefForSlack(r, "a <!channel> & <@U1>\n```\n@here\n`````\nend");
    const inner = t.slice(t.indexOf("```\n") + 4, t.lastIndexOf("\n```"));
    expect(inner).not.toContain("```");
    expect(inner).not.toMatch(/[<>]/);
    expect(inner).toContain("&lt;!channel&gt; &amp;");
    expect(t.match(/```/g)).toHaveLength(2);
  });
  it("caps length", () => {
    expect(formatCodeRefForSlack(r, "y".repeat(100000)).length).toBeLessThan(3000);
  });
});
