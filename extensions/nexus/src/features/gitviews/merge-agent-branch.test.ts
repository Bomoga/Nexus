import { describe, expect, it } from "vitest";
import type { Req, Res, RequestName, AgentSession } from "../../contracts";
import { mergeAgentBranch, type MergeDeps, type SessionPickItem } from "./merge-agent-branch";

const SESSION = (id: string, over: Partial<AgentSession> = {}): AgentSession => ({
  id, taskId: "t1", model: { provider: "anthropic", modelId: "claude-x" }, branch: `nexus/agent-${id}`, worktreePath: "/w",
  baseCommit: "a".repeat(40), status: "done", startedAt: "2026-11-07T00:00:00Z", endedAt: "2026-11-07T01:00:00Z", machineId: "m", ...over,
});

function setup(opts: { sessions?: AgentSession[]; merge?: Res<"git.mergeAgentBranch">; pick?: number | undefined; confirm?: boolean } = {}) {
  const calls: Array<[string, unknown]> = [];
  const infos: string[] = [];
  const errors: string[] = [];
  const picks: SessionPickItem[][] = [];
  const confirms: string[] = [];
  const deps: MergeDeps = {
    request: (async <N extends RequestName>(name: N, body: Req<N>) => {
      calls.push([name, body]);
      if (name === "sessions.list") return (opts.sessions ?? [SESSION("abcdef123456"), SESSION("zzz")]) as Res<N>;
      return (opts.merge ?? { ok: true, mergeSha: "1234567890abcdef", message: "merged" }) as Res<N>;
    }) as MergeDeps["request"],
    showQuickPick: async (items) => { picks.push(items); return "pick" in opts && opts.pick === undefined ? undefined : items[opts.pick ?? 0]; },
    confirm: async (m) => { confirms.push(m); return opts.confirm ?? true; },
    showInfo: m => { infos.push(m); },
    showError: m => { errors.push(m); },
  };
  return { deps, calls, infos, errors, picks, confirms };
}

describe("mergeAgentBranch", () => {
  it("lists only done sessions (asks for status done, filters again)", async () => {
    const s = setup({ sessions: [SESSION("a1"), SESSION("r1", { status: "running" })], pick: undefined });
    await mergeAgentBranch(s.deps);
    expect(s.calls[0]).toEqual(["sessions.list", { status: "done" }]);
    expect(s.picks[0]!.map(i => i.label)).toEqual(["nexus/agent-a1"]);
  });

  it("describes items with model id and short session id, detail endedAt", async () => {
    const s = setup({ pick: undefined });
    await mergeAgentBranch(s.deps);
    expect(s.picks[0]![0]).toMatchObject({ label: "nexus/agent-abcdef123456", description: "claude-x · abcdef1", detail: "2026-11-07T01:00:00Z", sessionId: "abcdef123456" });
  });

  it("confirms, merges, and reports the short merge sha", async () => {
    const s = setup({ pick: 0 });
    await mergeAgentBranch(s.deps);
    expect(s.confirms).toEqual(["Merge nexus/agent-abcdef123456 into the current branch?"]);
    expect(s.calls[1]).toEqual(["git.mergeAgentBranch", { sessionId: "abcdef123456" }]);
    expect(s.infos).toEqual(["Nexus: merged as 1234567"]);
    expect(s.errors).toEqual([]);
  });

  it("shows the returned message as an error on a clean abort", async () => {
    const s = setup({ merge: { ok: false, message: "conflicts in a.ts; merge aborted" } });
    await mergeAgentBranch(s.deps);
    expect(s.errors).toEqual(["Nexus: conflicts in a.ts; merge aborted"]);
    expect(s.infos).toEqual([]);
  });

  it("does not merge when the pick is cancelled", async () => {
    const s = setup({ pick: undefined });
    await mergeAgentBranch(s.deps);
    expect(s.calls.map(c => c[0])).toEqual(["sessions.list"]);
  });

  it("does not merge when the confirmation is declined", async () => {
    const s = setup({ confirm: false });
    await mergeAgentBranch(s.deps);
    expect(s.calls.map(c => c[0])).toEqual(["sessions.list"]);
  });

  it("skips the pick when a sessionId is given", async () => {
    const s = setup();
    await mergeAgentBranch(s.deps, "zzz");
    expect(s.picks).toEqual([]);
    expect(s.confirms).toEqual(["Merge nexus/agent-zzz into the current branch?"]);
    expect(s.calls[1]).toEqual(["git.mergeAgentBranch", { sessionId: "zzz" }]);
  });

  it("errors on an unknown or not-done sessionId without merging", async () => {
    const s = setup({ sessions: [SESSION("a1")] });
    await mergeAgentBranch(s.deps, "nope");
    expect(s.calls.map(c => c[0])).toEqual(["sessions.list"]);
    expect(s.errors).toHaveLength(1);
  });

  it("says so when there is nothing to merge", async () => {
    const s = setup({ sessions: [] });
    await mergeAgentBranch(s.deps);
    expect(s.picks).toEqual([]);
    expect(s.infos).toHaveLength(1);
  });

  it("reports a request failure as an error", async () => {
    const s = setup();
    s.deps.request = (async () => { throw new Error("offline"); }) as MergeDeps["request"];
    await mergeAgentBranch(s.deps);
    expect(s.errors).toEqual(["Nexus: could not merge agent branch: offline"]);
  });
});
