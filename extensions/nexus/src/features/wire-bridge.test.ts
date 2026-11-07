import { describe, expect, it } from "vitest";
import { FakeBridgeServer } from "../bridge/fake-bridge-server";
import { BridgeError } from "../bridge/types";
import type { AgentEvent, ApprovalRequest, RequestName, SubscriptionName } from "../contracts";
import { fx } from "../contracts/fixtures";
import { FakeProvider } from "../models/fake-provider";
import { FakeEventStore } from "../services/events/fake-store";
import { FakeSlack } from "../services/slack/fake-slack";
import { AccountsService, type SecretStore, type StateStore } from "./accounts/accounts-service";
import { OptimizerService } from "./accounts/optimizer";
import { lane1Commands, type CommandUi } from "./commands";
import { composeLane1 } from "./compose";
import { FakeGit, MemoryGate, fakeClock } from "./testing/memory-ports";
import { wireLane1ToRouter } from "./wire-bridge";

// Lane 1 against the BridgeRouter interface, with Lane 2's fakes (store, Slack, router) and nothing real behind them.

function build() {
  const store = new FakeEventStore({ seed: false });
  const secretMap = new Map<string, string>();
  const secrets: SecretStore = { get: async k => secretMap.get(k), store: async (k, v) => { secretMap.set(k, v); }, delete: async k => { secretMap.delete(k); } };
  const stateMap = new Map<string, unknown>();
  const state: StateStore = { get: <T>(k: string) => stateMap.get(k) as T | undefined, update: async (k, v) => { stateMap.set(k, v); } };
  const accounts = new AccountsService({ secrets, state, providers: { anthropic: new FakeProvider({ id: "anthropic" }) }, env: {} });
  const shown: Array<{ approval: ApprovalRequest; choose(d: "approved" | "rejected"): void }> = [];
  const lane = composeLane1({
    store, git: new FakeGit(), slack: new FakeSlack(), clock: fakeClock(), machineId: "m_test",
    makeGate: approvals => new MemoryGate({ approvals, files: {} }),
    createHost: () => ({ startSession: async () => ({ accepted: true }), cancelSession: async () => ({ cancelled: true }), endSession: () => {}, sendEvent: () => true } as never),
    accounts, optimizer: new OptimizerService({ state, store, getPruneKey: async () => "prune" }),
    notify: { show: (approval, _t, choose) => shown.push({ approval, choose }), update: () => {} },
    swarms: { run: async () => { throw new Error("offline"); } }, getSwarmsKey: async () => undefined,
    identity: () => ({ userId: "adrian", name: "Adrian" }), workspaceId: () => "ws_demo",
    agentModel: () => ({ provider: "anthropic", modelId: "m" }),
  });
  const router = new FakeBridgeServer();
  const wired = wireLane1ToRouter(lane, router);
  return { lane, store, router, wired, shown };
}

const subscribeReq: Record<string, Record<string, unknown>> = {
  "agent.subscribe": { sessionId: "ses_a" },
  "approvals.subscribe": {}, "tasks.subscribe": {}, "swarms.review.subscribe": {}, "receipts.subscribe": {},
};

describe("wireLane1ToRouter", () => {
  it("registers every handler Lane 1 serves", async () => {
    const t = build();
    for (const name of Object.keys(t.lane.handlers)) {
      const err = await t.router.call(name as RequestName, {} as never).then(() => undefined, (e: unknown) => e);
      expect(err instanceof BridgeError && err.code === "not_found", `${name} has no handler`).toBe(false);
    }
    expect(Object.keys(t.lane.handlers).length).toBeGreaterThan(20);
  });

  it("registers every live subscription", async () => {
    const t = build();
    expect(Object.keys(t.lane.live).sort()).toEqual(Object.keys(subscribeReq).sort());
    for (const name of Object.keys(t.lane.live)) {
      const handle = await t.router.subscribe(name as SubscriptionName, subscribeReq[name] as never, () => {});
      handle.dispose();
    }
  });

  it("serves a thread-to-task request end to end", async () => {
    const t = build();
    const task = await t.router.call("tasks.createFromThread", { channelId: fx.thread.channelId, threadTs: fx.thread.threadTs });
    expect(task.status).toBe("draft");
    expect((await t.router.call("tasks.get", { taskId: task.id })).id).toBe(task.id);
    const seen: string[] = [];
    await t.router.subscribe("tasks.subscribe", {}, task2 => seen.push(task2.id));
    t.lane.tasks.publish(task);
    expect(seen).toEqual([task.id]);
  });

  it("replays stored agent events, then streams live ones in order, once each", async () => {
    const t = build();
    const emit = (text: string) => t.lane.sessions.emit("ses_a", { type: "message", text });
    await emit("one"); await emit("two");
    const seqs: number[] = [];
    await t.router.subscribe("agent.subscribe", { sessionId: "ses_a", fromSeq: 0 }, (e: AgentEvent) => seqs.push(e.seq));
    expect(seqs).toEqual([0, 1]);
    await emit("three");
    await emit("four");
    expect(seqs).toEqual([0, 1, 2, 3]);
    const late: number[] = [];
    await t.router.subscribe("agent.subscribe", { sessionId: "ses_a", fromSeq: 2 }, e => late.push(e.seq));
    await emit("five");
    expect(late).toEqual([2, 3, 4]);
    const other: number[] = [];
    await t.router.subscribe("agent.subscribe", { sessionId: "ses_b", fromSeq: 0 }, e => other.push(e.seq));
    expect(other).toEqual([]);                                    // scoped by session
  });

  it("maps a lost approval race to the conflict code with the winner in the message", async () => {
    const t = build();
    void t.lane.approvals.request({ sessionId: "ses_a", action: { kind: "run_command", command: "npm test" }, reason: "tests" });
    await new Promise(r => setTimeout(r, 20));
    const [pending] = await t.store.listApprovals().then(all => all.filter(a => !a.decision && a.sessionId === "ses_a"));
    const won = await t.router.call("approvals.resolve", { approvalId: pending.id, decision: "approved" });
    expect(won.decision).toBe("approved");
    const err = await t.router.call("approvals.resolve", { approvalId: pending.id, decision: "rejected" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("conflict");
    expect((err as BridgeError).message).toContain("adrian");
  });

  it("dispose removes everything so the lane can be wired again", () => {
    const t = build();
    t.wired.dispose();
    expect(() => wireLane1ToRouter(t.lane, t.router)).not.toThrow();
  });
});

describe("lane1Commands", () => {
  function ui() {
    const infos: string[] = [];
    const errors: string[] = [];
    const picks: Array<Array<{ id: string }>> = [];
    let choice: string | undefined;
    const u: CommandUi = {
      info: m => infos.push(m), error: m => errors.push(m),
      pickApproval: async items => { picks.push(items); return choice; },
    };
    return { u, infos, errors, picks, choose: (id: string | undefined) => { choice = id; } };
  }

  async function pending(t: ReturnType<typeof build>, n: number) {
    await t.store.putSession({ ...fx.session, id: "ses_a", status: "awaiting_approval" });
    for (let i = 0; i < n; i++) void t.lane.approvals.request({ sessionId: "ses_a", action: { kind: "commit", message: `m${i}` }, reason: "r" });
    await new Promise(r => setTimeout(r, 20));
  }

  it("approve with nothing waiting says so and decides nothing", async () => {
    const t = build();
    const c = ui();
    await lane1Commands(t.lane, c.u, () => "adrian")["nexus.approve"]();
    expect(c.infos).toEqual(["Nothing is waiting for approval."]);
  });

  it("approve takes the only waiting approval; reject by id works; a second answer reports the winner", async () => {
    const t = build();
    const c = ui();
    const cmds = lane1Commands(t.lane, c.u, () => "adrian");
    await pending(t, 1);
    await cmds["nexus.approve"]();
    const [a] = (await t.store.listApprovals()).filter(x => x.sessionId === "ses_a");
    expect(a.decision).toBe("approved");
    await cmds["nexus.reject"](a.id);
    expect(c.infos.at(-1)).toContain("Already decided by adrian via app");
  });

  it("with several waiting it asks which, and a dismissed pick decides nothing", async () => {
    const t = build();
    const c = ui();
    const cmds = lane1Commands(t.lane, c.u, () => "adrian");
    await pending(t, 2);
    await cmds["nexus.reject"]();
    expect(c.picks[0]).toHaveLength(2);
    expect((await t.store.listApprovals()).filter(x => x.sessionId === "ses_a" && x.decision)).toHaveLength(0);
    c.choose(c.picks[0][1].id);
    await cmds["nexus.reject"]();
    expect((await t.store.getApproval(c.picks[0][1].id))!.decision).toBe("rejected");
  });

  it("makes a task from a thread, and asks for a thread when none is given", async () => {
    const t = build();
    const c = ui();
    const cmds = lane1Commands(t.lane, c.u, () => "adrian");
    await cmds["nexus.makeTaskFromThread"]();
    expect(c.infos[0]).toContain("Slack view");
    await cmds["nexus.makeTaskFromThread"](fx.thread.channelId, fx.thread.threadTs);
    expect(c.infos[1]).toContain("Created a draft task");
    await cmds["nexus.makeTaskFromThread"]("C_NOPE", "1.1");
    expect(c.errors).toHaveLength(1);
  });

  it("toggles Prune and reports a failure instead of throwing", async () => {
    const t = build();
    const c = ui();
    const cmds = lane1Commands(t.lane, c.u, () => "adrian");
    await cmds["nexus.toggleOptimizer"]();
    expect(c.infos[0]).toBe("Optimize with Prune is on.");
    await cmds["nexus.cancelSession"]();
    expect(c.infos[1]).toBe("No agent session is running.");
  });
});
