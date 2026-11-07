import { join } from "node:path";
import * as vscode from "vscode";
import { NexusBridgeRouter } from "../bridge/router";
import { registerAppPing } from "../bridge/host";
import { handleAuthUri } from "../features/auth/current";
import { redact } from "../shared/redact";
import { checkRelativePath, CodeRefError } from "../services/coderef/create";
import { plainNotificationText } from "../services/coderef/notify-text";
import { UriRouter } from "../services/coderef/uri-handler";
import { LocalStore } from "../services/events/local-store";
import { GitCli } from "../services/git/git-cli";
import type { Lane2Services } from "./lane-1-features";
import { CodeRef, decodeCodeRef, Sha } from "../contracts";
import type { GitService } from "../services/git/types";
import { buildLane2, SLACK_SECRET_KEYS, type CodeRefEditor, type Lane2Built } from "./lane-2-services";

/** Read-only documents of a file at a commit: nexus-git:/<path>?<full sha>. */
const AT_COMMIT_SCHEME = "nexus-git";

// Lane 2 wiring: the shared bridge router, the local event store, the nexus:// URI handler, and (lane-2-services.ts) the Slack
// service, the git service, the gate and Lane 2's bridge handlers. Lane 1 receives them through extension.ts.
// Not wired yet: the Tiger store (L2-10) and Token Vault (L2-15).
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

  const gitService = folder ? new GitCli(folder.uri.fsPath, { sessionsDir: join(context.globalStorageUri.fsPath, "sessions", workspaceSlug) }) : undefined;
  const codeRefEditor = folder && gitService ? makeCodeRefEditor(context, folder, gitService) : undefined;

  const lane2 = buildLane2({
    router, store, redact,
    secret: key => Promise.resolve(context.secrets.get(key)),
    env: process.env,
    // The first workspace folder is the repo; GitCli refuses clearly if it is not one. No folder: no git, so Lane 1 keeps its refusal.
    ...(gitService ? { git: gitService } : {}),
    ...(codeRefEditor ? { codeRefEditor } : {}),
    executeCommand: (id, ...args) => Promise.resolve(vscode.commands.executeCommand(id, ...args)),
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
    router, store,
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
