// Webview hosting: the only bridge file that touches vscode. Builds WebviewView / WebviewPanel with a strict CSP,
// adapts their Webview to the router's WebviewTransport, and implements app.ping.
// The vscode API is injected (defaulting to the real module) so tests never need the editor.
import { randomBytes, randomUUID } from "node:crypto";
import type * as vscode from "vscode";
import type { NexusBridgeRouter, WebviewTransport } from "./router";
import type { Disposable } from "./types";

/** The slice of the vscode API this file uses. */
export interface HostApi {
  Uri: { joinPath(base: vscode.Uri, ...parts: string[]): vscode.Uri };
  window: {
    registerWebviewViewProvider(viewId: string, provider: vscode.WebviewViewProvider, options?: { webviewOptions?: { retainContextWhenHidden?: boolean } }): Disposable;
    createWebviewPanel(viewType: string, title: string, column: vscode.ViewColumn, options: vscode.WebviewPanelOptions & vscode.WebviewOptions): vscode.WebviewPanel;
  };
  workspace: { getConfiguration(section: string): { get<T>(key: string): T | undefined } };
  ViewColumn: { Active: vscode.ViewColumn };
}

function realApi(): HostApi {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("vscode") as HostApi;
}

export function makeNonce(): string { return randomBytes(16).toString("base64"); }

/** Strict CSP: nothing remote, scripts and styles only by nonce, local files only from the webview's own resource origin. */
export function buildCsp(nonce: string, cspSource: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}' ${cspSource}`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function escapeAttr(s: string): string { return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

export function buildHtml(opts: { nonce: string; cspSource: string; scriptUri: string; title: string }): string {
  const { nonce, cspSource, scriptUri, title } = opts;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(buildCsp(nonce, cspSource))}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(title)}</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${escapeAttr(scriptUri)}"></script>
</body>
</html>`;
}

function configureWebview(api: HostApi, ctx: vscode.ExtensionContext, entry: string, webview: vscode.Webview, title: string): void {
  const media = api.Uri.joinPath(ctx.extensionUri, "media");
  webview.options = { enableScripts: true, localResourceRoots: [media] };
  const scriptUri = webview.asWebviewUri(api.Uri.joinPath(media, `${entry}.js`)).toString();
  webview.html = buildHtml({ nonce: makeNonce(), cspSource: webview.cspSource, scriptUri, title });
}

function transportOf(webview: vscode.Webview, onDidDispose: (cb: () => void) => Disposable): WebviewTransport {
  return {
    post: m => webview.postMessage(m),
    onMessage: cb => webview.onDidReceiveMessage(cb),
    onDidDispose,
  };
}

export interface WebviewHost {
  /** Registers the view provider for `viewId`. */
  register(): Disposable;
  /** Open the same entry as an editor panel. */
  openPanel(title: string, column?: vscode.ViewColumn): vscode.WebviewPanel;
}

/** Host one webview entry (media/<entry>.js) as a sidebar view and/or editor panel, wired to the router. */
export function createWebviewHost(ctx: vscode.ExtensionContext, viewId: string, entry: string, router: NexusBridgeRouter, api: HostApi = realApi()): WebviewHost {
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(view) {
      configureWebview(api, ctx, entry, view.webview, view.title ?? viewId);
      const attached = router.attach(transportOf(view.webview, cb => view.onDidDispose(cb)));
      ctx.subscriptions.push(attached);
    },
  };
  return {
    register: () => api.window.registerWebviewViewProvider(viewId, provider, { webviewOptions: { retainContextWhenHidden: false } }),
    openPanel(title, column) {
      const media = api.Uri.joinPath(ctx.extensionUri, "media");
      const panel = api.window.createWebviewPanel(viewId, title, column ?? api.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media] });
      configureWebview(api, ctx, entry, panel.webview, title);
      ctx.subscriptions.push(router.attach(transportOf(panel.webview, cb => panel.onDidDispose(cb))));
      return panel;
    },
  };
}

/** "T+05": whole hours since the configured T0 (setting `nexus.t0`, ISO time). "T+--" when unset or invalid. */
export function formatTPlus(t0: string | undefined, now: Date): string {
  const start = t0 ? Date.parse(t0) : NaN;
  if (Number.isNaN(start)) return "T+--";
  const hours = Math.floor((now.getTime() - start) / 3_600_000);
  return `${hours < 0 ? "T-" : "T+"}${String(Math.abs(hours)).padStart(2, "0")}`;
}

/** Implements app.ping: machineId persisted in globalState, tPlus from the T0 setting. */
export function registerAppPing(router: NexusBridgeRouter, ctx: { globalState: Pick<vscode.Memento, "get" | "update"> }, api: HostApi = realApi(), now: () => Date = () => new Date()): Disposable {
  return router.handle("app.ping", async () => {
    let machineId = ctx.globalState.get<string>("nexus.machineId");
    if (!machineId) { machineId = randomUUID(); await ctx.globalState.update("nexus.machineId", machineId); }
    return { pong: true as const, machineId, tPlus: formatTPlus(api.workspace.getConfiguration("nexus").get<string>("t0"), now()) };
  });
}
