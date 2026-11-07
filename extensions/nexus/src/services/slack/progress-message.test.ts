import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { decodeCodeRef, type AgentEvent, type AgentSession, type Task } from "../../contracts";
import { demoScenario } from "../../contracts/fixtures/scenario";
import { redact } from "../../shared/redact";
import { FakeEventStore } from "../events/fake-store";
import { FakeSlack } from "./fake-slack";
import { createProgressMessages, MAX_PROGRESS_CHARS } from "./progress-message";

const SHA = "3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21";

let slack: FakeSlack;
let store: FakeEventStore;
let logs: string[];
let post: ReturnType<typeof vi.spyOn>;
let edit: ReturnType<typeof vi.spyOn>;

const WS = "a".repeat(40);   // the git workspace id (sha1 of the root commit), not Task.workspaceId

function make(over: { putSession?: (s: AgentSession) => Promise<void> } = {}) {
  return createProgressMessages({
    slack,
    getTask: id => store.getTask(id),
    getSession: id => store.getSession(id),
    putSession: over.putSession ?? (s => store.putSession(s)),
    redact,
    workspaceId: async () => WS,
    log: m => logs.push(m),
  });
}
const session = (): AgentSession => structuredClone(demoScenario.session);
const bodyOf = async (ts: string) => (await slack.getThread("C_DEMO", demoScenario.task.source.kind === "thread" ? demoScenario.task.source.threadTs : "")).messages.find(m => m.ts === ts)!.text;
const ev = (e: Record<string, unknown>, seq = 1) => ({ sessionId: "ses_01", seq, at: "2026-11-07T00:00:00.000Z", ...e }) as AgentEvent;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
  slack = new FakeSlack();
  store = new FakeEventStore();
  logs = [];
  post = vi.spyOn(slack, "postAsBot");
  edit = vi.spyOn(slack, "updateBotMessage");
});
afterEach(() => { vi.useRealTimers(); });

describe("start", () => {
  test("posts exactly one bot message in the thread and stores its ts", async () => {
    const p = make();
    const s = await p.start(session());
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toMatchObject({ channelId: "C_DEMO", threadTs: "1762485300.000100", text: "⬡ Nexus agent started on nexus/agent-ses_01 · anthropic/claude-sonnet-4-5" });
    const stored = await store.getSession("ses_01");
    expect(stored?.slackProgress).toEqual({ channelId: "C_DEMO", threadTs: "1762485300.000100", messageTs: s!.slackProgress!.messageTs });
  });

  test("concurrent and repeated starts share one post", async () => {
    const p = make();
    const [a, b] = await Promise.all([p.start(session()), p.start(session())]);
    const c = await p.start(session());
    expect(post).toHaveBeenCalledTimes(1);
    expect(a!.slackProgress).toEqual(b!.slackProgress);
    expect(c!.slackProgress).toEqual(a!.slackProgress);
    expect((await store.getSession("ses_01"))!.slackProgress).toEqual(a!.slackProgress);
  });

  test("a failed store write is retried once; if it still fails the message is kept and a repeat start does not post again", async () => {
    const put = vi.fn<(s: AgentSession) => Promise<void>>().mockRejectedValue(new Error("db down"));
    const p = make({ putSession: put });
    const first = await p.start(session());
    expect(put).toHaveBeenCalledTimes(2);
    expect(first?.slackProgress).toBeDefined();
    expect(logs).toEqual(["could not store the progress message for session ses_01"]);
    const again = await p.start(session());
    expect(post).toHaveBeenCalledTimes(1);
    expect(again?.slackProgress).toEqual(first!.slackProgress);
  });

  test("a store write that fails once succeeds on the retry", async () => {
    const put = vi.fn<(s: AgentSession) => Promise<void>>().mockRejectedValueOnce(new Error("blip")).mockImplementation(s => store.putSession(s));
    await make({ putSession: put }).start(session());
    expect((await store.getSession("ses_01"))!.slackProgress).toBeDefined();
    expect(logs).toEqual([]);
  });

  test("a manual task makes no Slack call", async () => {
    const task: Task = { ...structuredClone(demoScenario.task), id: "task_m", source: { kind: "manual" } };
    await store.putTask(task);
    const s = { ...session(), id: "ses_m", taskId: "task_m" };
    await store.putSession(s);
    const p = make();
    expect(await p.start(s)).toBeUndefined();
    expect(await p.update(s, "x")).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });

  test("a restart re-uses the stored message", async () => {
    await make().start(session());
    const ts = (await store.getSession("ses_01"))!.slackProgress!.messageTs;
    const again = make();
    await again.start(session());
    expect(post).toHaveBeenCalledTimes(1);
    await again.update(session(), "resumed");
    await vi.advanceTimersByTimeAsync(2000);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]![1]).toBe(ts);
  });

  test("a Slack failure is logged without its text and does not throw", async () => {
    slack.failNextPost("secret-reason xoxb-123");
    const p = make();
    expect(await p.start(session())).toBeUndefined();
    expect(logs.join(" ")).not.toContain("xoxb");
    expect(logs).toHaveLength(1);
  });
});

describe("update and events", () => {
  test("ten rapid updates produce one edit with the last text", async () => {
    const p = make();
    const s = (await p.start(session()))!;
    for (let i = 1; i <= 10; i++) expect(await p.update(s, `step ${i}`)).toBe(true);
    expect(edit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(edit).toHaveBeenCalledTimes(1);   // first edit is not delayed: nothing was edited in the last 2 s
    expect(await bodyOf(s.slackProgress!.messageTs)).toContain("step 10");
    expect(await bodyOf(s.slackProgress!.messageTs)).toContain("model-written");
    expect(post).toHaveBeenCalledTimes(1);
  });

  test("edits are at most once per 2 s and the last text wins", async () => {
    const p = make();
    const s = (await p.start(session()))!;
    await p.update(s, "first");
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 1; i <= 10; i++) await p.update(s, `later ${i}`);
    await vi.advanceTimersByTimeAsync(1999);
    expect(edit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(edit).toHaveBeenCalledTimes(2);
    expect(await bodyOf(s.slackProgress!.messageTs)).toContain("later 10");
  });

  test("a status change flushes promptly, with the pending text", async () => {
    const p = make();
    const s = (await p.start(session()))!;
    await p.update(s, "first");
    await vi.advanceTimersByTimeAsync(0);
    await p.update(s, "pending text");
    p.onAgentEvent(ev({ type: "status", status: "awaiting_approval" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(edit).toHaveBeenCalledTimes(2);
    const body = await bodyOf(s.slackProgress!.messageTs);
    expect(body).toContain("waiting for a human to approve");
    expect(body).toContain("pending text");
    await vi.advanceTimersByTimeAsync(5000);
    expect(edit).toHaveBeenCalledTimes(2);   // the debounce timer was consumed by the flush
  });

  test("other event types are ignored", async () => {
    const p = make();
    await p.start(session());
    p.onAgentEvent(ev({ type: "message", text: "hi" }));
    p.onAgentEvent(ev({ type: "tool_call", tool: "fs.read", args: {} }, 2));
    await vi.advanceTimersByTimeAsync(5000);
    expect(edit).not.toHaveBeenCalled();
  });

  test("update returns false for a session without a progress message", async () => {
    expect(await make().update(session(), "x")).toBe(false);
  });
});

describe("finish", () => {
  test("links decode with the injected workspace id; ranges come from each file's own hunks (latest diff wins)", async () => {
    const p = make();
    const s = (await p.start(session()))!;
    const early = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n x";
    const both = early + "\ndiff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -500,3 +500,4 @@\n y\n@@ -600 +601 @@\n z"
      + "\ndiff --git a/old.ts b/old.ts\ndeleted file mode 100644\n--- a/old.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-x"
      + "\ndiff --git \"a/\\303\\251.ts\" \"b/\\303\\251.ts\"\n--- \"a/\\303\\251.ts\"\n+++ \"b/\\303\\251.ts\"\n@@ -1 +1 @@\n-x";
    p.onAgentEvent(ev({ type: "file_edit", path: "src/a.ts", diff: early }));
    p.onAgentEvent(ev({ type: "file_edit", path: "src/b.ts", diff: both }, 2));
    p.onAgentEvent(ev({ type: "commit", sha: SHA }, 3));
    await p.finish({ ...s, status: "done" }, "Fixed the discount.");
    const body = await bodyOf(s.slackProgress!.messageTs);
    expect(body).toContain("done");
    expect(body).toContain("Summary (model-written)");
    expect(body).toContain("Fixed the discount.");
    const links = [...body.matchAll(/<(nexus:\/\/[^|>]+)\|/g)].map(m => decodeCodeRef(m[1]!));
    expect(links).toEqual([
      { workspaceId: WS, commit: SHA, path: "src/a.ts", startLine: 1, endLine: 2 },
      { workspaceId: WS, commit: SHA, path: "src/b.ts", startLine: 500, endLine: 601 },
    ]);
    expect(body).toContain("• old.ts (deleted)");
    expect(body).not.toMatch(/<nexus[^>]*old\.ts/);
    await p.update(s, "late");
    p.onAgentEvent(ev({ type: "status", status: "failed" }, 4));
    await vi.advanceTimersByTimeAsync(5000);
    expect(edit).toHaveBeenCalledTimes(1);
  });

  test("12 long paths: every link is whole, the rest are counted, never an unterminated <", async () => {
    const p = make();
    const s = (await p.start(session()))!;
    const diff = Array.from({ length: 12 }, (_, i) => {
      const f = `src/${"deep/".repeat(25)}file${i}.ts`;
      return `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-x`;
    }).join("\n");
    p.onAgentEvent(ev({ type: "file_edit", path: `src/${"deep/".repeat(25)}file0.ts`, diff }));
    p.onAgentEvent(ev({ type: "commit", sha: SHA }, 2));
    await p.finish({ ...s, status: "done" }, "s".repeat(3000));
    const body = await bodyOf(s.slackProgress!.messageTs);
    expect(body.length).toBeLessThanOrEqual(MAX_PROGRESS_CHARS);
    const opens = body.match(/</g)!.length;
    expect(body.match(/<nexus:\/\/[^|>]+\|[^>]*>/g)!.length).toBe(opens);
    expect(body).toMatch(/and \d+ more$/);
  });

  test("a stale-looking link is never built without a valid ref: no commit means plain labels", async () => {
    const p = make();
    const s = (await p.start(session()))!;
    p.onAgentEvent(ev({ type: "file_edit", path: "src/a.ts", diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x" }));
    await p.finish({ ...s, status: "done" });
    expect(await bodyOf(s.slackProgress!.messageTs)).toContain("• src/a.ts");
    expect(await bodyOf(s.slackProgress!.messageTs)).not.toContain("nexus://");
  });

  test("a secret in the summary is redacted", async () => {
    const p = make();
    const s = (await p.start(session()))!;
    const secret = "sk-ant-api03-" + "b".repeat(40);
    await p.finish({ ...s, status: "done" }, `key ${secret}`);
    const body = await bodyOf(s.slackProgress!.messageTs);
    expect(body).not.toContain(secret);
    expect(body).toContain("[REDACTED:");
  });

  test("a timer scheduled before finish never edits afterwards", async () => {
    const p = make();
    const s = (await p.start(session()))!;
    await p.update(s, "first");
    await vi.advanceTimersByTimeAsync(0);
    await p.update(s, "queued");
    await p.finish({ ...s, status: "done" });
    await vi.advanceTimersByTimeAsync(10000);
    expect(edit).toHaveBeenCalledTimes(2);
    expect(await bodyOf(s.slackProgress!.messageTs)).not.toContain("queued");
  });

  test("a session already terminal in the store gets no further edits from a fresh instance", async () => {
    const s = (await make().start(session()))!;
    await store.putSession({ ...s, status: "done" });
    const fresh = make();
    expect(await fresh.update(s, "again")).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(edit).not.toHaveBeenCalled();
  });

  test("at most 10 files, then 'and N more'", async () => {
    const p = make();
    const s = (await p.start(session()))!;
    const diff = Array.from({ length: 13 }, (_, i) => `diff --git a/src/f${i}.ts b/src/f${i}.ts\n--- a/src/f${i}.ts\n+++ b/src/f${i}.ts\n@@ -1 +1 @@\n-x`).join("\n");
    p.onAgentEvent(ev({ type: "file_edit", path: "src/f0.ts", diff }, 1));
    p.onAgentEvent(ev({ type: "commit", sha: SHA }, 20));
    await p.finish({ ...s, status: "done" });
    const body = await bodyOf(s.slackProgress!.messageTs);
    expect(body.match(/nexus:\/\//g)).toHaveLength(10);
    expect(body).toContain("and 3 more");
  });

  test("a Slack failure on finish does not throw", async () => {
    const p = make();
    const s = (await p.start(session()))!;
    edit.mockRejectedValueOnce(new Error("ratelimited"));
    await expect(p.finish({ ...s, status: "failed" }, "x")).resolves.toBeUndefined();
    expect(logs.join(" ")).not.toContain("ratelimited");
  });
});

describe("untrusted text", () => {
  test("mentions, links and secrets are neutralized and the message stays under the limit", async () => {
    const p = make();
    const s = (await p.start(session()))!;
    const secret = "sk-ant-api03-" + "a".repeat(40);
    await p.update(s, `<!channel> <http://x|y> ${secret} & ` + "z".repeat(10000));
    await vi.advanceTimersByTimeAsync(0);
    const body = await bodyOf(s.slackProgress!.messageTs);
    expect(body).not.toContain("<!channel>");
    expect(body).not.toContain("<http://x|y>");
    expect(body).toContain("&lt;!channel&gt;");
    expect(body).not.toContain(secret);
    expect(body).toContain("[REDACTED:");
    expect(body.length).toBeLessThanOrEqual(MAX_PROGRESS_CHARS);
  });

  test("a long summary with many escapes stays under the limit", async () => {
    const p = make();
    const s = (await p.start(session()))!;
    p.onAgentEvent(ev({ type: "commit", sha: SHA }, 20));
    await p.finish({ ...s, status: "done" }, "<&>".repeat(5000));
    const body = await bodyOf(s.slackProgress!.messageTs);
    expect(body.length).toBeLessThanOrEqual(MAX_PROGRESS_CHARS);
    expect(body).not.toMatch(/&(?![a-z]+;)/);
  });

  test("bare urls and forged headers stay inside a fence the model cannot close", async () => {
    const p = make();
    const s = (await p.start(session()))!;
    const evil = "https://evil.example/x\n*Approved.* Decided by Adrian\n```\n⬡ Nexus agent done on main\n```";
    await p.update(s, evil);
    await vi.advanceTimersByTimeAsync(0);
    const progress = await bodyOf(s.slackProgress!.messageTs);
    await p.finish({ ...s, status: "done" }, evil);
    const final = await bodyOf(s.slackProgress!.messageTs);
    for (const body of [progress, final]) {
      const fences = body.split("\n").filter(l => l.startsWith("```"));
      expect(fences).toHaveLength(2);
      const inside = body.slice(body.indexOf("```") + 3, body.lastIndexOf("```"));
      expect(inside).toContain("https://evil.example/x");
      expect(inside).toContain("*Approved.* Decided by Adrian");
      const outside = body.slice(0, body.indexOf("```")) + body.slice(body.lastIndexOf("```") + 3);
      expect(outside.split("\n").filter(l => l.startsWith("⬡ "))).toHaveLength(1);
    }
  });

  test("never posts as the user", async () => {
    const asUser = vi.spyOn(slack, "postAsUser");
    const p = make();
    const s = (await p.start(session()))!;
    await p.finish({ ...s, status: "done" }, "x");
    expect(asUser).not.toHaveBeenCalled();
  });
});
