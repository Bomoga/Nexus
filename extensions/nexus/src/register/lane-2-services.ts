// Lane 2's services and bridge handlers, built without vscode so the wiring itself is unit-tested. register/lane-2.ts
// supplies the editor pieces (secrets, settings, the repo root, openExternal) and returns what Lane 1 consumes.
import { decodeCodeRef, type ApprovalRequest, type CodeRef, type DecidedBy, type ErrorCode, type Req } from "../contracts";
import { BridgeError, type BridgeRouter } from "../bridge/types";
import type { Disposable } from "../bridge/types";
import type { ApprovalHook } from "../features/approvals/approvals-controller";
import type { Lane2Services } from "./lane-1-features";
import type { EventStore } from "../services/events/store";
import { createGate } from "../services/gate/gate";
import type { ApprovalsHook } from "../services/gate/types";
import type { GitService } from "../services/git/types";
import { CodeRefError, createCodeRef } from "../services/coderef/create";
import { registerOpenExternal } from "../services/coderef/open-external";
import { registerOpenTarget } from "../services/coderef/open-target";
import { openCodeRef } from "../services/coderef/resolve";
import { createSlackService, type ComposedSlackService, type CreateSlackServiceOptions } from "../services/slack/slack-service";
import { SlackCache } from "../services/slack/cache";
import type { SlackService } from "../services/slack/types";
import { GitWatcher } from "../services/git/watcher";

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
  /** Where the Slack message cache keeps its per-channel files; no cache when omitted. */
  slackCacheDir?: string;
  /** The git watcher's change source (a FileSystemWatcher on .git refs) and this machine's id; no watcher when omitted. */
  watcher?: { watch: (onChange: () => void) => () => void; machineId: string };
  /** vscode.commands.executeCommand, for ui.openTarget (the commit, session and Slack views are Lane 3's commands). Without it ui.openTarget is not served. */
  executeCommand?: (id: string, ...args: unknown[]) => Promise<unknown>;
  /** The editor side of opening a code reference; without it (or without git) coderef.open is not served. */
  codeRefEditor?: CodeRefEditor;
  /** Test seams for the Slack service. */
  slackSeams?: Pick<CreateSlackServiceOptions, "webOptions" | "makeBotApi" | "socketOptions">;
}

/** Opens files for a code reference; all lines are 1-based and inclusive. */
export interface CodeRefEditor {
  /** The working-copy file, with the lines selected. */
  openLive(path: string, startLine: number, endLine: number): Promise<void>;
  /** The file as it was at `commit`, read-only, with the lines selected. */
  openAtCommit(commit: string, path: string, startLine: number, endLine: number): Promise<void>;
  /** After a stale open: offers "Open Current Version", which opens the working-copy file. Must not block. */
  offerCurrent(path: string, startLine: number, endLine: number): void;
}

/** What the code-ref flows report to a caller: a code and a message fit to show the user. */
const CODEREF_BRIDGE_CODE: Record<CodeRefError["code"], ErrorCode> = {
  invalid_path: "invalid_request", invalid_range: "invalid_request", foreign_workspace: "invalid_request", dirty: "conflict", not_found: "not_found",
};
async function asBridgeError<T>(work: Promise<T>): Promise<T> {
  try { return await work; } catch (e) {
    if (e instanceof CodeRefError) throw new BridgeError(CODEREF_BRIDGE_CODE[e.code], e.message);
    throw e;
  }
}

export interface Lane2Built extends Pick<Lane2Services, "approvalHooks"> {
  /** The composed service: start, stop, status and the approval cards. */
  slack: ComposedSlackService;
  /** What Lane 1 and the bridge use: the composed service behind the local message cache. */
  served: SlackService;
  /** Resolves once the git watcher has started (or immediately when there is none). */
  watcherReady: Promise<void>;
  git?: GitService;
  makeGate?: Lane2Services["makeGate"];
  /** Code references, when there is a repository and an editor: the nexus.openCodeRef command and the coderef URI route. */
  codeRefs?: {
    open(ref: CodeRef): Promise<{ opened: "at_commit" | "current"; stale: boolean }>;
    /** Opens a nexus:// code-ref link; false when the text is not one. Throws CodeRefError for a link that cannot be opened. */
    openLink(link: string): Promise<boolean>;
  };
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

  // History is served from the local cache first; live events and the user's own posts keep it current.
  const served: SlackService = i.slackCacheDir ? new SlackCache({ dir: i.slackCacheDir, fetcher: slack }).wrap(slack) : slack;

  const r = i.router;
  parts.push(
    r.handle("slack.status", () => served.status()),
    r.handle("slack.channels", () => served.channels()),
    r.handle("slack.history", (q: Req<"slack.history">) => served.history(q.channelId, q.cursor, q.limit)),
    r.handle("slack.thread", (q: Req<"slack.thread">) => served.getThread(q.channelId, q.threadTs)),
    r.handle("slack.users", (q: Req<"slack.users">) => served.users(q.ids)),
    r.handle("slack.post", (q: Req<"slack.post">) => served.postAsUser({ channelId: q.channelId, text: q.text, threadTs: q.threadTs, clientId: q.clientId })),
    // Live feed: every message and status change is published; the router delivers each to the subscriptions whose channelIds match.
    r.onSubscribe("slack.subscribe", () => undefined),
    served.onMessage(evt => r.publish("slack.subscribe", evt)),

    r.handle("store.status", () => i.store.status()),
    r.onSubscribe("store.subscribe", () => undefined),
    { dispose: i.store.subscribeStatus(s => r.publish("store.subscribe", s)) },
    r.handle("events.query", (q: Req<"events.query">) => i.store.queryEvents(q)),
    r.handle("events.search", (q: Req<"events.search">) => i.store.searchEvents(q.q, q.limit)),
    r.onSubscribe("events.subscribe", () => undefined),
    { dispose: i.store.subscribeEvents(e => r.publish("events.subscribe", e)) },

    registerOpenExternal(r, i.openExternal),
  );
  if (i.executeCommand) parts.push(registerOpenTarget(r, { executeCommand: i.executeCommand }));

  if (i.git) {
    const git = i.git;
    parts.push(
      r.handle("git.commit.show", (q: Req<"git.commit.show">) => git.show(q.sha)),
      r.handle("git.branches", () => git.branches()),
      r.handle("git.mergeAgentBranch", (q: Req<"git.mergeAgentBranch">) => git.mergeAgentBranch(q.sessionId)),
      r.handle("coderef.create", (q: Req<"coderef.create">) => asBridgeError(createCodeRef({ git }, q.path, q.startLine, q.endLine))),
    );
  }

  // Opening a code reference: the live file when HEAD still has those exact lines, otherwise the file at its commit.
  let codeRefs: Lane2Built["codeRefs"];
  if (i.git && i.codeRefEditor) {
    const git = i.git;
    const editor = i.codeRefEditor;
    const open = (ref: CodeRef) => openCodeRef({
      git,
      openLive: (p, s, e) => editor.openLive(p, s, e),
      openAtCommit: (c, p, s, e) => editor.openAtCommit(c, p, s, e),
      offerCurrent: () => editor.offerCurrent(ref.path, ref.startLine, ref.endLine),
    }, ref);
    codeRefs = {
      open,
      openLink: async link => {
        const ref = decodeCodeRef(link);
        if (!ref) return false;
        await open(ref);
        return true;
      },
    };
    parts.push(r.handle("coderef.open", (q: Req<"coderef.open">) => asBridgeError(open(q.ref))));
  }

  // The git watcher turns commits, merges, branches and tags into globe events. Agent attribution needs a session the store knows.
  let watcher: GitWatcher | undefined;
  let watcherReady: Promise<void> = Promise.resolve();
  if (i.git && i.watcher) {
    const git = i.git;
    const w = i.watcher;
    watcherReady = (async () => {
      try {
        watcher = new GitWatcher({
          git, putNexusEvent: e => i.store.putNexusEvent(e), watch: w.watch, workspaceId: await git.workspaceId(), machineId: w.machineId,
          isKnownSession: async id => (await i.store.getSession(id)) !== undefined, logger: { warn: m => i.log(`git watcher: ${m}`) },
        });
        await watcher.start();
      } catch { i.log("git watcher did not start (no commits yet, or not a git repository)"); }
    })();
    parts.push({ dispose: () => watcher?.dispose() });
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
    served,
    watcherReady,
    approvalHooks: [slackApprovalHook],
    ...(i.git ? {
      git: i.git,
      makeGate: (hook: ApprovalsHook) => createGate({ git: i.git!, approvals: hook, allowlist: i.allowlist, redact: i.redact }),
    } : {}),
    ...(codeRefs ? { codeRefs } : {}),
    setApprovalResolver: fn => { resolver = fn; },
    hasBotTokens: async () => !!((await fromSecretOrEnv(SLACK_SECRET_KEYS.bot, "SLACK_BOT_TOKEN")) && (await fromSecretOrEnv(SLACK_SECRET_KEYS.app, "SLACK_APP_TOKEN"))),
    dispose: () => {
      for (const p of parts.reverse()) { try { p.dispose(); } catch { /* best effort */ } }
      void slack.stop().catch(() => undefined);
    },
  };
}
