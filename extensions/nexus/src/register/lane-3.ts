import * as vscode from "vscode";
import { createWebviewHost } from "../bridge/host";
import { NexusBridgeRouter } from "../bridge/router";
import { Lane3Views } from "../features/views/lane3-views";
import { createLoopbackClient } from "../features/gitviews/loopback";
import { mergeAgentBranch } from "../features/gitviews/merge-agent-branch";
import { openCommit } from "../features/gitviews/open-commit";
import type { DiffSide } from "../features/gitviews/open-commit";
import { openReceipt } from "../features/receipts/open-receipt";
import type { ReceiptSource } from "../features/receipts/open-receipt";

// Lane 3 wiring: webview views and panels, and the commands that open them.
// The router must be the one every lane serves its handlers on; until extension.ts passes it in, a local router is
// used so the views at least render (their requests then fail with "not_found").

/** Minimal secret check for the stand-in router only; the shared router gets the real redaction from its owner. */
const SECRET_PATTERN = /(sk-ant-|sk-[A-Za-z0-9]{20,}|xox[abpr]-|xapp-|AIza[0-9A-Za-z_-]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY)/;

function standInRouter(): NexusBridgeRouter {
  return new NexusBridgeRouter({
    containsSecret: (v) => {
      try {
        return SECRET_PATTERN.test(typeof v === "string" ? v : JSON.stringify(v) ?? "");
      } catch {
        return true;
      }
    },
    log: (m) => console.warn(`Nexus (lane 3 stand-in router): ${m}`),
  });
}

/** What Lane 1 can hand Lane 3 from extension.ts (its OptimizerService serves openReceipt). */
export interface Lane3FromLane1 {
  receipts?: ReceiptSource;
}

export function registerLane3(context: vscode.ExtensionContext, router?: NexusBridgeRouter, lane1: Lane3FromLane1 = {}): Lane3Views {
  const shared = router ?? standInRouter();
  if (!router) console.warn("Nexus: lane 3 views are on a stand-in router; pass the shared router from extension.ts.");
  const views = new Lane3Views({
    makeHost: (viewId, entry) => createWebviewHost(context, viewId, entry, shared),
    registerCommand: (id, fn) => vscode.commands.registerCommand(id, fn),
    executeCommand: (id) => vscode.commands.executeCommand(id),
    showError: (m) => void vscode.window.showErrorMessage(m),
  }).register();
  context.subscriptions.push(views);
  registerGitViews(context, shared);
  context.subscriptions.push(
    vscode.commands.registerCommand("nexus.openReceipt", (receiptId?: unknown, sessionId?: unknown) =>
      openReceipt(
        {
          receipts: lane1.receipts,
          askReceiptId: async () => vscode.window.showInputBox({ prompt: "Prune receipt id", placeHolder: "the receipt signature from the session view" }),
          copy: (text) => Promise.resolve(vscode.env.clipboard.writeText(text)),
          openExternal: (url) => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url, true))),
          info: (m) => void vscode.window.showInformationMessage(m),
          error: (m) => void vscode.window.showErrorMessage(m),
        },
        receiptId,
        sessionId,
      ),
    ),
  );
  return views;
}

/** The slice of the built-in git extension's API (extensions/git/src/api/git.d.ts) used for diff URIs. */
interface GitRepo { getCommit(ref: string): Promise<{ hash: string }> }
interface GitApi {
  readonly state: "uninitialized" | "initialized";
  onDidChangeState(listener: (state: "uninitialized" | "initialized") => void): vscode.Disposable;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
  getRepository(uri: vscode.Uri): GitRepo | null;
  openRepository(root: vscode.Uri): Promise<GitRepo | null>;
}

/** Right after startup the git extension may not have scanned the folder yet: wait for it (up to 5 s), then open it if needed. */
async function repositoryFor(git: GitApi, folder: vscode.Uri): Promise<GitRepo | null> {
  if (git.state !== "initialized") {
    await new Promise<void>((resolve) => {
      const done = (): void => { clearTimeout(timer); sub.dispose(); resolve(); };
      const timer = setTimeout(done, 5000);
      const sub = git.onDidChangeState((s) => { if (s === "initialized") done(); });
    });
  }
  return git.getRepository(folder) ?? (await git.openRepository(folder));
}

/** git empty tree: the git file system provider serves it as an empty, read-only file. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function getGitApi(): Promise<GitApi> {
  const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>("vscode.git");
  if (!ext) throw new Error("the built-in git extension is not available");
  const exports = ext.isActive ? ext.exports : await ext.activate();
  return exports.getAPI(1);
}

/** nexus.openCommit and nexus.mergeAgentBranch: quick picks over the shared router (no webview). */
function registerGitViews(context: vscode.ExtensionContext, router: NexusBridgeRouter): void {
  const client = createLoopbackClient(router);
  context.subscriptions.push(client);
  const request = client.request.bind(client);

  async function openDiff(left: DiffSide, right: DiffSide, path: string, title: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error("open a workspace folder first");
    const git = await getGitApi();
    const file = vscode.Uri.joinPath(folder.uri, path);
    const side = (s: DiffSide): vscode.Uri => (s.kind === "git" ? git.toGitUri(file, s.ref) : git.toGitUri(file, EMPTY_TREE));
    await vscode.commands.executeCommand("vscode.diff", side(left), side(right), title);
  }

  async function resolveSha(sha: string): Promise<string | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    try {
      const repo = await repositoryFor(await getGitApi(), folder.uri);
      return (await repo?.getCommit(sha))?.hash.toLowerCase();
    } catch {
      return undefined;
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("nexus.openCommit", (sha?: unknown) => openCommit({
      request,
      showQuickPick: (items, o) => Promise.resolve(vscode.window.showQuickPick(items, { title: o.title, placeHolder: o.placeHolder, matchOnDescription: true })),
      showInputBox: o => Promise.resolve(vscode.window.showInputBox(o)),
      showError: m => void vscode.window.showErrorMessage(m),
      resolveSha,
      openDiff,
    }, typeof sha === "string" ? sha : undefined)),
    vscode.commands.registerCommand("nexus.mergeAgentBranch", (sessionId?: unknown) => mergeAgentBranch({
      request,
      showQuickPick: (items, o) => Promise.resolve(vscode.window.showQuickPick(items, { placeHolder: o.placeHolder })),
      confirm: async m => (await vscode.window.showWarningMessage(m, { modal: true }, "MERGE")) === "MERGE",
      showInfo: m => void vscode.window.showInformationMessage(m),
      showError: m => void vscode.window.showErrorMessage(m),
    }, typeof sessionId === "string" ? sessionId : undefined)),
  );
}
