import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ProcessHost, type Transport } from "../agent/process-host";
import { AgentChannel } from "../agent-process/channel";
import { AgentRuntime } from "../agent-process/runtime";
import { SESSION_FINISHED } from "../agent-process/session-events";
import { AgentEvent, Requests, Subscriptions, type ApprovalRequest, type Task } from "../contracts";
import { fx } from "../contracts/fixtures";
import { FakeProvider } from "../models/fake-provider";
import { AccountsService, type SecretStore, type StateStore } from "./accounts/accounts-service";
import { OptimizerService } from "./accounts/optimizer";
import { composeLane1, type Lane1Deps } from "./compose";
import { FakeGit, FakeSlack, MemoryGate, MemoryStore, fakeClock } from "./testing/memory-ports";
import type { SwarmRun, SwarmRunInput } from "./swarms/swarms-client";

const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };

async function build(over: Partial<Lane1Deps> = {}) {
  const store = new MemoryStore();
  const clock = fakeClock();
  const secretMap = new Map<string, string>();
  const secrets: SecretStore = { get: async k => secretMap.get(k), store: async (k, v) => { secretMap.set(k, v); }, delete: async k => { secretMap.delete(k); } };
  const stateMap = new Map<string, unknown>();
  const state: StateStore = { get: <T>(k: string) => stateMap.get(k) as T | undefined, update: async (k, v) => { stateMap.set(k, v); } };
  const accounts = new AccountsService({ secrets, state, providers: { anthropic: new FakeProvider({ id: "anthropic" }) }, env: {} });
  await accounts.connect("anthropic", "sk-live-key");
  const optimizer = new OptimizerService({ state, store, getPruneKey: async () => undefined });

  const shown: Array<{ approval: ApprovalRequest; text: string; choose(d: "approved" | "rejected"): void }> = [];
  const swarmCalls: SwarmRunInput[] = [];
  const swarms = { run: async (input: SwarmRunInput): Promise<SwarmRun> => { swarmCalls.push(input); const text = JSON.stringify({ verdict: "looks_good", summary: "Fix is minimal and covered by the new test", judges: [{ modelId: "judge-a", verdict: "looks_good", notes: "Correct arithmetic" }] }); return { text, output: [{ role: "Aggregator", content: text }] }; } };
  const gates: MemoryGate[] = [];
  const logs: string[] = [];

  const deps: Lane1Deps = {
    store, git: new FakeGit(), slack: new FakeSlack([fx.thread]), clock, machineId: "m_adrian",
    makeGate: approvals => { const g = new MemoryGate({ approvals, files: { "src/cart.ts": "old" } }); gates.push(g); return g; },
    createHost: cb => {
      const hostToChild = new PassThrough();
      const childToHost = new PassThrough();
      const channel = new AgentChannel(hostToChild, childToHost);
      new AgentRuntime({ providers: { anthropic: new FakeProvider() }, gate: channel, onFinished: o => channel.notify(SESSION_FINISHED, o) }).attach(channel);
      const transport: Transport = { stdin: hostToChild, stdout: childToHost, kill: () => channel.close(), onExit: () => {} };
      return new ProcessHost({ spawn: () => transport, handlers: cb.handlers, onSessionFinished: cb.onSessionFinished, onSessionError: (id, m) => cb.onSessionError(id, m) });
    },
    accounts, optimizer,
    notify: { show: (approval, text, choose) => shown.push({ approval, text, choose }), update: () => {} },
    swarms, getSwarmsKey: async () => "swarms-key",
    identity: () => ({ userId: "adrian", name: "Adrian" }), workspaceId: () => "ws_demo",
    agentModel: () => model, log: m => logs.push(m), ...over,
  };
  const lane = composeLane1(deps);
  return { lane, store, shown, swarmCalls, gates, logs, accounts };
}

const statuses = (events: AgentEvent[]) => events.filter(e => e.type === "status").map(e => (e as { status: string }).status);

describe("the whole Lane 1 slice, offline: thread -> task -> agent -> approvals -> commit", () => {
  it("runs end to end with a human approving the command and the commit, and a swarm review on the commit", async () => {
    const t = await build();
    const { lane, store, shown } = t;
    const seenTasks: string[] = [];
    lane.tasks.subscribe((task: Task) => seenTasks.push(task.status));

    const task = await lane.tasks.createFromThread("C_DEMO", fx.thread.threadTs);
    expect(task.status).toBe("draft");
    const session = await lane.sessions.start(task.id, model);

    await vi.waitFor(() => expect(shown).toHaveLength(1), { timeout: 5000 });                    // cmd.run waits on a human
    expect(shown[0].text).toContain("Agent wants to run: npm test");
    shown[0].choose("approved");

    await vi.waitFor(() => expect(shown).toHaveLength(2), { timeout: 5000 });                    // the commit
    const commitApproval = shown[1].approval;
    expect(commitApproval.action.kind).toBe("commit");
    await vi.waitFor(async () => expect((await lane.review.get(commitApproval.id))?.status).toBe("done"), { timeout: 5000 });
    expect((await store.getApproval(commitApproval.id))!.decision).toBeUndefined();              // the review informed nobody's decision
    shown[1].choose("approved");

    await vi.waitFor(async () => expect((await store.getSession(session.id))!.status).toBe("done"), { timeout: 5000 });

    // The task, the session, the events, the approvals and the review all agree.
    expect(await store.getTask(task.id)).toMatchObject({ status: "done", sessionId: session.id });
    const events = await store.agentEvents(session.id, 0);
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.every(e => AgentEvent.safeParse(e).success)).toBe(true);
    expect(statuses(events)).toEqual(["running", "awaiting_approval", "running", "awaiting_approval", "running", "done"]);
    for (const kind of ["message", "tool_call", "tool_result", "file_edit", "test_output", "approval_request", "approval_resolved", "commit"]) expect(events.some(e => e.type === kind), kind).toBe(true);
    const decided = (await lane.approvals.list()).map(a => [a.action.kind, a.decision, a.decidedBy?.via, a.decidedBy?.userId]);
    expect(decided).toEqual([["run_command", "approved", "app", "adrian"], ["commit", "approved", "app", "adrian"]]);
    expect(await lane.review.get(commitApproval.id)).toMatchObject({ verdict: "looks_good", dataLeftMachine: true });
    expect(t.swarmCalls).toHaveLength(1);
    expect(t.swarmCalls[0]).toMatchObject({ swarmType: "CouncilAsAJudge", sessionId: session.id });
    expect(t.gates[0].files.get("src/cart.ts")).toBe("<fixed cart.ts>");
    expect(store.nexusEvents.map(e => e.kind).sort()).toEqual(["agent_session", "slack_task"]);
    expect(seenTasks).toEqual(["draft", "running", "awaiting_approval", "running", "awaiting_approval", "running", "done"]);
    expect(t.logs).toEqual([]);
    lane.host.dispose?.();
  });

  it("a human cancelling mid-approval stops the agent, records the rejection under their name, and a late APPROVE does nothing", async () => {
    const t = await build();
    const { lane, store, shown } = t;
    const task = await lane.tasks.createFromThread("C_DEMO", fx.thread.threadTs);
    const session = await lane.sessions.start(task.id, model);
    await vi.waitFor(() => expect(shown).toHaveLength(1), { timeout: 5000 });
    await lane.sessions.cancel(session.id);
    expect((await store.getSession(session.id))!.status).toBe("cancelled");
    expect(await store.getApproval(shown[0].approval.id)).toMatchObject({ decision: "rejected", decidedBy: { via: "app", userId: "adrian" } });
    shown[0].choose("approved");                                                                  // too late
    await new Promise(r => setTimeout(r, 30));
    expect((await store.agentEvents(session.id, 0)).some(e => e.type === "test_output")).toBe(false);
    expect(await store.getTask(task.id)).toMatchObject({ status: "cancelled" });
    // and the lane is free again
    await store.putTask({ ...fx.task, id: "task_next" });
    await expect(lane.sessions.start("task_next", model)).resolves.toBeDefined();
    lane.host.dispose?.();
  });

  it("refuses a model the accounts did not return for the agent", async () => {
    const t = await build();
    const task = await t.lane.tasks.createFromThread("C_DEMO", fx.thread.threadTs);
    await expect(t.lane.sessions.start(task.id, { provider: "swarms", modelId: "swarms:single-agent" })).rejects.toThrow("cannot run the coding agent");
    await expect(t.lane.sessions.start(task.id, { provider: "anthropic", modelId: "not-a-model" })).rejects.toThrow("cannot run the coding agent");
    expect((await t.store.getTask(task.id))!.status).toBe("draft");
  });
});

describe("the protocol surface of Lane 1", () => {
  it("serves exactly the webview requests and subscriptions the contracts give this lane, and nothing owned by another lane", async () => {
    const t = await build();
    const served = Object.keys(t.lane.handlers).sort();
    const notLane1 = Object.keys(Requests).filter(n => !served.includes(n)).sort();
    expect(served.every(n => n in Requests)).toBe(true);
    // Everything not served here belongs to Lane 2 (Slack, events, git, code refs, bridge) or Lane 3 (ui), or is auth without a session.
    expect(notLane1).toEqual([
      "app.ping", "auth.status", "coderef.create", "coderef.open", "events.activity", "events.query", "events.search", "git.branches",
      "git.commit.show", "git.mergeAgentBranch", "slack.channels", "slack.history", "slack.post", "slack.status", "slack.thread", "slack.users",
      "store.status", "ui.openExternal", "ui.openTarget", "ui.setTimeWindow",
    ]);
    const subs = Object.keys(t.lane.subscriptions).sort();
    expect(subs.every(n => n in Subscriptions)).toBe(true);
    expect(Object.keys(Subscriptions).filter(n => !subs.includes(n)).sort()).toEqual(["events.subscribe", "slack.subscribe", "store.subscribe"]);
  });

  it("answers the request handlers with contract-shaped data", async () => {
    const t = await build();
    const h = t.lane.handlers;
    Requests["accounts.list"].res.parse(await h["accounts.list"]());
    Requests["models.list"].res.parse(await h["models.list"]({ role: "agent" }));
    Requests["optimizer.get"].res.parse(await h["optimizer.get"]());
    const task = await h["tasks.createFromThread"]({ channelId: "C_DEMO", threadTs: fx.thread.threadTs });
    Requests["tasks.createFromThread"].res.parse(task);
    Requests["tasks.list"].res.parse(await h["tasks.list"]({}));
    Requests["approvals.list"].res.parse(await h["approvals.list"]({ pendingOnly: false }));
    Requests["receipts.list"].res.parse(await h["receipts.list"]({ limit: 100 }));
    expect(await h["swarms.review.get"]({ approvalId: "none" })).toBeNull();
  });
});
