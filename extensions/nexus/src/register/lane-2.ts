import { randomUUID } from "node:crypto";
import { join } from "node:path";
import * as vscode from "vscode";
import { NexusBridgeRouter } from "../bridge/router";
import { registerAppPing } from "../bridge/host";
import { handleAuthUri } from "../features/auth/current";
import { redact } from "../shared/redact";
import { checkRelativePath, CodeRefError } from "../services/coderef/create";
import { plainNotificationText } from "../shared/plain-text";
import { UriRouter } from "../services/coderef/uri-handler";
import { LocalStore } from "../services/events/local-store";
import { GitCli } from "../services/git/git-cli";
import type { Lane2Services } from "./lane-1-features";
import { CodeRef, decodeCodeRef, Sha } from "../contracts";
import type { GitService } from "../services/git/types";
import type { EventStore } from "../services/events/store";
import { createTokenVault } from "../services/slack/token-vault";
import { REFRESH_SECRET_KEY } from "../features/auth/auth0-signin";
import { createSharedStore } from "./shared-store";
import type { TigerClient } from "../services/events/tiger-store";

/** SecretStorage key for the Tiger Cloud connection string; TIGER_URL in the environment works too. (A "Connect Tiger Cloud" command needs a contracts change first.) */
const TIGER_SECRET_KEY = "nexus.tiger.url";
import { buildLane2, SLACK_SECRET_KEYS, userAllowlist, type CodeRefEditor, type Lane2Built } from "./lane-2-services";

/** Read-only documents of a file at a commit: nexus-git:/<path>?<full sha>. */
const AT_COMMIT_SCHEME = "nexus-git";

// Lane 2 wiring: the shared bridge router, the event store (the local copy, behind Tiger Cloud and live sync once a connection
// string is set), the nexus:// URI handler, and (lane-2-services.ts) the Slack service with Token Vault, the git service, the gate,
// the Slack progress message and Lane 2's bridge handlers. Lane 1 receives them through extension.ts.
export type Lane2Wiring = Pick<Lane2Services, "router" | "store" | "slack" | "approvalHooks"> & Partial<Pick<Lane2Services, "git" | "makeGate">> & {
  router: NexusBridgeRouter;
  /** This install's id (the one app.ping reports). Sessions must carry it as machineId: it decides which machine owns an agent's approvals. */
  machineId: string;
  /** The session's Slack progress message (Lane 1's ProgressPort), when there is a repository. */
  progress?: Lane2Built["progress"];
  /** Lane 1 binds its approvals controller here, so an APPROVE click in Slack wakes the waiting agent like any other decision. */
  setSlackApprovalResolver: Lane2Built["setApprovalResolver"];
};

export function registerLane2(context: vscode.ExtensionContext): Lane2Wiring {
  const log = (message: string, detail?: unknown) => console.warn(`Nexus bridge: ${message}`, detail ?? "");

  const router = new NexusBridgeRouter({
    // A body or error that still changes under redaction contains a secret pattern, so it is never posted.
    containsSecret: value => {
      try {
        const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
        return redact(text) !== text;
      } catch {
        return true;
      }
    },
    log,
  });

  const folder = vscode.workspace.workspaceFolders?.[0];
  const workspaceSlug = (folder?.name ?? "default").toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const local = new LocalStore({ dir: join(context.globalStorageUri.fsPath, "workspaces", workspaceSlug), redact });
  if (local.skippedLines() > 0) log(`local store skipped ${local.skippedLines()} unreadable line(s) on open`);

  // One id per install, shared with app.ping; vscode.env.machineId is a placeholder whenever telemetry is off.
  let machineId = context.globalState.get<string>("nexus.machineId");
  if (!machineId) { machineId = randomUUID(); void context.globalState.update("nexus.machineId", machineId); }

  // The git service and the workspace id (sha1 of the repo's root commit, the same on every machine) come first: the shared store
  // and the activity strip are limited to this repo. Memoized once it is known; unknown (no folder, no commits) is retried next time.
  const gitService = folder ? new GitCli(folder.uri.fsPath, { sessionsDir: join(context.globalStorageUri.fsPath, "sessions", workspaceSlug) }) : undefined;
  let workspaceIdPromise: Promise<string | undefined> | undefined;
  const rootWorkspaceId = (): Promise<string | undefined> => {
    if (!gitService) return Promise.resolve(undefined);
    workspaceIdPromise ??= gitService.workspaceId().then(id => id || undefined, () => undefined).then(id => { if (!id) workspaceIdPromise = undefined; return id; });
    return workspaceIdPromise;
  };
  // Lane 1 still names its tasks' (and so its agent and Slack events') workspace `ws_<folder slug>`; both ids belong to this repo.
  const workspaceIds = async (): Promise<string[]> => {
    if (!folder) return [];
    return [...new Set([await rootWorkspaceId(), `ws_${workspaceSlug}`].filter((id): id is string => !!id))];
  };
  // The shared store's client once it exists; before that (or without TIGER_URL) the query throws, so the strip counts the local copy.
  let sharedClient: TigerClient | undefined;
  const activityQuery = {
    query: (text: string, params: unknown[]) => {
      if (!sharedClient) return Promise.reject(new Error("shared store not connected"));
      return sharedClient.query(text, params);
    },
  };

  // The store everyone uses: the local copy now, the shared store (Tiger Cloud) once its connection string has been read.
  // Subscriptions are the local copy's in both cases, so ones made before the switch keep working.
  let current: EventStore = local;
  const store = new Proxy(local as EventStore, {
    get: (_target, key) => { const value = Reflect.get(current, key) as unknown; return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(current) : value; },
  });
  void (async () => {
    const url = (await context.secrets.get(TIGER_SECRET_KEY)) || process.env.TIGER_URL;
    if (!url) return;
    try {
      const shared = createSharedStore({
        connectionString: url, local, machineId: machineId!, redact, workspaceIds, log: m => log(`shared store: ${m}`),
        notify: m => { void vscode.window.showWarningMessage(plainNotificationText(m)); },
      });
      current = shared.store;
      sharedClient = shared.client;
      context.subscriptions.push({ dispose: () => { void shared.dispose(); } });
      await shared.sync.start();
    } catch (e) {
      log(`shared store not started: ${e instanceof Error ? e.message : "unknown error"}`);   // these messages never contain the URL
    }
  })();

  // One handler for every nexus:// link. Core only delivers nexus://nexus.nexus/<route>; UriRouter normalizes it.
  const uris = new UriRouter();
  context.subscriptions.push(
    uris.registerRoute("auth", uri => handleAuthUri(uri)),
    vscode.window.registerUriHandler({ handleUri: uri => { void uris.handle(uri); } }),
  );

  registerAppPing(router, context);

  const codeRefEditor = folder && gitService ? makeCodeRefEditor(context, folder, gitService) : undefined;

  // Each person's Slack token from Auth0 Token Vault. Only user settings count: a repository's workspace settings could
  // otherwise point the refresh token at another host.
  const userSetting = <T>(key: string): T | undefined => {
    const i = vscode.workspace.getConfiguration("nexus").inspect<T>(key);
    return i?.globalValue ?? i?.defaultValue;
  };
  const tokenVault = createTokenVault({
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(3000) }),   // a stalled Auth0 call never holds Slack
    config: () => {
      const domain = userSetting<string>("auth0.domain"), clientId = userSetting<string>("auth0.clientId"), slackConnection = userSetting<string>("slack.auth0Connection");
      return domain && clientId && slackConnection ? { domain: domain.trim().toLowerCase(), clientId, slackConnection } : undefined;
    },
    getRefreshToken: async () => (await context.secrets.get(REFRESH_SECRET_KEY)) || undefined,
    clock: () => Date.now(),
  });

  const lane2 = buildLane2({
    router, store, redact, tokenVault, activityQuery, workspaceIds,
    readSessionLocally: id => local.getSession(id),
    secret: key => Promise.resolve(context.secrets.get(key)),
    env: process.env,
    // The first workspace folder is the repo; GitCli refuses clearly if it is not one. No folder: no git, so Lane 1 keeps its refusal.
    ...(gitService ? { git: gitService } : {}),
    ...(codeRefEditor ? { codeRefEditor } : {}),
    executeCommand: (id, ...args) => Promise.resolve(vscode.commands.executeCommand(id, ...args)),
    slackCacheDir: join(context.globalStorageUri.fsPath, "slack"),
    ...(folder ? {
      watcher: {
        machineId,
        watch: (onChange: () => void) => {
          const fsw = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, ".git/{HEAD,packed-refs,refs/**}"));
          const subs = [fsw.onDidChange(onChange), fsw.onDidCreate(onChange), fsw.onDidDelete(onChange)];
          return () => { for (const s of subs) s.dispose(); fsw.dispose(); };
        },
      },
    } : {}),
    // Only the user's own settings count: a cloned repository's .vscode/settings.json must never let an agent skip approvals.
    allowlist: () => userAllowlist(vscode.workspace.getConfiguration("nexus").inspect<unknown>("agent.allowedCommands")?.globalValue),
    openExternal: url => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url, true))),
    log: m => log(m),
  });
  context.subscriptions.push(lane2);
  // Signing in (or out) of Auth0 changes the refresh token: ask Token Vault again right away.
  context.subscriptions.push(context.secrets.onDidChange(e => { if (e.key === REFRESH_SECRET_KEY) lane2.authChanged(); }));

  // Code references: nexus:// links from Slack or anywhere else, and the command. A link that cannot be opened says why.
  const showCodeRefFailure = (e: unknown) => {
    void vscode.window.showErrorMessage(e instanceof CodeRefError ? `Nexus: ${plainNotificationText(e.message)}` : "Nexus: could not open that code reference.");
    if (!(e instanceof CodeRefError)) log("code reference open failed", e instanceof Error ? e.name : undefined);
  };
  context.subscriptions.push(
    uris.registerRoute("coderef", async link => {
      if (!lane2.codeRefs) {
        void vscode.window.showErrorMessage("Nexus: open a git repository to follow code references.");
        return true;
      }
      try { return await lane2.codeRefs.openLink(link); } catch (e) { showCodeRefFailure(e); return true; }
    }),
    vscode.commands.registerCommand("nexus.openCodeRef", async (arg?: unknown) => {
      if (!lane2.codeRefs) {
        void vscode.window.showErrorMessage("Nexus: open a git repository to follow code references.");
        return;
      }
      // A CodeRef object (from a chip or another command) or a nexus:// link; with no argument, ask for the link.
      let ref = typeof arg === "string" ? decodeCodeRef(arg) : CodeRef.safeParse(arg).data ?? null;
      if (arg === undefined) {
        const typed = await vscode.window.showInputBox({ prompt: "A nexus:// code reference link", ignoreFocusOut: true });
        if (!typed) return;
        ref = decodeCodeRef(typed.trim());
      }
      if (!ref) {
        void vscode.window.showErrorMessage("Nexus: that is not a code reference link.");
        return;
      }
      try { await lane2.codeRefs.open(ref); } catch (e) { showCodeRefFailure(e); }
    }),
  );

  const startSlack = async () => {
    if (await lane2.hasBotTokens()) {
      if (!(await lane2.slack.start())) log("Slack Socket Mode did not connect yet; it keeps retrying in the background");
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("nexus.connectSlack", async () => {
      // Manual fallback until Token Vault (L2-15): tokens go to SecretStorage only, never settings or logs.
      const ask = (prompt: string, prefix: string) => vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true, validateInput: v => (v.startsWith(prefix) ? undefined : `Starts with ${prefix}`) });
      const user = await ask("Your Slack user token (xoxp-), so what you type posts as you", "xoxp-");
      if (!user) return;
      const bot = await ask("The Nexus app's bot token (xoxb-)", "xoxb-");
      if (!bot) return;
      const app = await ask("The Nexus app's app-level token (xapp-), for live events", "xapp-");
      if (!app) return;
      await context.secrets.store(SLACK_SECRET_KEYS.user, user);
      await context.secrets.store(SLACK_SECRET_KEYS.bot, bot);
      await context.secrets.store(SLACK_SECRET_KEYS.app, app);
      await lane2.slack.stop();
      await startSlack();
      const s = await lane2.slack.status();
      void vscode.window.showInformationMessage(s.postsAs ? `Nexus: Slack connected; you post as ${plainNotificationText(s.postsAs.name)}.` : "Nexus: Slack tokens saved, but the user token could not be verified.");
    }),
    vscode.commands.registerCommand("nexus.showIdentity", async () => {
      const s = await lane2.slack.status();
      void vscode.window.showInformationMessage(s.postsAs
        ? `Nexus posts what you type as ${plainNotificationText(s.postsAs.name)} (${s.userTokenSource} token). Live events: ${s.connected ? "connected" : "not connected"}.`
        : "Nexus has no verified Slack user token: run Nexus: Connect Slack.");
    }),
  );
  void startSlack().catch(() => log("Slack start failed"));

  return {
    router, store: lane2.observedStore, machineId,
    ...(lane2.progress ? { progress: lane2.progress } : {}),
    slack: lane2.served,
    approvalHooks: lane2.approvalHooks,
    ...(lane2.git ? { git: lane2.git } : {}),
    ...(lane2.makeGate ? { makeGate: lane2.makeGate } : {}),
    setSlackApprovalResolver: lane2.setApprovalResolver,
  };
}

/** The editor side of code references: the live file, a read-only copy at a commit, and "Open Current Version". */
function makeCodeRefEditor(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder, git: GitService): CodeRefEditor {
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(AT_COMMIT_SCHEME, {
    provideTextDocumentContent: async uri => {
      // Only ever built by openAtCommit below, but checked again: a document URI can come from anywhere.
      const commit = Sha.safeParse(uri.query);
      const path = uri.path.replace(/^\//, "");
      try { checkRelativePath(path); } catch { return undefined; }
      if (!commit.success) return undefined;
      return git.fileAt(commit.data, path);
    },
  }));
  const show = async (uri: vscode.Uri, startLine: number, endLine: number) => {
    const doc = await vscode.workspace.openTextDocument(uri);
    const last = Math.min(endLine, doc.lineCount) - 1;
    const selection = new vscode.Range(startLine - 1, 0, last, doc.lineAt(Math.max(last, 0)).range.end.character);
    await vscode.window.showTextDocument(doc, { selection, preview: true });
  };
  const openLive = (path: string, startLine: number, endLine: number) => show(vscode.Uri.joinPath(folder.uri, path), startLine, endLine);
  return {
    openLive,
    openAtCommit: (commit, path, startLine, endLine) => show(vscode.Uri.from({ scheme: AT_COMMIT_SCHEME, path: `/${path}`, query: commit }), startLine, endLine),
    offerCurrent: (path, startLine, endLine) => {
      void (async () => {
        const choice = await vscode.window.showInformationMessage(`Nexus: showing ${plainNotificationText(path)} as it was when it was shared; it has changed since.`, "Open Current Version");
        if (choice === "Open Current Version") {
          try { await openLive(path, startLine, endLine); } catch { void vscode.window.showErrorMessage(`Nexus: ${plainNotificationText(path)} is not in the working copy.`); }
        }
      })();
    },
  };
}
