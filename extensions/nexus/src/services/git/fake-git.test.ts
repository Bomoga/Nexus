import { describe, expect, it } from "vitest";
import { Requests } from "../../contracts";
import { FakeGit } from "./fake-git";

const session = { sessionId: "s1", workspaceId: "ws_fake" };

describe("FakeGit", () => {
  it("creates a worktree on nexus/agent-<id>, and commits in it with the session recorded", async () => {
    const g = new FakeGit();
    const w = await g.createSessionWorktree(session);
    expect([w.branch, w.baseBranch]).toEqual(["nexus/agent-s1", "main"]);
    const sha = await g.commitIn(w.worktreePath, "fix cart\n\nbody", "s1");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await g.log())[0]).toMatchObject({ sha, subject: "fix cart", agentSessionId: "s1", parents: [w.baseCommit] });
  });

  it("refuses a commit outside a session worktree and a session on a detached HEAD", async () => {
    const g = new FakeGit();
    await expect(g.commitIn("/elsewhere", "x", "s1")).rejects.toThrow("unknown worktree");
    g.detachedHead = true;
    await expect(g.createSessionWorktree(session)).rejects.toThrow("detached");
  });

  it("answers in the contract's shapes", async () => {
    const g = new FakeGit();
    await g.createSessionWorktree(session);
    const [{ sha }] = await g.log();
    expect(Requests["git.branches"].res.safeParse(await g.branches()).success).toBe(true);
    expect(Requests["git.commit.show"].res.safeParse(await g.show(sha)).success).toBe(true);
    expect(Requests["git.mergeAgentBranch"].res.safeParse(await g.mergeAgentBranch("s1")).success).toBe(true);
  });

  it("reports a conflict without throwing, and an unknown session", async () => {
    const g = new FakeGit();
    await g.createSessionWorktree(session);
    g.conflictNextMerge = true;
    expect((await g.mergeAgentBranch("s1")).ok).toBe(false);
    expect((await g.mergeAgentBranch("s1")).ok).toBe(true);
    expect((await g.mergeAgentBranch("nope")).ok).toBe(false);
  });

  it("does not alias stored state", async () => {
    const g = new FakeGit();
    (await g.log())[0].subject = "mutated";
    expect((await g.log())[0].subject).toBe("add cart module");
  });
});
