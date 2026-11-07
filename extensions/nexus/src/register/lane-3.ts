import * as vscode from "vscode";
import { createWebviewHost } from "../bridge/host";
import { NexusBridgeRouter } from "../bridge/router";
import { Lane3Views } from "../features/views/lane3-views";
import { createLoopbackClient } from "../features/gitviews/loopback";
import { mergeAgentBranch } from "../features/gitviews/merge-agent-branch";
import { openCommit } from "../features/gitviews/open-commit";
import type { DiffSide } from "../features/gitviews/open-commit";

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

export function registerLane3(context: vscode.ExtensionContext, router?: NexusBridgeRouter): Lane3Views {
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
  return views;
}

/** The slice of the built-in git extension's API (extensions/git/src/api/git.d.ts) used for diff URIs. */
interface GitApi { toGitUri(uri: vscode.Uri, ref: string): vscode.Uri }

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
    const side = (s: DiffSide): vscode.Uri => (s.kind === "git" ? git.toGitUri(file, s.ref) : vscode.Uri.from({ scheme: "untitled", path: `/${path}` }));
    await vscode.commands.executeCommand("vscode.diff", side(left), side(right), title);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("nexus.openCommit", (sha?: unknown) => openCommit({
      request,
      showQuickPick: (items, o) => Promise.resolve(vscode.window.showQuickPick(items, { title: o.title, placeHolder: o.placeHolder, matchOnDescription: true })),
      showInputBox: o => Promise.resolve(vscode.window.showInputBox(o)),
      showError: m => void vscode.window.showErrorMessage(m),
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
