import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { userInfo } from "node:os";
import * as vscode from "vscode";
import { ProcessHost, forkAgentProcess } from "../agent/process-host";
import { FakeBridgeServer } from "../bridge/fake-bridge-server";
import type { BridgeRouter } from "../bridge/types";
import { OptimizerService } from "../features/accounts/optimizer";
import type { AccountsService } from "../features/accounts/accounts-service";
import { secretKeyFor } from "../features/accounts/accounts-service";
import type { ModelPicker } from "../features/accounts/model-picker";
import { approvalsHookFor } from "../features/adapters/approvals-hook";
import type { ApprovalHook, NotifyPort } from "../features/approvals/approvals-controller";
import { makeConfiguredCibaHook } from "../features/approvals/ciba-wiring";
import type { Auth0Session } from "../features/auth/auth0-signin";
import { lane1Commands } from "../features/commands";
import { composeLane1, type Lane1 } from "../features/compose";
import type { Clock, GatePort, GitPort, StorePort } from "../features/ports";
import { SwarmsClient } from "../features/swarms/swarms-client";
import { wireLane1ToRouter } from "../features/wire-bridge";
import { FakeEventStore } from "../services/events/fake-store";
import type { Gate } from "../services/gate/types";
import { FakeSlack } from "../services/slack/fake-slack";
import type { SlackService } from "../services/slack/types";

/** What Lane 2 supplies. Anything missing falls back as described on `withFallbacks`. */
export interface Lane2Services {
  router: BridgeRouter;
  store: StorePort;
  slack: SlackService;
  git: GitPort;
  /** Builds the agent gate; it asks the given approvals hook for every command, commit and write outside the worktree. */
  makeGate(hook: ReturnType<typeof approvalsHookFor>): Gate;
  /** Further surfaces told about every approval, such as the Slack approval message. */
  approvalHooks: ApprovalHook[];
}

const unavailable = (what: string) => new Error(`${what} is not available in this build yet (Lane 2 has not delivered it).`);

/**
 * Real pieces where Lane 2 provided them. Otherwise: in-memory stand-ins for data (router, store, Slack), and refusals for
 * anything that touches files or runs commands (git, gate), so an agent can never run without the real gate.
 */
export function withFallbacks(given: Partial<Lane2Services> = {}, log: (m: string) => void = () => {}): Lane2Services {
  const missing: string[] = [];
  const pick = <K extends keyof Lane2Services>(key: K, make: () => Lane2Services[K]): Lane2Services[K] => {
    const value = given[key];
    if (value !== undefined) return value;
    missing.push(key);
    return make();
  };
  const services: Lane2Services = {
    router: pick("router", () => new FakeBridgeServer()),
    store: pick("store", () => new FakeEventStore()),
    slack: pick("slack", () => new FakeSlack()),
    git: pick("git", () => ({ createSessionWorktree: async () => { throw unavailable("The git service"); } })),
    makeGate: pick("makeGate", () => () => ({ request: async () => { throw unavailable("The agent gate"); } })),
    approvalHooks: given.approvalHooks ?? [],
  };
  if (missing.length > 0) log(`using stand-ins for Lane 2: ${missing.join(", ")}`);
  return services;
}

function vscodeNotify(): NotifyPort {
  return {
    // An approval needs a human click: dismissing the notification leaves it pending, there is no timeout.
    show: (_approval, text, onChoice) => {
      void vscode.window.showWarningMessage(text, "APPROVE", "REJECT").then(choice => {
        if (choice === "APPROVE") onChoice("approved");
        else if (choice === "REJECT") onChoice("rejected");
      });
    },
    update: (_approvalId, text) => { vscode.window.setStatusBarMessage(text, 8000); },
  };
}

/** Constructs Lane 1's features on the given services, serves them on the router, and registers their palette commands. */
export function registerFeatures(context: vscode.ExtensionContext, accounts: AccountsService, picker: ModelPicker, auth: Auth0Session, l2: Lane2Services): Lane1 {
  const log = (m: string) => console.warn(`Nexus: ${m}`);
  const clock: Clock = { now: () => new Date().toISOString(), newId: prefix => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}` };
  const identity = () => {
    const st = auth.status();
    const os = userInfo().username;
    return { userId: st.auth0UserId ?? os, name: st.name ?? os, ...(st.auth0UserId ? { auth0UserId: st.auth0UserId } : {}) };
  };
  const optimizer = new OptimizerService({ state: context.globalState, store: l2.store, getPruneKey: () => Promise.resolve(context.secrets.get(secretKeyFor("prune"))) });
  const entry = join(context.extensionPath, "out", "agent-process", "main.js");

  // Phone approval (CIBA): inert unless nexus.ciba.serviceUrl is set and the user is signed in. The controller exists only after composeLane1, so it is reached lazily.
  const ref: { lane?: Lane1 } = {};
  const cibaHook = makeConfiguredCibaHook({
    serviceUrl: () => vscode.workspace.getConfiguration("nexus.ciba").get<string>("serviceUrl", ""),
    auth,
    getController: () => {
      if (!ref.lane) throw new Error("approvals are not ready yet");
      return ref.lane.approvals;
    },
    log,
  });

  const lane = composeLane1({
    store: l2.store, git: l2.git, slack: l2.slack, clock, machineId: vscode.env.machineId,
    makeGate: approvals => l2.makeGate(approvalsHookFor(approvals)) as GatePort,
    createHost: cb => new ProcessHost({
      spawn: forkAgentProcess(entry), handlers: cb.handlers,
      onSessionFinished: cb.onSessionFinished, onSessionError: (id, message) => cb.onSessionError(id, message),
      log: (level, message) => { if (level !== "debug") log(`agent process: ${message}`); },
    }),
    accounts, optimizer, notify: vscodeNotify(),
    swarms: new SwarmsClient(), getSwarmsKey: () => accounts.getKey("swarms"),
    identity,
    workspaceId: () => `ws_${(vscode.workspace.workspaceFolders?.[0]?.name ?? "default").toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    agentModel: () => picker.selected("agent"),
    auth, extraApprovalHooks: [...l2.approvalHooks, cibaHook], log,
  });

  ref.lane = lane;

  const ui = {
    info: (m: string) => void vscode.window.showInformationMessage(m),
    error: (m: string) => void vscode.window.showErrorMessage(m),
    pickApproval: async (items: Array<{ id: string; label: string; detail: string }>) => (await vscode.window.showQuickPick(items, { placeHolder: "Which approval?" }))?.id,
  };
  const commands = lane1Commands(lane, ui, () => identity().userId);
  context.subscriptions.push(
    wireLane1ToRouter(lane, l2.router),
    { dispose: () => lane.host.dispose?.() },
    ...Object.entries(commands).map(([id, fn]) => vscode.commands.registerCommand(id, (...args: string[]) => (fn as (...a: string[]) => unknown)(...args))),
  );
  return lane;
}
