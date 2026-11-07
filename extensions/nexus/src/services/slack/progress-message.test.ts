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

function make() {
  return createProgressMessages({
    slack,
    getTask: id => store.getTask(id),
    getSession: id => store.getSession(id),
    putSession: s => store.putSession(s),
    redact,
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
  test("lists code-ref links that decode, a labeled summary, and stops further edits", async () => {
    const p = make();
    const s = (await p.start(session()))!;
    p.onAgentEvent(ev({ type: "file_edit", path: "src/cart.ts", diff: "@@ -40,3 +42,5 @@\n x\n@@ -90,1 +95,2 @@\n y" }));
    p.onAgentEvent(ev({ type: "file_edit", path: "docs/a b.md", diff: "(no hunks)" }, 2));
    p.onAgentEvent(ev({ type: "commit", sha: SHA }, 3));
    await p.finish({ ...s, status: "done" }, "Fixed the discount.");
    const body = await bodyOf(s.slackProgress!.messageTs);
    expect(body).toContain("done");
    expect(body).toContain("Summary (model-written)");
    expect(body).toContain("Fixed the discount.");
    const links = [...body.matchAll(/<(nexus:\/\/[^|>]+)\|/g)].map(m => decodeCodeRef(m[1]!));
    expect(links).toEqual([
      { workspaceId: demoScenario.task.workspaceId, commit: SHA, path: "src/cart.ts", startLine: 42, endLine: 96 },
      { workspaceId: demoScenario.task.workspaceId, commit: SHA, path: "docs/a b.md", startLine: 1, endLine: 1 },
    ]);
    await p.update(s, "late");
    p.onAgentEvent(ev({ type: "status", status: "failed" }, 4));
    await vi.advanceTimersByTimeAsync(5000);
    expect(edit).toHaveBeenCalledTimes(1);
  });

  test("at most 10 files, then 'and N more'", async () => {
    const p = make();
    const s = (await p.start(session()))!;
    for (let i = 0; i < 13; i++) p.onAgentEvent(ev({ type: "file_edit", path: `src/f${i}.ts`, diff: "" }, i + 1));
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
    for (let i = 0; i < 10; i++) p.onAgentEvent(ev({ type: "file_edit", path: `src/${"d/".repeat(30)}f${i}.ts`, diff: "" }, i + 1));
    p.onAgentEvent(ev({ type: "commit", sha: SHA }, 20));
    await p.finish({ ...s, status: "done" }, "<&>".repeat(5000));
    const body = await bodyOf(s.slackProgress!.messageTs);
    expect(body.length).toBeLessThanOrEqual(MAX_PROGRESS_CHARS);
    expect(body).not.toMatch(/&(?![a-z]+;)/);
  });

  test("never posts as the user", async () => {
    const asUser = vi.spyOn(slack, "postAsUser");
    const p = make();
    const s = (await p.start(session()))!;
    await p.finish({ ...s, status: "done" }, "x");
    expect(asUser).not.toHaveBeenCalled();
  });
});
