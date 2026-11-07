import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NexusEvent } from "../../contracts";
import { GitCli } from "./git-cli";
import { GitWatcher } from "./watcher";
import type { GitService } from "./types";

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
    workspaceId: "ws1", machineId: "m1", logger: quiet, now: () => now, debounceMs: 20,
    ...overrides,
  });
  return { w, fire: () => onChange() };
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
    expect(tag.id).toMatch(/^ws1:tag:[0-9a-f]{40}:v1$/);
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
    expect(events.map(e => Date.parse(e.at)).sort((x, y) => y - x)).toEqual(expected);
  });

  it("debounces bursts into one scan and survives a failing scan", async () => {
    const refs = vi.fn<GitService["refs"]>().mockRejectedValueOnce(new Error("boom")).mockResolvedValue([]);
    const warn = vi.fn();
    const git = { refs, log: vi.fn().mockResolvedValue([]), branchesContaining: vi.fn() } as unknown as GitService;
    const { w, fire } = make({ git, logger: { warn } });
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
    const git = { refs, log: vi.fn().mockResolvedValue([]), branchesContaining: vi.fn() } as unknown as GitService;
    const { w } = make({ git });
    const a = w.scan(); w.scan(); w.scan();
    release();
    await a; await w.idle();
    expect(maxActive).toBe(1);
    expect(refs).toHaveBeenCalledTimes(2);
  });
});
