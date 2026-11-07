// Lane 2's services and bridge handlers, built without vscode so the wiring itself is unit-tested. register/lane-2.ts
// supplies the editor pieces (secrets, settings, the repo root, openExternal) and returns what Lane 1 consumes.
import type { ApprovalRequest, DecidedBy, Req } from "../contracts";
import type { BridgeRouter } from "../bridge/types";
import type { Disposable } from "../bridge/types";
import type { ApprovalHook } from "../features/approvals/approvals-controller";
import type { Lane2Services } from "./lane-1-features";
import type { EventStore } from "../services/events/store";
import { createGate } from "../services/gate/gate";
import type { ApprovalsHook } from "../services/gate/types";
import type { GitService } from "../services/git/types";
import { registerOpenExternal } from "../services/coderef/open-external";
import { createSlackService, type ComposedSlackService, type CreateSlackServiceOptions } from "../services/slack/slack-service";

/** SecretStorage keys for the manual Slack connection (Token Vault, L2-15, replaces the user token later). */
export const SLACK_SECRET_KEYS = { user: "nexus.slack.userToken", bot: "nexus.slack.botToken", app: "nexus.slack.appToken" } as const;

/** Lane 1's approvals.resolve, bound after Lane 1 is built: a Slack click must go through it so the waiting agent wakes. */
export type SlackApprovalResolver = (approvalId: string, decision: "approved" | "rejected", decidedBy: DecidedBy) => Promise<{ won: boolean; approval: ApprovalRequest }>;

export interface Lane2Inputs {
  router: BridgeRouter;
  store: EventStore;
  redact: (text: string) => string;
  /** SecretStorage.get. */
  secret: (key: string) => Promise<string | undefined>;
  /** Development fallback for tokens (SLACK_USER_TOKEN, SLACK_BOT_TOKEN, SLACK_APP_TOKEN). Never logged. */
  env: Record<string, string | undefined>;
  /** The user's repository, or undefined when no folder is a git repo: then git and the gate are not provided. */
  git?: GitService;
  /** nexus.agent.allowedCommands, read on every request. */
  allowlist: () => string[];
  /** vscode.env.openExternal, which applies VS Code's own link protection. */
  openExternal: (url: string) => Promise<boolean>;
  log: (message: string) => void;
  /** Test seams for the Slack service. */
  slackSeams?: Pick<CreateSlackServiceOptions, "webOptions" | "makeBotApi" | "socketOptions">;
}

export interface Lane2Built extends Pick<Lane2Services, "slack" | "approvalHooks"> {
  slack: ComposedSlackService;
  git?: GitService;
  makeGate?: Lane2Services["makeGate"];
  /** Lane 1 calls this with its approvals controller's resolve once it exists. Until then a Slack click is refused. */
  setApprovalResolver(resolve: SlackApprovalResolver): void;
  /** True when a bot and app token are configured, so Socket Mode can start. */
  hasBotTokens(): Promise<boolean>;
  dispose(): void;
}

export function buildLane2(i: Lane2Inputs): Lane2Built {
  const parts: Disposable[] = [];
  const fromSecretOrEnv = async (key: string, envName: string) => (await i.secret(key)) || i.env[envName] || undefined;

  let resolver: SlackApprovalResolver | undefined;
  const slack = createSlackService({
    getUserToken: async () => {
      const token = await fromSecretOrEnv(SLACK_SECRET_KEYS.user, "SLACK_USER_TOKEN");
      return token ? { token, source: "manual" } : null;
    },
    getBotTokens: async () => {
      const [botToken, appToken] = await Promise.all([fromSecretOrEnv(SLACK_SECRET_KEYS.bot, "SLACK_BOT_TOKEN"), fromSecretOrEnv(SLACK_SECRET_KEYS.app, "SLACK_APP_TOKEN")]);
      return botToken && appToken ? { botToken, appToken } : null;
    },
    resolve: async (id, decision, by) => {
      if (!resolver) throw new Error("approvals are not wired to Slack yet");
      return resolver(id, decision, by);
    },
    getApproval: id => i.store.getApproval(id),
    ...i.slackSeams,
  });

  const r = i.router;
  parts.push(
    r.handle("slack.status", () => slack.status()),
    r.handle("slack.channels", () => slack.channels()),
    r.handle("slack.history", (q: Req<"slack.history">) => slack.history(q.channelId, q.cursor, q.limit)),
    r.handle("slack.thread", (q: Req<"slack.thread">) => slack.getThread(q.channelId, q.threadTs)),
    r.handle("slack.users", (q: Req<"slack.users">) => slack.users(q.ids)),
    r.handle("slack.post", (q: Req<"slack.post">) => slack.postAsUser({ channelId: q.channelId, text: q.text, threadTs: q.threadTs, clientId: q.clientId })),
    // Live feed: every message and status change is published; the router delivers each to the subscriptions whose channelIds match.
    r.onSubscribe("slack.subscribe", () => undefined),
    slack.onMessage(evt => r.publish("slack.subscribe", evt)),

    r.handle("store.status", () => i.store.status()),
    r.onSubscribe("store.subscribe", () => undefined),
    { dispose: i.store.subscribeStatus(s => r.publish("store.subscribe", s)) },
    r.handle("events.query", (q: Req<"events.query">) => i.store.queryEvents(q)),
    r.handle("events.search", (q: Req<"events.search">) => i.store.searchEvents(q.q, q.limit)),
    r.onSubscribe("events.subscribe", () => undefined),
    { dispose: i.store.subscribeEvents(e => r.publish("events.subscribe", e)) },

    registerOpenExternal(r, i.openExternal),
  );

  if (i.git) {
    const git = i.git;
    parts.push(
      r.handle("git.commit.show", (q: Req<"git.commit.show">) => git.show(q.sha)),
      r.handle("git.branches", () => git.branches()),
    );
  }

  // The Slack approval card: posted in the task's own thread, its ts stored on the approval (a click is accepted only on
  // that card), and re-rendered without buttons once the approval is decided on any surface.
  const slackApprovalHook: ApprovalHook = {
    name: "slack",
    onCreated: async approval => {
      const session = await i.store.getSession(approval.sessionId);
      const task = session ? await i.store.getTask(session.taskId) : undefined;
      if (task?.source.kind !== "thread") return;   // only tasks that came from a thread have a Slack home
      const review = await i.store.getReviewForApproval(approval.id);
      const posted = await slack.postApproval(task.source.channelId, approval, review, task.source.threadTs);
      const latest = (await i.store.getApproval(approval.id)) ?? approval;
      await i.store.putApproval({ ...latest, slackMessage: { channelId: posted.channelId, ts: posted.ts } });
    },
  };
  parts.push({
    dispose: i.store.subscribeApprovals(a => {
      if (!a.decision || !a.slackMessage) return;
      void (async () => {
        try { await slack.refreshApproval(a, await i.store.getReviewForApproval(a.id)); }
        catch { i.log("could not refresh a decided Slack approval card"); }
      })();
    }),
  });

  return {
    slack,
    approvalHooks: [slackApprovalHook],
    ...(i.git ? {
      git: i.git,
      makeGate: (hook: ApprovalsHook) => createGate({ git: i.git!, approvals: hook, allowlist: i.allowlist, redact: i.redact }),
    } : {}),
    setApprovalResolver: fn => { resolver = fn; },
    hasBotTokens: async () => !!((await fromSecretOrEnv(SLACK_SECRET_KEYS.bot, "SLACK_BOT_TOKEN")) && (await fromSecretOrEnv(SLACK_SECRET_KEYS.app, "SLACK_APP_TOKEN"))),
    dispose: () => {
      for (const p of parts.reverse()) { try { p.dispose(); } catch { /* best effort */ } }
      void slack.stop().catch(() => undefined);
    },
  };
}
