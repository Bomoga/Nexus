import type { AgentHandlers } from "../agent/process-host";
import type { SessionFinished } from "../agent-process/session-events";
import type { AgentEvent, ApprovalRequest, ModelCallReceipt, ModelInfo, SwarmReview, Task } from "../contracts";
import type { AccountsService } from "./accounts/accounts-service";
import { accountsBridgeHandlers } from "./accounts/accounts-service";
import { pickerBridgeHandlers, type ModelPicker } from "./accounts/model-picker";
import { ApprovalsController, approvalsBridgeHandlers, type ApprovalHook, type NotifyPort } from "./approvals/approvals-controller";
import { authBridgeHandlers, type Auth0Session } from "./auth/auth0-signin";
import type { Clock, GatePort, GitPort, SlackPort, StorePort } from "./ports";
import { Scheduler, type SchedulerDeps } from "./sessions/scheduler";
import { SessionsController, sessionsBridgeHandlers, sessionsSubscriptions, type ApprovalRequester, type HostPort, type ProgressPort } from "./sessions/sessions-controller";
import { optimizerBridgeHandlers, receiptSubscriptions, type OptimizerService } from "./accounts/optimizer";
import { DecomposeService, planBridgeHandlers } from "./tasks/decompose";
import { TasksController, tasksBridgeHandlers } from "./tasks/tasks-controller";
import { SwarmReviewService, swarmReviewBridgeHandlers, swarmReviewSubscriptions, type SwarmsRunner } from "./swarms/review";

// Composition root for Lane 1's extension-side features. Everything here is built from ports (src/features/ports.ts)
// and a few small services, so the same wiring runs against Lane 2's real store, git, gate and Slack services and
// against the in-memory ports in tests. The controllers reference each other (the gate asks approvals, approvals emit
// session events, sessions serve the agent), so the references are bound late.

export interface AgentHost extends HostPort {
  sendEvent(name: "approval.resolved", body: { approvalId: string; decision: "approved" | "rejected" }): boolean;
  /** Stops the agent process (ProcessHost.dispose); called when the extension deactivates. */
  dispose?(): void;
}

export interface HostCallbacks {
  handlers: AgentHandlers;
  onSessionFinished(outcome: SessionFinished): void;
  onSessionError(sessionId: string, message: string): void;
}

export interface Lane1Deps {
  store: StorePort;
  git: GitPort;
  slack: SlackPort;
  clock: Clock;
  machineId: string;
  /** Lane 2's gate, given the approvals it must wait on for commands, commits and writes outside scope. */
  makeGate(approvals: ApprovalRequester): GatePort;
  /** Creates the agent process host (a real ProcessHost, or an in-process stand-in in tests). */
  createHost(callbacks: HostCallbacks): AgentHost;
  accounts: Pick<AccountsService, "getKey" | "models" | "list" | "test">;
  optimizer: OptimizerService;
  notify: NotifyPort;
  swarms: SwarmsRunner;
  getSwarmsKey(): Promise<string | undefined>;
  identity(): { userId: string; name: string; auth0UserId?: string };
  workspaceId(): string | Promise<string>;
  /** The model the user picked for the agent, for plans that run several sessions. */
  agentModel(): { provider: string; modelId: string } | undefined;
  /** The status-bar picker, so the agent view's composer reads and writes the same remembered model (models.selected / models.select). */
  picker?: ModelPicker;
  auth?: Auth0Session;
  progress?: ProgressPort;
  /** Further surfaces told about every approval, such as Lane 2's Slack approval message. */
  extraApprovalHooks?: ApprovalHook[];
  scheduler?: Pick<SchedulerDeps, "maxConcurrent" | "retryMs">;
  log?: (message: string) => void;
}

export function composeLane1(d: Lane1Deps) {
  const log = d.log;
  // Late-bound references (see the file comment): each is assigned exactly once, after the objects that capture it.
  /* eslint-disable prefer-const */
  let approvals!: ApprovalsController;
  let scheduler!: Scheduler;
  let host!: AgentHost;
  /* eslint-enable prefer-const */

  const requester: ApprovalRequester = {
    request: input => approvals.request(input),
    sessionEnded: (id, how) => approvals.sessionEnded(id, how),
    sessionResumed: id => approvals.sessionResumed(id),
  };
  const gate = d.makeGate(requester);
  const hostPort: HostPort = {
    startSession: p => host.startSession(p),
    cancelSession: id => host.cancelSession(id),
    endSession: id => host.endSession(id),
    messageSession: (id, text) => (host.messageSession ? host.messageSession(id, text) : Promise.reject(new Error("follow-up messages are not available"))),
  };

  const tasks = new TasksController({
    store: d.store, slack: d.slack, clock: d.clock, machineId: d.machineId,
    workspaceId: d.workspaceId, identity: d.identity,
  });

  const review = new SwarmReviewService({ store: d.store, clock: d.clock, swarms: d.swarms, getKey: d.getSwarmsKey, log });

  const sessions = new SessionsController({
    store: d.store, git: d.git, gate, host: hostPort, clock: d.clock, machineId: d.machineId, log,
    getKey: provider => d.accounts.getKey(provider),
    agentModels: (): ModelInfo[] => d.accounts.models("agent"),
    approvals: requester, progress: d.progress,
    onTaskChange: t => { tasks.publish(t); scheduler?.observe(t); },
    prune: () => d.optimizer.pruneFor("agent"),
    onReceipt: r => { d.optimizer.record(r).catch(e => log?.(`could not record a receipt: ${e instanceof Error ? e.message : "unknown error"}`)); },
  });

  approvals = new ApprovalsController({
    store: d.store, clock: d.clock, sessions, notify: d.notify, log,
    identity: () => d.identity().userId,
    host: { sendEvent: (name, body) => host.sendEvent(name, body) },
    hooks: [review, ...(d.extraApprovalHooks ?? [])],
  });

  host = d.createHost({
    handlers: sessions.agentHandlers(),
    onSessionFinished: o => { sessions.onFinished(o).catch(e => log?.(`could not finish the session: ${e instanceof Error ? e.message : "unknown error"}`)); },
    onSessionError: (id, message) => { sessions.onProcessError(id, message).catch(e => log?.(`could not fail the session: ${e instanceof Error ? e.message : "unknown error"}`)); },
  });

  const decompose = new DecomposeService({ store: d.store, clock: d.clock, swarms: d.swarms, getKey: d.getSwarmsKey, onTaskCreated: t => tasks.publish(t) });
  scheduler = new Scheduler({ store: d.store, sessions, model: d.agentModel, log, ...d.scheduler });

  /** Every webview request this lane serves, by protocol name; Lane 2's bridge router registers them. */
  const handlers = {
    ...accountsBridgeHandlers(d.accounts as AccountsService),
    ...sessionsBridgeHandlers(sessions, d.store),
    ...approvalsBridgeHandlers(approvals, () => d.identity().userId),
    ...tasksBridgeHandlers(tasks),
    ...swarmReviewBridgeHandlers(review),
    ...planBridgeHandlers(decompose),
    ...optimizerBridgeHandlers(d.optimizer),
    ...(d.picker ? pickerBridgeHandlers(d.picker) : {}),
    ...(d.auth ? authBridgeHandlers(d.auth) : {}),
  };

  /** Every webview subscription this lane serves. */
  const subscriptions = {
    ...sessionsSubscriptions(sessions),
    ...swarmReviewSubscriptions(review),
    ...receiptSubscriptions(d.optimizer),
    "approvals.subscribe": (_req: Record<string, never>, emit: Parameters<ApprovalsController["subscribe"]>[0]) => approvals.subscribe(emit),
    "tasks.subscribe": (_req: Record<string, never>, emit: Parameters<TasksController["subscribe"]>[0]) => tasks.subscribe(emit),
  };

  /**
   * The same subscriptions in the shape BridgeRouter wants (bridge/types.ts): the router owns ordering, so the handler only
   * replays what is already stored and `live` feeds publish each new event once, whatever the number of subscribers.
   */
  const replays = {
    "agent.subscribe": async (r: { sessionId: string; fromSeq: number }, emit: (e: AgentEvent) => void) => { for (const e of await d.store.agentEvents(r.sessionId, r.fromSeq)) emit(e); },
  };
  const live = {
    "agent.subscribe": (publish: (e: AgentEvent) => void) => sessions.subscribeAll(publish),
    "approvals.subscribe": (publish: (a: ApprovalRequest) => void) => approvals.subscribe(publish),
    "tasks.subscribe": (publish: (t: Task) => void) => tasks.subscribe(publish),
    "swarms.review.subscribe": (publish: (r: SwarmReview) => void) => review.subscribe(publish),
    "receipts.subscribe": (publish: (r: ModelCallReceipt) => void) => d.optimizer.subscribe(publish),
  };

  return { tasks, sessions, approvals, review, decompose, scheduler, optimizer: d.optimizer, host, gate, handlers, subscriptions, replays, live };
}

export type Lane1 = ReturnType<typeof composeLane1>;
