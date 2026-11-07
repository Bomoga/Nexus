import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NexusEvent } from "../../contracts";
import { GitCli } from "./git-cli";
import { GitWatcher } from "./watcher";
import type { GitService, LogEntry, RefInfo } from "./types";

let root: string;
let day = 0;
const sh = (...args: string[]) => {
  const date = `2026-11-07T${String(10 + day++).padStart(2, "0")}:00:00-05:00`;
  return execFileSync("git", args, {
    cwd: root, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test Author", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test Author", GIT_COMMITTER_EMAIL: "t@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull },
  }).trim();
};
const commit = (file: string, msg: string) => {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, file), `${msg}\n`);
  sh("add", "-A"); sh("-c", "commit.gpgsign=false", "commit", "-m", msg);
  return sh("rev-parse", "HEAD");
};

const now = Date.parse("2026-11-08T00:00:00-05:00");
const quiet = { warn: () => {} };
let events: NexusEvent[];
function make(overrides: Partial<ConstructorParameters<typeof GitWatcher>[0]> = {}) {
  events = [];
  let onChange = () => {};
  const w = new GitWatcher({
    git: new GitCli(root, { isolatedConfig: true }),
    putNexusEvent: async e => { events.push(e); },
    watch: cb => { onChange = cb; return () => {}; },
    isKnownSession: async id => id === "s1", workspaceId: "ws1", machineId: "m1", logger: quiet, now: () => now, debounceMs: 20, retryBaseMs: 5,
    ...overrides,
  });
  return { w, fire: () => onChange() };
}

const sha = (n: number) => n.toString(16).padStart(40, "0");
const entry = (n: number, parents: number[], subject = `c${n}`): LogEntry => ({
  sha: sha(n), parents: parents.map(sha), authorName: "A", subject,
  committedAt: new Date(now - 1000 * (100000 - n)).toISOString().replace("Z", "+00:00"),
});
function fakeGit(refs: RefInfo[], log: LogEntry[], head?: string) {
  const logFn = vi.fn(async (_o?: { since?: string }) => log);
  const branchesContaining = vi.fn(async () => [] as string[]);
  const git = { refs: async () => refs, log: logFn, branchesContaining, headOf: async () => { if (!head) throw new Error("no head"); return head; } } as unknown as GitService;
  return { git, log: logFn, branchesContaining };
}
const summary = (list: NexusEvent[]) => list.map(e => `${e.kind}:${e.title}:${e.orbit}${e.fromOrbit ? `<-${e.fromOrbit}` : ""}`).sort();

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "nexus-watch-"));
  sh("init", "-q", "-b", "main");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("GitWatcher", () => {
  it("emits commit, branch, merge, tag and agent events with the right orbits, once", async () => {
    commit("a.txt", "first");
    const { w } = make();
    await w.scan();
    expect(summary(events)).toEqual(["branch:main:main", "commit:first:main"]);
    for (const e of events) expect(NexusEvent.safeParse(e).success).toBe(true);

    events.length = 0;
    await w.scan();
    expect(events).toHaveLength(0);

    sh("switch", "-q", "-c", "lane-1");
    commit("b.txt", "lane work");
    sh("switch", "-q", "main");
    commit("c.txt", "main work");
    sh("-c", "commit.gpgsign=false", "merge", "--no-ff", "-m", "merge lane-1", "lane-1");
    sh("tag", "v1");
    await w.scan();
    expect(summary(events)).toEqual([
      "branch:lane-1:lane-1", "commit:lane work:lane-1", "commit:main work:main", "merge:merge lane-1:main<-lane-1", "tag:v1:main",
    ].sort());
    const tag = events.find(e => e.kind === "tag")!;
    expect(tag.id).toBe("ws1:tag:v1");
    for (const e of events) expect(NexusEvent.safeParse(e).success).toBe(true);

    events.length = 0;
    await w.scan();
    expect(events).toHaveLength(0);

    // A new watcher (restart) re-derives the same ids.
    const first = make();
    await first.w.scan();
    const ids = new Set(events.map(e => e.id));
    expect(ids.size).toBe(events.length);
  });

  it("marks agent commits and puts nexus/agent-* work on the base family's orbit", async () => {
    sh("switch", "-q", "-c", "lane-2");
    commit("d.txt", "lane2 base");
    sh("switch", "-q", "-c", "nexus/agent-s1");
    commit("e.txt", "agent change\n\nNexus-Agent: s1");
    sh("switch", "-q", "main");
    const { w } = make();
    await w.scan();
    const agent = events.find(e => e.title === "agent change")!;
    expect(agent.actor.kind).toBe("agent");
    expect(agent.orbit).toBe("lane-2");
    expect(events.find(e => e.title === "nexus/agent-s1")!.orbit).toBe("lane-2");
    expect(events.find(e => e.title === "lane2 base")!.actor.kind).toBe("human");
  });

  it("caps events per scan, keeping the newest", async () => {
    const full = make(); await full.w.scan();
    const expected = events.map(e => Date.parse(e.at)).sort((x, y) => y - x).slice(0, 2);
    const capped = make({ maxEventsPerScan: 2 }); await capped.w.scan();
    expect(events.slice(0, 2).map(e => Date.parse(e.at)).sort((x, y) => y - x)).toEqual(expected);   // the first, capped batch holds the newest
  });

  it("debounces bursts into one scan and survives a failing scan", async () => {
    const refs = vi.fn<GitService["refs"]>().mockRejectedValueOnce(new Error("boom")).mockResolvedValue([]);
    const warn = vi.fn();
    const git = { refs, log: vi.fn().mockResolvedValue([]), branchesContaining: vi.fn(), headOf: vi.fn() } as unknown as GitService;
    const { w, fire } = make({ git, logger: { warn }, maxRetries: 0 });
    await w.start();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(refs).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) fire();
    await new Promise(r => setTimeout(r, 80));
    await w.idle();
    expect(refs).toHaveBeenCalledTimes(2);
    w.dispose();
  });

  it("never overlaps scans: a change during a scan triggers one more", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    let active = 0, maxActive = 0;
    const refs = vi.fn(async () => { active++; maxActive = Math.max(maxActive, active); await gate; active--; return []; });
    const git = { refs, log: vi.fn().mockResolvedValue([]), branchesContaining: vi.fn(), headOf: vi.fn() } as unknown as GitService;
    const { w } = make({ git });
    const a = w.scan(); w.scan(); w.scan();
    release();
    await a; await w.idle();
    expect(maxActive).toBe(1);
    expect(refs).toHaveBeenCalledTimes(2);
  });

  it("keeps branch and tag ids stable for a fresh watcher after the tip moved", async () => {
    const before = make(); await before.w.scan();
    const ids = new Set(events.map(e => e.id));
    sh("switch", "-q", "lane-1"); commit("m.txt", "moved tip"); sh("switch", "-q", "main");
    const fresh = make(); await fresh.w.scan();
    const fresh2 = events.filter(e => e.kind === "branch" || e.kind === "tag");
    expect(fresh2.length).toBeGreaterThan(0);
    expect(fresh2.filter(e => !ids.has(e.id))).toEqual([]);
  });

  it("treats a forged Nexus-Agent trailer as human unless the session is known", async () => {
    sh("switch", "-q", "-c", "feature/forge");
    commit("f.txt", "forged\n\nNexus-Agent: not-a-session");
    commit("g.txt", "genuine\n\nNexus-Agent: s1");
    sh("switch", "-q", "main");
    const { w } = make(); await w.scan();
    expect(events.find(e => e.title === "forged")!.actor.kind).toBe("human");
    expect(events.find(e => e.title === "genuine")!.actor.kind).toBe("agent");
  });

  it("uses main first, then lane-N, then others, and the committer date for at", async () => {
    const log = [entry(1, [])];
    // "alpha" sorts before "lane-3", so only the lane-N rank (not alphabetical order) can put the commit on lane-3.
    const refs: RefInfo[] = [{ name: "alpha", kind: "branch", sha: sha(1) }, { name: "lane-3", kind: "branch", sha: sha(1) }];
    const t = fakeGit(refs, log);
    const a = make({ git: t.git }); await a.w.scan();
    expect(events.find(e => e.kind === "commit")!.orbit).toBe("lane-3");
    expect(events.find(e => e.kind === "commit")!.at).toBe(log[0].committedAt);
    refs.push({ name: "main", kind: "branch", sha: sha(1) });
    const b = make({ git: t.git }); await b.w.scan();
    expect(events.find(e => e.kind === "commit")!.orbit).toBe("main");
    expect(t.log).toHaveBeenCalledWith({ since: new Date(now - 30 * 86400000).toISOString() });
  });

  it("gives detached HEAD commits the family of their first owned ancestor", async () => {
    const log = [entry(3, [2]), entry(2, [1]), entry(1, [])];
    const t = fakeGit([{ name: "lane-4", kind: "branch", sha: sha(1) }], log, sha(3));
    const { w } = make({ git: t.git }); await w.scan();
    expect(events.filter(e => e.kind === "commit").map(e => e.orbit)).toEqual(["lane-4", "lane-4", "lane-4"]);
  });

  it("finishes a capped backlog by itself on a quiet repo", async () => {
    const n = 10000;
    const log = Array.from({ length: n }, (_, i) => entry(n - i, i === n - 1 ? [] : [n - i - 1]));
    const t = fakeGit([{ name: "main", kind: "branch", sha: sha(n) }], log);
    const { w } = make({ git: t.git, maxEventsPerScan: 500 });
    await w.scan();
    expect(events.filter(e => e.kind === "commit")).toHaveLength(n);
    expect(new Set(events.map(e => e.id)).size).toBe(events.length);
  });

  it("retries after a store failure with backoff and completes", async () => {
    const t = fakeGit([{ name: "main", kind: "branch", sha: sha(2) }], [entry(2, [1]), entry(1, [])]);
    let fail = 2; const got: string[] = [];
    const { w } = make({ git: t.git, putNexusEvent: async e => { if (fail-- > 0) throw new Error("db down"); got.push(e.id); } });
    await w.scan();
    await new Promise(r => setTimeout(r, 100));
    expect(got).toContain("ws1:commit:" + sha(2));
    expect(got).toContain("ws1:commit:" + sha(1));
    w.dispose();
  });

  it("owns commits of a deleted 300-commit branch via the merge subject, without per-commit git calls", async () => {
    const n = 300;
    const side = Array.from({ length: n }, (_, i) => entry(n - i + 10, i === n - 1 ? [1] : [n - i + 9]));
    const merge = entry(1000, [2, 310], "Merge branch 'lane-5'");
    const log = [merge, ...side, entry(2, [1]), entry(1, [])];
    const t = fakeGit([{ name: "main", kind: "branch", sha: sha(1000) }], log);
    const started = Date.now();
    const { w } = make({ git: t.git }); await w.scan();
    expect(Date.now() - started).toBeLessThan(800);
    expect(t.branchesContaining).not.toHaveBeenCalled();
    expect(events.filter(e => e.orbit === "lane-5" && e.kind === "commit")).toHaveLength(n);
    const m = events.find(e => e.kind === "merge")!;
    expect([m.orbit, m.fromOrbit]).toEqual(["main", "lane-5"]);
  });

  it("handles an octopus merge of two deleted branches and unparsable subjects", async () => {
    root = mkdtempSync(path.join(tmpdir(), "nexus-watch-oct-")); day = 0;
    sh("init", "-q", "-b", "main"); commit("a.txt", "base");
    for (const b of ["aa", "bb"]) { sh("switch", "-q", "-c", b, "main"); commit(`${b}.txt`, `${b} work`); }
    sh("switch", "-q", "main");
    sh("-c", "commit.gpgsign=false", "merge", "--no-ff", "aa", "bb", "-m", "Merge branches 'aa' and 'bb'");
    sh("branch", "-D", "aa", "bb");
    const { w } = make(); await w.scan();
    expect(summary(events)).toEqual(expect.arrayContaining(["commit:aa work:aa", "commit:bb work:bb", "merge:Merge branches 'aa' and 'bb':main<-aa"]));
    rmSync(root, { recursive: true, force: true });
  });

  it("only lets a merge subject pick an orbit name through orbitOf", async () => {
    const log = [entry(5, [2, 4], "Merge branch 'x; rm -rf /'"), entry(4, [3]), entry(3, []), entry(2, [1]), entry(1, [])];
    const t = fakeGit([{ name: "main", kind: "branch", sha: sha(5) }], log);
    const { w } = make({ git: t.git }); await w.scan();
    expect(events.find(e => e.kind === "merge")!.fromOrbit).toBe("merged");
  });

  it("refuses dot, dot-dot, absolute and doubled-slash names from a merge subject", async () => {
    for (const [subject, expected] of [
      ["Merge branch '../../etc'", "merged"], ["Merge branch '.hidden'", "merged"], ["Merge branch 'a/../b'", "merged"],
      ["Merge branch '/abs'", "merged"], ["Merge branch 'a//b'", "merged"], ["Merge branch 'feature/./x'", "merged"],
      [`Merge branch '${"a".repeat(101)}'`, "merged"],
      ["Merge branch 'lane-5'", "lane-5"], ["Merge branch 'feature/cart/v2'", "feature/cart"], ["Merge branch 'release-1.2'", "release-1.2"],
    ] as const) {
      events.length = 0;
      const log = [entry(5, [2, 4], subject), entry(4, [3]), entry(3, []), entry(2, [1]), entry(1, [])];
      const t = fakeGit([{ name: "main", kind: "branch", sha: sha(5) }], log);
      const { w } = make({ git: t.git }); await w.scan();
      expect([subject, events.find(e => e.kind === "merge")!.fromOrbit]).toEqual([subject, expected]);
    }
  });
});
