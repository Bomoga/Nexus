import { describe, expect, it } from "vitest";
import { Requests } from "../../contracts";
import { FakeGit } from "./fake-git";

const session = { sessionId: "s1", workspaceId: "ws_fake" };

describe("FakeGit", () => {
  it("keeps agent commits on the session branch until a merge", async () => {
    const g = new FakeGit();
    const w = await g.createSessionWorktree(session);
    const sha = await g.commitIn(w.worktreePath, "fix cart\n\nbody", "s1", "");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await g.headOf("main")).toBe(w.baseCommit);
    expect(await g.headOf(w.branch)).toBe(sha);
    expect(await g.contains(sha)).toBe(false);
    expect(await g.branchesContaining(sha)).toEqual([w.branch]);
    const merged = await g.mergeAgentBranch("s1");
    expect(merged.ok).toBe(true);
    expect((await g.show(merged.mergeSha!)).parents).toEqual([w.baseCommit, sha]);
    expect(await g.contains(sha)).toBe(true);
    expect((await g.createSessionWorktree({ ...session, sessionId: "s2" })).baseCommit).toBe(merged.mergeSha);
  });

  it("filters the log by time and reads files and dirty state", async () => {
    const g = new FakeGit();
    expect(await g.log({ since: "2099-01-01T00:00:00Z" })).toEqual([]);
    expect((await g.log()).length).toBe(1);
    const [{ sha }] = await g.log();
    g.setFile(sha, "src/a.ts", "x");
    expect([await g.fileAt(sha, "src/a.ts"), await g.fileAt(sha, "src/b.ts")]).toEqual(["x", undefined]);
    g.setDirty("src/a.ts");
    expect(await g.isDirty("src/a.ts")).toBe(true);
  });

  it("scopes a diff to paths", async () => {
    const g = new FakeGit();
    const w = await g.createSessionWorktree(session);
    g.setDiff(w.worktreePath, "ALL");
    g.setDiff(w.worktreePath, "A", "a.ts");
    expect([await g.diff(w.worktreePath, w.baseCommit), await g.diff(w.worktreePath, w.baseCommit, ["a.ts"])]).toEqual(["ALL", "A"]);
  });

  it("refuses a commit outside a session worktree and a session on a detached HEAD", async () => {
    const g = new FakeGit();
    await expect(g.commitIn("/elsewhere", "x", "s1", "")).rejects.toThrow("unknown worktree");
    g.detachedHead = true;
    await expect(g.createSessionWorktree(session)).rejects.toThrow("detached");
  });

  it("answers in the contract's shapes, and reports a conflict without throwing", async () => {
    const g = new FakeGit();
    await g.createSessionWorktree(session);
    const [{ sha }] = await g.log();
    expect(Requests["git.branches"].res.safeParse(await g.branches()).success).toBe(true);
    expect(Requests["git.commit.show"].res.safeParse(await g.show(sha)).success).toBe(true);
    g.conflictNextMerge = true;
    const conflict = await g.mergeAgentBranch("s1");
    expect(Requests["git.mergeAgentBranch"].res.safeParse(conflict).success).toBe(true);
    expect(conflict.ok).toBe(false);
    expect((await g.mergeAgentBranch("nope")).ok).toBe(false);
  });

  it("does not alias stored state", async () => {
    const g = new FakeGit();
    (await g.log())[0].subject = "mutated";
    expect((await g.log())[0].subject).toBe("add cart module");
  });
});
