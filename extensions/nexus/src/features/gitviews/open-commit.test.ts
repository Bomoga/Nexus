import { describe, expect, it, vi } from "vitest";
import type { Req, Res, RequestName } from "../../contracts";
import { openCommit, type DiffSide, type OpenCommitDeps, type CommitPickItem } from "./open-commit";

const SHA = "a".repeat(40);
const P1 = "b".repeat(40);
const P2 = "c".repeat(40);

function commit(over: Partial<Res<"git.commit.show">> = {}): Res<"git.commit.show"> {
  return {
    sha: SHA, subject: "fix the parser", body: "", author: "Ada", at: "2026-11-07T01:02:03Z", parents: [P1],
    files: [
      { path: "src/a.ts", status: "M", additions: 3, deletions: 1 },
      { path: "src/new.ts", status: "A", additions: 10, deletions: 0 },
      { path: "src/old.ts", status: "D", additions: 0, deletions: 7 },
    ],
    ...over,
  };
}

function setup(show: Res<"git.commit.show"> | Error, pickIndex = 0) {
  const calls: Array<[string, unknown]> = [];
  const picks: { items: CommitPickItem[]; title: string }[] = [];
  const diffs: Array<{ left: DiffSide; right: DiffSide; path: string; title: string }> = [];
  const errors: string[] = [];
  const resolved: string[] = [];
  const deps: OpenCommitDeps = {
    request: (async <N extends RequestName>(name: N, body: Req<N>) => {
      calls.push([name, body]);
      if (!/^[0-9a-f]{40}$/.test((body as { sha: string }).sha)) throw new Error("internal error");   // like Lane 2's GitCli.show
      if (show instanceof Error) throw show;
      return show as Res<N>;
    }) as OpenCommitDeps["request"],
    showQuickPick: async (items, o) => { picks.push({ items, title: o.title }); return items[pickIndex]; },
    showInputBox: vi.fn(async () => undefined),
    resolveSha: async sha => { resolved.push(sha); return sha === "abcdef1" ? "ABCDEF1" + "0".repeat(33) : undefined; },
    showError: m => { errors.push(m); },
    openDiff: async (left, right, path, title) => { diffs.push({ left, right, path, title }); },
  };
  return { deps, calls, picks, diffs, errors, resolved };
}

describe("openCommit", () => {
  it("lists one item per file with status and +/- and a header title", async () => {
    const s = setup(commit(), -1);
    await openCommit(s.deps, SHA);
    expect(s.calls).toEqual([["git.commit.show", { sha: SHA }]]);
    expect(s.picks[0]!.title).toBe("fix the parser · Ada · 2026-11-07 01:02 · parents bbbbbbb");
    expect(s.picks[0]!.items.map(i => [i.label, i.description])).toEqual([
      ["src/a.ts", "M +3 -1"], ["src/new.ts", "A +10 -0"], ["src/old.ts", "D +0 -7"],
    ]);
  });

  it("opens the built-in diff against the first parent for a modified file", async () => {
    const s = setup(commit(), 0);
    await openCommit(s.deps, SHA);
    expect(s.diffs).toEqual([{ left: { kind: "git", ref: P1 }, right: { kind: "git", ref: SHA }, path: "src/a.ts", title: "src/a.ts @aaaaaaa" }]);
  });

  it("gives an added file an empty left side", async () => {
    const s = setup(commit(), 1);
    await openCommit(s.deps, SHA);
    expect(s.diffs[0]).toMatchObject({ left: { kind: "empty" }, right: { kind: "git", ref: SHA } });
  });

  it("gives a deleted file an empty right side", async () => {
    const s = setup(commit(), 2);
    await openCommit(s.deps, SHA);
    expect(s.diffs[0]).toMatchObject({ left: { kind: "git", ref: P1 }, right: { kind: "empty" } });
  });

  it("uses the first parent of a merge commit", async () => {
    const s = setup(commit({ parents: [P1, P2] }), 0);
    await openCommit(s.deps, SHA);
    expect(s.picks[0]!.title).toContain("parents bbbbbbb ccccccc");
    expect(s.diffs[0]!.left).toEqual({ kind: "git", ref: P1 });
  });

  it("treats every file of a root commit as having an empty left side", async () => {
    const s = setup(commit({ parents: [] }), 0);
    await openCommit(s.deps, SHA);
    expect(s.picks[0]!.title).toContain("parents none");
    expect(s.diffs[0]!.left).toEqual({ kind: "empty" });
  });

  it("asks for a sha when none is given and refuses a bad one without any request", async () => {
    const s = setup(commit());
    s.deps.showInputBox = async () => "not a sha; rm -rf";
    await openCommit(s.deps);
    expect(s.calls).toEqual([]);
    expect(s.errors).toHaveLength(1);
  });

  it("refuses a bad sha argument", async () => {
    const s = setup(commit());
    await openCommit(s.deps, "abc12");
    await openCommit(s.deps, "g".repeat(40));
    expect(s.calls).toEqual([]);
    expect(s.errors).toHaveLength(2);
  });

  it("does nothing when the input box is cancelled", async () => {
    const s = setup(commit());
    await openCommit(s.deps);
    expect(s.calls).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  it("accepts a short sha typed into the input box", async () => {
    const s = setup(commit(), -1);
    s.deps.showInputBox = async () => " ABCDEF1 ";
    await openCommit(s.deps);
    expect(s.resolved).toEqual(["abcdef1"]);
    expect(s.calls).toEqual([["git.commit.show", { sha: "abcdef1" + "0".repeat(33) }]]);
  });

  it("does not resolve a full sha, and lowercases it", async () => {
    const s = setup(commit(), -1);
    await openCommit(s.deps, SHA.toUpperCase());
    expect(s.resolved).toEqual([]);
    expect(s.calls).toEqual([["git.commit.show", { sha: SHA }]]);
  });

  it("reports a short sha the repository cannot resolve, without calling git.commit.show", async () => {
    const s = setup(commit());
    await openCommit(s.deps, "1234567");
    expect(s.calls).toEqual([]);
    expect(s.errors).toEqual(["Nexus: no commit 1234567 in this repository"]);
  });

  it("treats a renamed file like an added one (empty left)", async () => {
    const s = setup(commit({ files: [{ path: "src/r.ts", status: "R", additions: 1, deletions: 1 }] }), 0);
    await openCommit(s.deps, SHA);
    expect(s.diffs[0]).toMatchObject({ left: { kind: "empty" }, right: { kind: "git", ref: SHA } });
  });

  it("escapes codicon syntax in labels", async () => {
    const s = setup(commit({ files: [{ path: "src/$(check)/x.ts", status: "M", additions: 1, deletions: 0 }] }), 0);
    await openCommit(s.deps, SHA);
    expect(s.picks[0]!.items[0]!.label).toBe("src/\\$(check)/x.ts");
    expect(s.diffs[0]!.path).toBe("src/$(check)/x.ts");
  });

  it("shows an error message when the request fails", async () => {
    const s = setup(new Error("no such commit"));
    await openCommit(s.deps, SHA);
    expect(s.errors).toEqual(["Nexus: could not open commit: no such commit"]);
    expect(s.picks).toEqual([]);
  });

  it("does not open a diff when the pick is cancelled", async () => {
    const s = setup(commit(), -1);
    await openCommit(s.deps, SHA);
    expect(s.diffs).toEqual([]);
  });
});
