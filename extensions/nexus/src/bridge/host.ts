// Webview hosting: the only bridge file that touches vscode. Builds WebviewView / WebviewPanel with a strict CSP,
// adapts their Webview to the router's WebviewTransport, and implements app.ping.
// The vscode API is injected (defaulting to the real module) so tests never need the editor.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
  /** The file's text, or undefined if it does not exist. */
  readTextFile(uri: vscode.Uri): string | undefined;
}

function readTextFile(uri: vscode.Uri): string | undefined {
  try { return readFileSync(uri.fsPath, "utf8"); } catch { return undefined; }
}

function realApi(): HostApi {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Uri, window, workspace, ViewColumn } = require("vscode") as typeof vscode;
  return { Uri, window, workspace, ViewColumn, readTextFile };
}

export function makeNonce(): string { return randomBytes(16).toString("base64"); }

/**
 * Strict CSP: nothing remote, entry scripts only by nonce, and local files only from the webview's own resource origin.
 * Split chunks loaded by import() inherit the nonce; cspSource in script-src also lets Vite's modulepreload links load.
 * No 'strict-dynamic': it would let a script-creating gadget in a dependency load remote code.
 */
export function buildCsp(nonce: string, cspSource: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${cspSource}`,
    `style-src 'nonce-${nonce}' ${cspSource}`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function escapeAttr(s: string): string { return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/** The relative assets of a page Vite built into media/<entry>/index.html. */
export interface BuiltPage { scripts: string[]; styles: string[] }

const ASSET_PATH = /^assets\/[A-Za-z0-9._-]+\.(?:js|css)$/;

/** Reads only well-formed relative assets out of Vite's page. Anything else in it (inline code, remote URLs) is left out. */
export function parseBuiltPage(html: string): BuiltPage {
  const assets = (tag: RegExp) => [...html.matchAll(tag)].map(m => m[1].replace(/^\.\//, "")).filter(p => ASSET_PATH.test(p));
  return {
    scripts: assets(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g),
    styles: assets(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g),
  };
}

export function buildHtml(opts: { nonce: string; cspSource: string; scripts: string[]; styles: string[]; title: string }): string {
  const { nonce, cspSource, scripts, styles, title } = opts;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(buildCsp(nonce, cspSource))}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(title)}</title>
${styles.map(href => `<link rel="stylesheet" href="${escapeAttr(href)}">`).join("\n")}
</head>
<body>
<div id="root"></div>
${scripts.map(src => `<script type="module" nonce="${nonce}" src="${escapeAttr(src)}"></script>`).join("\n")}
</body>
</html>`;
}

/** Shown when an entry has no build, so a missing webview says why instead of staying blank. No scripts run. */
export function buildMissingHtml(cspSource: string, entry: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(buildCsp(makeNonce(), cspSource))}">
</head>
<body>Webview "${escapeAttr(entry)}" is not built. Run npm run build:webviews in extensions/nexus.</body>
</html>`;
}

function configureWebview(api: HostApi, ctx: vscode.ExtensionContext, entry: string, webview: vscode.Webview, title: string): void {
  const media = api.Uri.joinPath(ctx.extensionUri, "media");
  webview.options = { enableScripts: true, localResourceRoots: [media] };
  const built = api.readTextFile(api.Uri.joinPath(media, entry, "index.html"));
  const page = built === undefined ? undefined : parseBuiltPage(built);
  if (!page?.scripts.length) { webview.html = buildMissingHtml(webview.cspSource, entry); return; }
  const toUri = (asset: string) => webview.asWebviewUri(api.Uri.joinPath(media, entry, ...asset.split("/"))).toString();
  webview.html = buildHtml({ nonce: makeNonce(), cspSource: webview.cspSource, scripts: page.scripts.map(toUri), styles: page.styles.map(toUri), title });
}

interface HostedWebview {
  webview: vscode.Webview;
  onDidDispose(cb: () => void): Disposable;
  onDidChangeVisibility?(cb: (visible: boolean) => void): Disposable;
}

/** Attach a webview to the router; its session is dropped on dispose and its ctx.subscriptions entry removed. */
function attachTracked(ctx: vscode.ExtensionContext, router: NexusBridgeRouter, hosted: HostedWebview): void {
  const { webview } = hosted;
  const transport: WebviewTransport = {
    post: m => webview.postMessage(m),
    onMessage: cb => webview.onDidReceiveMessage(cb),
    onDidDispose: cb => hosted.onDidDispose(cb),
    ...(hosted.onDidChangeVisibility ? { onDidChangeVisibility: (cb: (visible: boolean) => void) => hosted.onDidChangeVisibility!(cb) } : {}),
  };
  const attached = router.attach(transport);
  ctx.subscriptions.push(attached);
  const gone = hosted.onDidDispose(() => {
    attached.dispose();
    const i = ctx.subscriptions.indexOf(attached);
    if (i >= 0) ctx.subscriptions.splice(i, 1);
    gone.dispose();
  });
}

export interface WebviewHost {
  /** Registers the view provider for `viewId`. */
  register(): Disposable;
  /** Open the same entry as an editor panel. */
  openPanel(title: string, column?: vscode.ViewColumn): vscode.WebviewPanel;
}

export interface WebviewHostOptions {
  /** Called once per resolved view, after its HTML is set and it is attached to the router (the caller may re-set `webview.html`, e.g. to add body data). */
  onResolveView?(view: vscode.WebviewView): void;
}

/**
 * Host one webview entry (Vite's build in media/<entry>/) as a sidebar view and/or editor panel, wired to the router.
 * Views: retainContextWhenHidden stays off (memory), so hiding one destroys its page: the router drops its subscriptions
 * on hide and the reloaded page subscribes again. Panels: retained, because moving a panel or maximizing another group can
 * destroy an unretained page while `visible` stays true, so a panel keeps its subscriptions across a hide. Moving a panel
 * to another window still reloads it; the reloaded page's reused ids replace the old subscriptions.
 */
export function createWebviewHost(ctx: vscode.ExtensionContext, viewId: string, entry: string, router: NexusBridgeRouter, api: HostApi = realApi(), options: WebviewHostOptions = {}): WebviewHost {
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(view) {
      configureWebview(api, ctx, entry, view.webview, view.title ?? viewId);
      attachTracked(ctx, router, {
        webview: view.webview,
        onDidDispose: cb => view.onDidDispose(cb),
        onDidChangeVisibility: cb => view.onDidChangeVisibility(() => cb(view.visible)),
      });
      options.onResolveView?.(view);
    },
  };
  return {
    register: () => api.window.registerWebviewViewProvider(viewId, provider, { webviewOptions: { retainContextWhenHidden: false } }),
    openPanel(title, column) {
      const media = api.Uri.joinPath(ctx.extensionUri, "media");
      const panel = api.window.createWebviewPanel(viewId, title, column ?? api.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true });
      configureWebview(api, ctx, entry, panel.webview, title);
      attachTracked(ctx, router, {
        webview: panel.webview,
        onDidDispose: cb => panel.onDidDispose(cb),
      });
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
