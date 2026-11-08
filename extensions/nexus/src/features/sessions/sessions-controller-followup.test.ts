import { describe, expect, it } from "vitest";
import { fx } from "../../contracts/fixtures";
import { FakeGit, MemoryGate, MemoryStore, fakeClock } from "../testing/memory-ports";
import { SessionsController, historyOf, type HostPort } from "./sessions-controller";

const SECRET = "sk-ant-api03-SECRETSECRETSECRET1234567890";
const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };

function fakeHost() {
  const sent: Array<{ id: string; text: string }> = [];
  const host: HostPort & { sent: typeof sent; startParams?: Parameters<HostPort["startSession"]>[0]; failMessage?: Error; failStart?: Error; starts: number } = {
    sent, starts: 0,
    async startSession(p) { host.starts++; host.startParams = p; if (host.failStart) throw host.failStart; return { accepted: true }; },
    async cancelSession() { return { cancelled: true }; },
    endSession() {},
    async messageSession(id, text) { if (host.failMessage) throw host.failMessage; sent.push({ id, text }); return { accepted: true }; },
  };
  return host;
}

async function setup(machineId = "m_adrian") {
  const store = new MemoryStore();
  await store.putTask({ ...fx.task });
  const git = new FakeGit();
  const host = fakeHost();
  const c = new SessionsController({ store, git, gate: new MemoryGate({ files: {} }), host, clock: fakeClock(), machineId: "m_adrian", getKey: async () => "k" });
  void machineId;
  return { c, store, host, git };
}

describe("SessionsController follow-up messages", () => {
  it("hands a live session's follow-up to the agent and stores it, redacted, as a user_message", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    await s.c.message(session.id, `  also cover the empty cart ${SECRET}  `);
    expect(s.host.sent).toHaveLength(1);
    expect(s.host.sent[0].text).not.toContain("SECRETSECRET");
    expect(s.host.sent[0].text).toContain("also cover the empty cart");
    const events = await s.store.agentEvents(session.id, 0);
    expect(events.at(-1)).toMatchObject({ type: "user_message" });
    expect(JSON.stringify(events)).not.toContain("SECRETSECRET");
  });

  it("refuses an empty message, and records an error when the agent did not take it", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    await expect(s.c.message(session.id, "   ")).rejects.toThrow("Type a message");
    s.host.failMessage = new Error("no running session");
    await expect(s.c.message(session.id, "hello")).rejects.toThrow("did not receive");
    const events = await s.store.agentEvents(session.id, 0);
    expect(events.slice(-2).map(e => e.type)).toEqual(["user_message", "error"]);
  });

  it("resumes a finished session on its own branch with the conversation so far", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    await s.c.emit(session.id, { type: "message", text: "I fixed the total." });
    await s.c.emit(session.id, { type: "tool_call", tool: "read_file", args: {} });
    await s.c.onFinished({ sessionId: session.id, outcome: "done", turns: 2 });
    expect((await s.store.getSession(session.id))!.status).toBe("done");

    const resumed = await s.c.message(session.id, "now add a test");
    expect(resumed).toMatchObject({ id: session.id, status: "running", branch: session.branch, worktreePath: session.worktreePath });
    expect(resumed.endedAt).toBeUndefined();
    expect(s.host.starts).toBe(2);
    expect(s.host.startParams!.resume).toEqual({ history: [{ role: "assistant", text: "I fixed the total." }], message: "now add a test" });
    expect(s.git.created).toHaveLength(1);                      // no second worktree: the session keeps its own
    expect(await s.store.getTask("task_01")).toMatchObject({ status: "running", sessionId: session.id });
    const events = await s.store.agentEvents(session.id, 0);
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.slice(-2).map(e => e.type)).toEqual(["user_message", "status"]);
    expect(events.at(-1)).toMatchObject({ status: "running" });
    // and it can end again
    await s.c.onFinished({ sessionId: session.id, outcome: "done", turns: 1 });
    expect((await s.store.getSession(session.id))!.status).toBe("done");
  });

  it("fails the resumed session cleanly when the agent process will not start", async () => {
    const s = await setup();
    const session = await s.c.start("task_01", model);
    await s.c.onFinished({ sessionId: session.id, outcome: "done", turns: 1 });
    s.host.failStart = new Error("spawn failed");
    await expect(s.c.message(session.id, "again")).rejects.toThrow("did not resume");
    expect((await s.store.getSession(session.id))!.status).toBe("failed");
    expect(s.c.activeSession).toBeUndefined();
  });

  it("will not resume while another session runs, a session from another machine, or one that does not exist", async () => {
    const s = await setup();
    const first = await s.c.start("task_01", model);
    await s.c.onFinished({ sessionId: first.id, outcome: "done", turns: 1 });
    await s.store.putTask({ ...fx.task, id: "task_02", title: "second" });
    await s.c.start("task_02", model);
    await expect(s.c.message(first.id, "go on")).rejects.toThrow("Another agent session is running");
    await expect(s.c.message("ses_nope", "go on")).rejects.toThrow();
    const other = await setup();
    const o = await other.c.start("task_01", model);
    await other.c.onFinished({ sessionId: o.id, outcome: "done", turns: 1 });
    await other.store.putSession({ ...(await other.store.getSession(o.id))!, machineId: "m_brandon" });
    await expect(other.c.message(o.id, "go on")).rejects.toThrow("another machine");
  });
});

describe("historyOf", () => {
  it("keeps the person's messages and the agent's replies, newest within the size cap", () => {
    const at = "2026-11-08T00:00:00.000Z";
    const events = [
      { sessionId: "s", seq: 0, at, type: "message" as const, text: "a" },
      { sessionId: "s", seq: 1, at, type: "tool_call" as const, tool: "x", args: {} },
      { sessionId: "s", seq: 2, at, type: "user_message" as const, text: "b" },
      { sessionId: "s", seq: 3, at, type: "message" as const, text: "c".repeat(70_000) },
    ];
    expect(historyOf(events.slice(0, 3))).toEqual([{ role: "assistant", text: "a" }, { role: "user", text: "b" }]);
    expect(historyOf(events).map(h => h.text.length)).toEqual([70_000]);       // the newest turn is always kept, older ones dropped past the cap
  });
});
