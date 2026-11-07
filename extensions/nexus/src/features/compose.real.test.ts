import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessHost, type Transport } from "../agent/process-host";
import { AgentChannel } from "../agent-process/channel";
import { AgentRuntime } from "../agent-process/runtime";
import { SESSION_FINISHED } from "../agent-process/session-events";
import { FakeBridgeServer } from "../bridge/fake-bridge-server";
import { AgentEvent, type ApprovalRequest } from "../contracts";
import { fx } from "../contracts/fixtures";
import { FakeProvider } from "../models/fake-provider";
import type { TurnEvent } from "../models/provider";
import { buildLane2 } from "../register/lane-2-services";
import { connectSlackApprovals, type SlackApprovalResolver } from "../register/slack-approvals";
import { redact } from "../shared/redact";
import { LocalStore } from "../services/events/local-store";
import { GitCli } from "../services/git/git-cli";
import { APPROVE_ACTION_ID, registerInteractivity } from "../services/slack/interactivity";
import { BOT_USER, TEAM, identity, makeFakeBolt } from "../services/slack/fake-bolt.test-util";
import { AccountsService, type SecretStore, type StateStore } from "./accounts/accounts-service";
import { OptimizerService } from "./accounts/optimizer";
import { approvalsHookFor } from "./adapters/approvals-hook";
import { composeLane1 } from "./compose";
import type { GatePort } from "./ports";
import { FakeSlack, fakeClock } from "./testing/memory-ports";

// The cp-1 wiring without launching the fork: composeLane1 on Lane 2's real pieces (buildLane2, GitCli, LocalStore, the real
// gate) in a temp git repo. Only Slack, the model and the human are scripted. No network, no keys, no cmd.run.

const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
const usage = { inputTokens: 10, outputTokens: 5 };
const call = (id: string, name: string, args: unknown): TurnEvent[] => [{ type: "tool_call", id, name, args }, { type: "done", usage, stopReason: "tool_use" }];
// Built at run time so no secret-shaped literal sits in the source.
const SECRET = ["sk", "ant", "api03", "AbCdEf0123456789xYzQrStUv"].join("-");
const FIXED = "export const total = (q: number, p: number) => q * p;\n";
const BUGGY = "export const total = (q: number, p: number) => p;\n";
const SCRIPT: TurnEvent[][] = [
  call("tc_1", "read_file", { path: "config.txt" }),
  call("tc_2", "write_file", { path: "src/cart.ts", content: FIXED }),
  call("tc_3", "commit", { message: "fix cart total for qty > 1" }),
  [{ type: "text_delta", text: "Fixed the total." }, { type: "done", usage, stopReason: "end_turn" }],
];

const env = { ...process.env };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
const put = (root: string, rel: string, text: string) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); };

let base: string, repo: string, sessions: string, storeDir: string;
const toClose: Array<() => void> = [];
beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "nexus-real-")));
  repo = path.join(base, "repo"); sessions = path.join(base, "sessions"); storeDir = path.join(base, "store");
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.name", "Human Dev"); sh(repo, "config", "user.email", "human@example.com"); sh(repo, "config", "commit.gpgsign", "false");
  put(repo, "src/cart.ts", BUGGY);
  put(repo, "config.txt", `API_KEY=${SECRET}\n`);
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "seed");
});
afterEach(() => { while (toClose.length) { try { toClose.pop()!(); } catch { /* best effort */ } } rmSync(base, { recursive: true, force: true }); });

async function build() {
  const clock = fakeClock();
  const store = new LocalStore({ dir: storeDir, redact });
  const git = new GitCli(repo, { sessionsDir: sessions });
  const lane2 = buildLane2({
    router: new FakeBridgeServer(), store, redact, secret: async () => undefined, env: {}, git, allowlist: () => [],
    openExternal: async () => true, log: () => {},
    slackSeams: { makeBotApi: () => { throw new Error("no Slack in this test"); }, socketOptions: { makeApp: () => { throw new Error("no socket in this test"); }, sleep: () => new Promise(() => undefined) } },
  });
  const secretMap = new Map<string, string>();
  const secrets: SecretStore = { get: async k => secretMap.get(k), store: async (k, v) => { secretMap.set(k, v); }, delete: async k => { secretMap.delete(k); } };
  const stateMap = new Map<string, unknown>();
  const state: StateStore = { get: <T>(k: string) => stateMap.get(k) as T | undefined, update: async (k, v) => { stateMap.set(k, v); } };
  const accounts = new AccountsService({ secrets, state, providers: { anthropic: new FakeProvider({ id: "anthropic" }) }, env: {} });
  await accounts.connect("anthropic", "sk-live-key");
  const shown: Array<{ approval: ApprovalRequest; text: string }> = [];
  const logs: string[] = [];
  const lane = composeLane1({
    store, git: lane2.git!, slack: new FakeSlack([fx.thread]), clock, machineId: "m_real",
    makeGate: approvals => lane2.makeGate!(approvalsHookFor(approvals)) as GatePort,
    createHost: cb => {
      const hostToChild = new PassThrough(); const childToHost = new PassThrough();
      const channel = new AgentChannel(hostToChild, childToHost);
      new AgentRuntime({ providers: { anthropic: new FakeProvider({ script: SCRIPT }) }, gate: channel, onFinished: o => channel.notify(SESSION_FINISHED, o) }).attach(channel);
      const transport: Transport = { stdin: hostToChild, stdout: childToHost, kill: () => channel.close(), onExit: () => {} };
      return new ProcessHost({ spawn: () => transport, handlers: cb.handlers, onSessionFinished: cb.onSessionFinished, onSessionError: (id, m) => cb.onSessionError(id, m) });
    },
    accounts, optimizer: new OptimizerService({ state, store, getPruneKey: async () => undefined }),
    notify: { show: (approval, text) => { shown.push({ approval, text }); }, update: () => {} },
    swarms: { run: async () => ({ text: "candidate", output: [{ role: "aggregator_agent", content: "candidate" }] }), complete: async () => ({ text: JSON.stringify({ verdict: "looks_good", summary: "minimal fix", judges: [] }) }) }, getSwarmsKey: async () => "swarms-key",
    identity: () => ({ userId: "adrian", name: "Adrian" }), workspaceId: () => "ws_demo", agentModel: () => model,
    log: m => logs.push(m),                                   // lane2.approvalHooks (the Slack card) is left out: it needs a live bot token
  });
  toClose.push(() => lane.host.dispose?.(), () => lane2.dispose());
  return { lane, lane2, store, shown, logs };
}

type Built = Awaited<ReturnType<typeof build>>;
async function startAndWaitForCommitApproval(t: Built) {
  const task = await t.lane.tasks.createFromThread("C_DEMO", fx.thread.threadTs);
  const session = await t.lane.sessions.start(task.id, model);
  await vi.waitFor(() => expect(t.shown).toHaveLength(1), { timeout: 10000 });
  expect(t.shown[0].approval.action).toMatchObject({ kind: "commit", message: "fix cart total for qty > 1" });
  return { task, session, approval: t.shown[0].approval };
}

async function assertSliceOutcome(t: Built, taskId: string, sessionId: string, headBefore: string, statusBefore: string, decidedBy: object) {
  await vi.waitFor(async () => expect((await t.store.getSession(sessionId))!.status).toBe("done"), { timeout: 10000 });
  const session = (await t.store.getSession(sessionId))!;

  // The session's own worktree on its own branch, outside the user's checkout.
  expect(session.branch).toBe(`nexus/agent-${sessionId}`);
  expect(existsSync(session.worktreePath)).toBe(true);
  expect(path.dirname(session.worktreePath)).toBe(sessions);
  expect(sh(session.worktreePath, "symbolic-ref", "--short", "HEAD")).toBe(session.branch);

  // Its commit contains the edit, on top of the base commit.
  const events = await t.store.agentEvents(sessionId, 0);
  const sha = (events.find(e => e.type === "commit") as { sha: string }).sha;
  expect(sh(repo, "rev-parse", session.branch)).toBe(sha);
  expect(sh(repo, "rev-parse", `${sha}^`)).toBe(session.baseCommit);
  expect(execFileSync("git", ["show", `${sha}:src/cart.ts`], { cwd: repo, encoding: "utf8", env })).toBe(FIXED);

  // The user's checkout: same branch, same commit, same files, same status.
  expect(sh(repo, "rev-parse", "HEAD")).toBe(headBefore);
  expect(sh(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(sh(repo, "status", "--porcelain")).toBe(statusBefore);
  expect(readFileSync(path.join(repo, "src/cart.ts"), "utf8")).toBe(BUGGY);

  // Events replay from seq 0 with no gaps, all valid, through the store and through the bridge replay.
  expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i));
  expect(events.every(e => AgentEvent.safeParse(e).success)).toBe(true);
  const replayed: AgentEvent[] = [];
  await t.lane.replays["agent.subscribe"]({ sessionId, fromSeq: 0 }, e => replayed.push(e));
  expect(replayed).toEqual(events);
  expect(events.filter(e => e.type === "status").map(e => (e as { status: string }).status)).toEqual(["running", "awaiting_approval", "running", "done"]);
  for (const kind of ["message", "tool_call", "tool_result", "file_edit", "approval_request", "approval_resolved", "commit"]) expect(events.some(e => e.type === kind), kind).toBe(true);

  // The decision is a human's, recorded once.
  const approvals = await t.lane.approvals.list();
  expect(approvals).toHaveLength(1);
  expect(approvals[0]).toMatchObject({ decision: "approved", decidedBy });
  expect(await t.store.getTask(taskId)).toMatchObject({ status: "done", sessionId });
  expect(t.logs).toEqual([]);
  return { events, sha };
}

describe("composeLane1 on the real Lane 2 pieces, in a temp git repo", () => {
  // Real git processes: slow on Windows and under a parallel suite, so the default 5 s is too tight.
  vi.setConfig({ testTimeout: 60_000 });
  it("runs thread -> task -> agent -> commit approval by a human in the app, and a second answer loses", async () => {
    put(repo, "wip.txt", "uncommitted\n");                                   // the user's own work in progress must survive
    const headBefore = sh(repo, "rev-parse", "HEAD");
    const statusBefore = sh(repo, "status", "--porcelain");
    const t = await build();
    const { task, session, approval } = await startAndWaitForCommitApproval(t);

    // While it waits, nothing is committed and nobody has decided.
    expect((await t.store.getApproval(approval.id))!.decision).toBeUndefined();
    expect(sh(repo, "branch", "--list", "nexus/*")).toContain(`nexus/agent-${session.id}`);
    expect(sh(session.worktreePath, "rev-parse", "HEAD")).toBe(session.baseCommit);

    const won = await t.lane.handlers["approvals.resolve"]({ approvalId: approval.id, decision: "approved" });
    expect(won).toMatchObject({ decision: "approved", decidedBy: { via: "app", userId: "adrian" } });
    const human = { via: "app", userId: "adrian" };
    const { events } = await assertSliceOutcome(t, task.id, session.id, headBefore, statusBefore, human);

    // The loser sees the winner and changes nothing.
    const late = await t.lane.approvals.resolve(approval.id, "rejected", { via: "app", userId: "brandon" });
    expect(late.won).toBe(false);
    expect(late.approval).toMatchObject({ decision: "approved", decidedBy: human });
    expect(await t.store.getApproval(approval.id)).toMatchObject({ decision: "approved", decidedBy: human });
    expect(await t.store.agentEvents(session.id, 0)).toHaveLength(events.length);
  });

  it("accepts a Slack button click routed through connectSlackApprovals, and the app's later answer loses", async () => {
    const headBefore = sh(repo, "rev-parse", "HEAD");
    const statusBefore = sh(repo, "status", "--porcelain");
    const t = await build();
    let resolver: SlackApprovalResolver | undefined;
    connectSlackApprovals({ setSlackApprovalResolver: r => { resolver = r; } }, t.lane.approvals);
    connectSlackApprovals({ setSlackApprovalResolver: t.lane2.setApprovalResolver }, t.lane.approvals);                         // the real setter too: it must accept the controller's resolve
    expect(resolver).toBeDefined();
    const { task, session, approval } = await startAndWaitForCommitApproval(t);

    // The Slack card exists; a click on it goes through Lane 2's real interactivity handler into the controller.
    await t.store.putApproval({ ...(await t.store.getApproval(approval.id))!, slackMessage: { channelId: "C_DEMO", ts: "30.000100" } });
    const bolt = makeFakeBolt();
    const cardUpdates: string[] = [];
    registerInteractivity(bolt.app, {
      resolve: (id, decision, by) => resolver!(id, decision, by),
      getApproval: id => t.store.getApproval(id),
      bot: { updateBotMessage: async (_c, _ts, text) => { cardUpdates.push(text); return {} as never; } },
      botIdentity: async () => identity,
    });
    await bolt.click(APPROVE_ACTION_ID, {
      body: { type: "block_actions", team: { id: TEAM }, user: { id: "U_BRANDON", name: "brandon" }, container: { channel_id: "C_DEMO", message_ts: "30.000100" }, message: { ts: "30.000100", user: BOT_USER, bot_id: "B1" } },
      action: { action_id: APPROVE_ACTION_ID, block_id: "nexus.approval", value: approval.id },
    });

    await assertSliceOutcome(t, task.id, session.id, headBefore, statusBefore, { via: "slack", userId: "U_BRANDON" });
    expect(cardUpdates).toHaveLength(1);
    const late = await t.lane.approvals.resolve(approval.id, "rejected", { via: "app", userId: "adrian" });
    expect(late.won).toBe(false);
    expect(late.approval.decidedBy).toMatchObject({ via: "slack", userId: "U_BRANDON" });
  });

  it("stores a secret-looking tool result redacted, in memory and on disk", async () => {
    const t = await build();
    const { session, approval } = await startAndWaitForCommitApproval(t);
    await t.lane.approvals.resolve(approval.id, "approved", { via: "app", userId: "adrian" });
    await vi.waitFor(async () => expect((await t.store.getSession(session.id))!.status).toBe("done"), { timeout: 10000 });
    const events = await t.store.agentEvents(session.id, 0);
    const result = events.find(e => e.type === "tool_result" && (e as { tool: string }).tool === "read_file") as { summary: string } | undefined;
    expect(result).toBeDefined();
    expect(result!.summary).toContain("API_KEY");                              // the tool did read the file ...
    expect(JSON.stringify(events)).not.toContain(SECRET);                      // ... and the key did not reach the store
    for (const f of readdirSync(storeDir)) expect(readFileSync(path.join(storeDir, f), "utf8"), f).not.toContain(SECRET);
  });
});
