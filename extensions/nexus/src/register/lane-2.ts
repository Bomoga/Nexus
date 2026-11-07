import { join } from "node:path";
import * as vscode from "vscode";
import { NexusBridgeRouter } from "../bridge/router";
import { registerAppPing } from "../bridge/host";
import { handleAuthUri } from "../features/auth/current";
import { redact } from "../shared/redact";
import { UriRouter } from "../services/coderef/uri-handler";
import { LocalStore } from "../services/events/local-store";
import { GitCli } from "../services/git/git-cli";
import type { Lane2Services } from "./lane-1-features";
import { buildLane2, SLACK_SECRET_KEYS, type Lane2Built } from "./lane-2-services";

// Lane 2 wiring: the shared bridge router, the local event store, the nexus:// URI handler, and (lane-2-services.ts) the Slack
// service, the git service, the gate and Lane 2's bridge handlers. Lane 1 receives them through extension.ts.
// Not wired yet: the git write half (L2-06), the Tiger store (L2-10), the Slack cache (L2-04), code refs (L2-14) and
// ui.openTarget (L2-16). Until L2-06, session worktrees and commits fail with a clear "not implemented" error.
export type Lane2Wiring = Pick<Lane2Services, "router" | "store" | "slack" | "approvalHooks"> & Partial<Pick<Lane2Services, "git" | "makeGate">> & {
  router: NexusBridgeRouter;
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
  const store = new LocalStore({ dir: join(context.globalStorageUri.fsPath, "workspaces", workspaceSlug), redact });
  if (store.skippedLines() > 0) log(`local store skipped ${store.skippedLines()} unreadable line(s) on open`);

  // One handler for every nexus:// link. Core only delivers nexus://nexus.nexus/<route>; UriRouter normalizes it.
  const uris = new UriRouter();
  context.subscriptions.push(
    uris.registerRoute("auth", uri => handleAuthUri(uri)),
    vscode.window.registerUriHandler({ handleUri: uri => { void uris.handle(uri); } }),
  );

  registerAppPing(router, context);

  const lane2 = buildLane2({
    router, store, redact,
    secret: key => Promise.resolve(context.secrets.get(key)),
    env: process.env,
    // The first workspace folder is the repo; GitCli refuses clearly if it is not one. No folder: no git, so Lane 1 keeps its refusal.
    ...(folder ? { git: new GitCli(folder.uri.fsPath, { sessionsDir: join(context.globalStorageUri.fsPath, "sessions", workspaceSlug) }) } : {}),
    slackCacheDir: join(context.globalStorageUri.fsPath, "slack"),
    ...(folder ? {
      watcher: {
        machineId: vscode.env.machineId,
        watch: (onChange: () => void) => {
          const fsw = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, ".git/{HEAD,packed-refs,refs/**}"));
          const subs = [fsw.onDidChange(onChange), fsw.onDidCreate(onChange), fsw.onDidDelete(onChange)];
          return () => { for (const s of subs) s.dispose(); fsw.dispose(); };
        },
      },
    } : {}),
    allowlist: () => vscode.workspace.getConfiguration("nexus").get<string[]>("agent.allowedCommands") ?? [],
    openExternal: url => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url, true))),
    log: m => log(m),
  });
  context.subscriptions.push(lane2);

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
      void vscode.window.showInformationMessage(s.postsAs ? `Nexus: Slack connected; you post as ${s.postsAs.name}.` : "Nexus: Slack tokens saved, but the user token could not be verified.");
    }),
    vscode.commands.registerCommand("nexus.showIdentity", async () => {
      const s = await lane2.slack.status();
      void vscode.window.showInformationMessage(s.postsAs
        ? `Nexus posts what you type as ${s.postsAs.name} (${s.userTokenSource} token). Live events: ${s.connected ? "connected" : "not connected"}.`
        : "Nexus has no verified Slack user token: run Nexus: Connect Slack.");
    }),
  );
  void startSlack().catch(() => log("Slack start failed"));

  return {
    router, store,
    slack: lane2.served,
    approvalHooks: lane2.approvalHooks,
    ...(lane2.git ? { git: lane2.git } : {}),
    ...(lane2.makeGate ? { makeGate: lane2.makeGate } : {}),
    setSlackApprovalResolver: lane2.setApprovalResolver,
  };
}
