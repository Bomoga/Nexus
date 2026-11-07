import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeCodeRef, Requests, type CodeRef } from "../../contracts";
import { FakeGit } from "../git/fake-git";
import { GitCli } from "../git/git-cli";
import { coderefRoute } from "./coderef-route";
import { CodeRefError, createCodeRef, linesOf, MAX_LINK_PATH_CHARS, MAX_SNIPPET_CHARS } from "./create";
import { openCodeRef, type ResolveDeps } from "./resolve";
import { formatCodeRefForSlack, MAX_MESSAGE_CHARS } from "./slack-format";

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
    expect(formatCodeRefForSlack(r, "y".repeat(100000)).length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });
});

/** Wraps a git service and records every call, to prove a refusal happens before git is touched. */
const recording = (inner: object) => {
  const calls: string[] = [];
  const git = new Proxy(inner, { get: (t, k, r) => { const v = Reflect.get(t, k, r); return typeof v === "function" ? (...a: unknown[]) => { calls.push(String(k)); return v.apply(t, a); } : v; } });
  return { git: git as FakeGit, calls };
};
const BAD_PATHS = ["/x", "..", "../x", "a/../../x", "..\\x", "\\x", "a/./b", "./x", "a//b", "a\0b", "C:x", "C:\\x", ""];

describe("module path checks run before git is touched", () => {
  it.each(BAD_PATHS)("create refuses %j", async p => {
    const { git: g, calls } = recording(new FakeGit());
    await expect(createCodeRef({ git: g }, p, 1, 1)).rejects.toMatchObject({ name: "CodeRefError", code: "invalid_path" });
    expect(calls).toEqual([]);
  });
  it.each(BAD_PATHS.filter(p => p !== ""))("open refuses %j", async p => {
    const { git: g, calls } = recording(new FakeGit());
    const d = { ...mkDeps(), git: g };
    await expect(openCodeRef(d, { workspaceId: "ws_fake", commit: "a".repeat(40), path: p, startLine: 1, endLine: 1 })).rejects.toMatchObject({ code: "invalid_path" });
    expect(calls).toEqual([]);
    expect(d.calls).toEqual([]);
  });
  it("describes the problem generally", async () => {
    const e = await createCodeRef({ git: new FakeGit() }, "/x", 1, 1).then(() => undefined, (x: unknown) => x as CodeRefError);
    expect(e?.message).toMatch(/relative to the repository root/);
  });
});

describe("created refs honour the contract", () => {
  const files = ["a b%c.ts", "ünï/日本.ts", "q?#&=.ts", "pipe|gt>.ts"];
  beforeAll(() => { for (const f of files) write(f, "one\ntwo\n"); write("a..b.ts", "x\n"); commit("odd names"); });
  it.each(files)("round-trips %s", async f => {
    const r = await createCodeRef({ git }, f, 1, 2);
    expect(Requests["coderef.create"].res.safeParse(r).success).toBe(true);
    expect(decodeCodeRef(r.link)).toEqual(r.ref);
  });
  it("refuses a name with '..' inside it, which the contract rejects", async () => {
    await expect(createCodeRef({ git }, "a..b.ts", 1, 1)).rejects.toMatchObject({ code: "invalid_path" });
  });
  it("caps a huge snippet", async () => {
    write("min.js", "x".repeat(50000) + "\n"); commit("minified");
    const r = await createCodeRef({ git }, "min.js", 1, 1);
    expect(r.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS + 2);
    expect(r.snippet.endsWith("\n…")).toBe(true);
  });
});

describe("a commit that is not an ancestor of HEAD", () => {
  it("opens at the commit and offers current, even if the file is identical and clean", async () => {
    sh("switch", "-q", "-c", "side");
    write("side.txt", "s\n");
    const side = commit("side work");
    sh("switch", "-q", "main");
    const d = mkDeps();
    const res = await openCodeRef(d, { workspaceId: wsId, commit: side, path: "src/b.ts", startLine: 1, endLine: 1 });
    expect(res).toEqual({ opened: "at_commit", stale: true });
    expect(d.calls).toEqual([`commit ${side.slice(0, 7)} src/b.ts 1-1`, "offer"]);
  });
});

describe("linesOf", () => {
  it("breaks on CRLF, LF and a lone CR, and drops the tail", () => {
    expect(linesOf("a\r\nb\nc\rd\r\n")).toEqual(["a", "b", "c", "d"]);
    expect(linesOf("a\r\rb")).toEqual(["a", "", "b"]);
  });
  it("counts lone-CR lines when validating a range", async () => {
    write("cr.txt", "a\rb\rc\r"); commit("cr file");
    expect((await createCodeRef({ git }, "cr.txt", 2, 3)).snippet).toBe("b\nc");
    await expect(createCodeRef({ git }, "cr.txt", 2, 4)).rejects.toThrow(/out of range/);
  });
});

describe("slack text limits", () => {
  const r: CodeRef = { workspaceId: "w", commit: "b".repeat(40), path: "src/a.ts", startLine: 1, endLine: 2 };
  for (const [name, ch] of [["angle brackets", "<"], ["backticks", "`"], ["ampersands", "&"]] as const) {
    it(`stays within the cap for 5000 ${name} with the fence intact`, () => {
      const t = formatCodeRefForSlack(r, ch.repeat(5000));
      expect(t.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
      expect(t.endsWith("\n```")).toBe(true);
      expect(t.match(/```/g)).toHaveLength(2);
      expect(t).not.toMatch(/<(?!nexus:)/);
    });
  }
  it("pins the label for a path with | and >", () => {
    const t = formatCodeRefForSlack({ ...r, path: "a|<!channel>|b>.ts" }, "x");
    const head = t.slice(0, t.indexOf("\n"));
    expect(head).toMatch(/\|a¦&lt;!channel&gt;¦b&gt;\.ts:1-2>$/);
    expect(head.match(/[<>|]/g)).toHaveLength(3);
  });
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("link and code point limits", () => {
  const r: CodeRef = { workspaceId: "w", commit: "b".repeat(40), path: "src/a.ts", startLine: 1, endLine: 2 };
  it("refuses a path whose link would not fit, before git is touched", async () => {
    const rec = recording(new FakeGit());
    const longest = "文".repeat(Math.floor(MAX_LINK_PATH_CHARS / 9));
    await expect(createCodeRef({ git: rec.git }, `${longest}x`, 1, 1)).rejects.toMatchObject({ code: "invalid_path" });
    expect(rec.calls).toEqual([]);
  });
  it("always fits the cap for the longest path createCodeRef accepts", () => {
    const longest = "文".repeat(Math.floor(MAX_LINK_PATH_CHARS / 9));
    const t = formatCodeRefForSlack({ ...r, path: longest }, "<".repeat(5000));
    expect(t.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(t.endsWith("\n```")).toBe(true);
  });
  it("throws rather than exceed the cap when the link alone is too long", () => {
    expect(() => formatCodeRefForSlack({ ...r, path: "文".repeat(400) }, "x")).toThrow(/too long/);
  });
  it("never splits a surrogate pair in the label, and keeps control characters out of it", () => {
    const head = (p: string) => { const t = formatCodeRefForSlack({ ...r, path: p }, "x"); return t.slice(0, t.indexOf("\n```")); };
    // 211 UTF-16 units of label, so a cut 200 units from the end lands inside the emoji's pair
    const label = head(`${"a".repeat(10)}😀${"b".repeat(195)}`);
    expect(label).not.toMatch(LONE_SURROGATE);
    expect(label).toContain("…😀b");
    expect(head("a\nb\tc.ts")).toMatch(/\|a b c\.ts:1-2>$/);
  });
  it("never splits a surrogate pair in the snippet", async () => {
    write("emoji.txt", `${"😀".repeat(MAX_SNIPPET_CHARS + 50)}\n`);
    commit("emoji");
    const c = await createCodeRef({ git }, "emoji.txt", 1, 1);
    expect(c.snippet).not.toMatch(LONE_SURROGATE);
    expect(Array.from(c.snippet).length).toBe(MAX_SNIPPET_CHARS + 2);
  });
});
