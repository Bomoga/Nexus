import * as vscode from "vscode";
import { createWebviewHost } from "../bridge/host";
import { NexusBridgeRouter } from "../bridge/router";
import { Lane3Views } from "../features/views/lane3-views";

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
  return views;
}
