import { describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { buildCsp, buildHtml, parseBuiltPage, createWebviewHost, formatTPlus, registerAppPing } from "./host";
import type { HostApi } from "./host";
import { fx } from "../contracts/fixtures";
import { NexusBridgeRouter } from "./router";

/** A webview whose events can be fired by the test. */
function fakeWebview() {
  const received = new Set<(m: unknown) => void>();
  const posted: unknown[] = [];
  const webview = {
    options: undefined as vscode.WebviewOptions | undefined, html: "", cspSource: "https://file+.vscode-resource.test",
    asWebviewUri: (u: vscode.Uri) => ({ toString: () => `https://file+.vscode-resource.test/${(u as unknown as { path: string }).path}` }),
    postMessage: async (m: unknown) => { posted.push(m); return true; },
    onDidReceiveMessage: (cb: (m: unknown) => void) => { received.add(cb); return { dispose: () => { received.delete(cb); } }; },
  };
  return { webview, received, posted };
}

function fakeView() {
  const base = fakeWebview();
  const dispose = new Set<() => void>();
  const visibility = new Set<() => void>();
  const view = {
    ...base, title: "T", visible: true,
    onDidDispose: (cb: () => void) => { dispose.add(cb); return { dispose: () => { dispose.delete(cb); } }; },
    onDidChangeVisibility: (cb: () => void) => { visibility.add(cb); return { dispose: () => { visibility.delete(cb); } }; },
  };
  return { view, ...base, disposeView: () => { for (const c of [...dispose]) c(); }, setVisible: (v: boolean) => { view.visible = v; for (const c of [...visibility]) c(); } };
}

function fakePanel() {
  const base = fakeWebview();
  const dispose = new Set<() => void>();
  const state = new Set<(e: { webviewPanel: { visible: boolean } }) => void>();
  const panel = {
    ...base, visible: true,
    onDidDispose: (cb: () => void) => { dispose.add(cb); return { dispose: () => { dispose.delete(cb); } }; },
    onDidChangeViewState: (cb: (e: { webviewPanel: { visible: boolean } }) => void) => { state.add(cb); return { dispose: () => { state.delete(cb); } }; },
  };
  return { panel, ...base, disposePanel: () => { for (const c of [...dispose]) c(); }, setVisible: (v: boolean) => { panel.visible = v; for (const c of [...state]) c({ webviewPanel: panel }); } };
}

// What Vite really emits for media/<entry>/index.html.
const VITE_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Nexus chat</title>
    <script type="module" crossorigin src="./assets/index-Pl2JwmhW.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-DsQ-puiO.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

function fakeApi(t0?: string, missing = false, page?: string) {
  const reads: string[] = [];
  const providers = new Map<string, vscode.WebviewViewProvider>();
  const panels: ReturnType<typeof fakePanel>[] = [];
  const panelArgs: { viewType: string; title: string; options: unknown }[] = [];
  const api: HostApi = {
    Uri: { joinPath: (b, ...p) => ({ toString: () => [b.toString(), ...p].join("/"), path: [b.toString(), ...p].join("/") }) as unknown as vscode.Uri },
    window: {
      registerWebviewViewProvider: (id, p) => { providers.set(id, p); return { dispose() {} }; },
      createWebviewPanel: (viewType, title, _col, options) => { const p = fakePanel(); panels.push(p); panelArgs.push({ viewType, title, options }); return p.panel as unknown as vscode.WebviewPanel; },
    },
    workspace: { getConfiguration: () => ({ get: <T,>() => t0 as T | undefined }) },
    ViewColumn: { Active: -1 as vscode.ViewColumn },
    readTextFile: uri => { reads.push(uri.toString()); return missing ? undefined : page ?? (uri.toString().endsWith("/index.html") ? VITE_PAGE : undefined); },
  };
  return { api, providers, panels, panelArgs, reads };
}

const ctx = () => ({ extensionUri: { toString: () => "ext", path: "ext" }, subscriptions: [] as { dispose(): void }[] }) as unknown as vscode.ExtensionContext;
const router = () => new NexusBridgeRouter({ containsSecret: () => false, log: () => {} });
const tick = () => new Promise<void>(r => setTimeout(r, 0));
const resolveView = (providers: Map<string, vscode.WebviewViewProvider>, id: string, v: ReturnType<typeof fakeView>) =>
  providers.get(id)!.resolveWebviewView(v.view as unknown as vscode.WebviewView, {} as never, {} as never);

describe("webview host", () => {
  it("CSP carries the nonce, blocks connect, and has no remote source", () => {
    const csp = buildCsp("NONCE123", "https://file+.vscode-resource.test");
    expect(csp).toContain("script-src 'nonce-NONCE123' https://file+.vscode-resource.test;");
    expect(csp).not.toContain("strict-dynamic");
    expect(csp).toContain("style-src 'nonce-NONCE123'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toMatch(/https?:\/\/(?!file\+\.vscode-resource\.test)/);
    expect(csp).not.toContain("unsafe-");
    expect(csp).not.toContain("*");
  });

  it("html loads module scripts under the nonce and stylesheets from the resource origin", () => {
    const html = buildHtml({ nonce: "N", cspSource: "src", scripts: ["u/a.js"], styles: ["u/a.css"], title: "A\"<b>" });
    expect(html).toContain('<script type="module" nonce="N" src="u/a.js">');
    expect(html).toContain('<link rel="stylesheet" href="u/a.css">');
    expect(html).not.toContain("<b>");
  });

  it("reads Vite's assets and refuses remote, parent-relative or inline ones", () => {
    expect(parseBuiltPage(VITE_PAGE)).toEqual({ scripts: ["assets/index-Pl2JwmhW.js"], styles: ["assets/index-DsQ-puiO.css"] });
    const hostile = `<script src="https://evil.test/a.js"></script><script src="../../x.js"></script><script src="./assets/a b.js"></script>
      <script>alert(1)</script><link rel="stylesheet" href="https://evil.test/a.css"><link rel="stylesheet" href="./assets/../../a.css">`;
    expect(parseBuiltPage(hostile)).toEqual({ scripts: [], styles: [] });
  });

  it("reads the entry's own build and escapes stylesheet urls", () => {
    const { api, providers, reads } = fakeApi();
    createWebviewHost(ctx(), "nexus.chat", "chat", router(), api).register();
    const view = fakeView();
    resolveView(providers, "nexus.chat", view);
    expect(reads).toEqual(["ext/media/chat/index.html"]);
    expect(buildHtml({ nonce: "N", cspSource: "s", scripts: [], styles: ['a.css"><x'], title: "t" })).toContain('href="a.css&quot;&gt;&lt;x"');
  });

  it("treats a built page with no usable script as not built", () => {
    const { api, providers } = fakeApi(undefined, false, '<link rel="stylesheet" href="./assets/a.css">');
    createWebviewHost(ctx(), "nexus.chat", "chat", router(), api).register();
    const view = fakeView();
    resolveView(providers, "nexus.chat", view);
    expect(view.webview.html).toContain("is not built");
  });

  it("explains a missing build instead of a blank page, and runs no script", () => {
    const { api, providers } = fakeApi(undefined, true);
    createWebviewHost(ctx(), "nexus.chat", "chat", router(), api).register();
    const view = fakeView();
    resolveView(providers, "nexus.chat", view);
    expect(view.webview.html).toContain('Webview "chat" is not built');
    expect(view.webview.html).not.toContain("<script");
    expect(view.webview.html).toContain("default-src 'none'");
  });

  it("resolves a view with scripts on, only media/ as a local root, and the entry script", () => {
    const { api, providers } = fakeApi();
    createWebviewHost(ctx(), "nexus.globe", "globe", router(), api).register();
    const view = fakeView();
    resolveView(providers, "nexus.globe", view);
    expect(view.webview.options?.enableScripts).toBe(true);
    expect(view.webview.options?.localResourceRoots).toHaveLength(1);
    expect(String(view.webview.options?.localResourceRoots?.[0])).toBe("ext/media");
    const nonce = /nonce-([^']+)'/.exec(view.webview.html)![1];
    expect(view.webview.html).toContain(`<script type="module" nonce="${nonce}" src="https://file+.vscode-resource.test/ext/media/globe/assets/index-Pl2JwmhW.js">`);
    expect(view.webview.html).toContain(`<link rel="stylesheet" href="https://file+.vscode-resource.test/ext/media/globe/assets/index-DsQ-puiO.css">`);
    expect(view.webview.html).not.toContain("crossorigin");
  });

  it("uses a fresh nonce per webview", () => {
    const { api, providers } = fakeApi();
    createWebviewHost(ctx(), "v", "e", router(), api).register();
    const a = fakeView(), b = fakeView();
    resolveView(providers, "v", a);
    resolveView(providers, "v", b);
    expect(/nonce-([^']+)'/.exec(a.webview.html)![1]).not.toBe(/nonce-([^']+)'/.exec(b.webview.html)![1]);
  });
  it("escapes the script uri and title in the page", () => {
    const html = buildHtml({ nonce: "N", cspSource: "src", scripts: ['x.js"><script>alert(1)</script>'], styles: [], title: "t" });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("openPanel applies the CSP, entry script and media-only localResourceRoots", () => {
    const { api, panels, panelArgs } = fakeApi();
    const host = createWebviewHost(ctx(), "nexus.session", "session", router(), api);
    host.openPanel("Session");
    const opts = panelArgs[0].options as vscode.WebviewOptions;
    expect(opts.enableScripts).toBe(true);
    expect(opts.localResourceRoots?.map(String)).toEqual(["ext/media"]);
    expect((panelArgs[0].options as vscode.WebviewPanelOptions).retainContextWhenHidden).toBe(true);
    const w = panels[0].webview;
    expect(String(w.options?.localResourceRoots?.[0])).toBe("ext/media");
    const nonce = /nonce-([^']+)'/.exec(w.html)![1];
    expect(w.html).toContain(`content="default-src 'none'; script-src 'nonce-${nonce}'`);
    expect(w.html).toContain("connect-src 'none'");
    expect(w.html).toContain(`<script type="module" nonce="${nonce}" src="https://file+.vscode-resource.test/ext/media/session/assets/index-Pl2JwmhW.js">`);
    expect(w.html).not.toMatch(/https?:\/\/(?!file\+\.vscode-resource\.test)/);
  });

  it("view disposal drops its session and removes it from ctx.subscriptions", async () => {
    const { api, providers } = fakeApi();
    const c = ctx();
    const r = router();
    let cleaned = 0;
    r.onSubscribe("events.subscribe", () => ({ dispose: () => { cleaned++; } }));
    createWebviewHost(c, "v", "e", r, api).register();
    const v = fakeView();
    resolveView(providers, "v", v);
    expect(c.subscriptions).toHaveLength(1);
    for (const cb of v.received) cb({ t: "sub", id: "a", name: "events.subscribe", body: {} });
    await tick();
    v.disposeView();
    expect(cleaned).toBe(1);
    expect(v.received.size).toBe(0);
    expect(c.subscriptions).toHaveLength(0);
  });

  it("panel disposal drops its session and removes it from ctx.subscriptions", async () => {
    const { api, panels } = fakeApi();
    const c = ctx();
    const r = router();
    let cleaned = 0;
    r.onSubscribe("events.subscribe", () => ({ dispose: () => { cleaned++; } }));
    createWebviewHost(c, "p", "e", r, api).openPanel("P");
    const p = panels[0];
    expect(c.subscriptions).toHaveLength(1);
    for (const cb of p.received) cb({ t: "sub", id: "a", name: "events.subscribe", body: {} });
    await tick();
    p.disposePanel();
    expect(cleaned).toBe(1);
    expect(p.received.size).toBe(0);
    expect(c.subscriptions).toHaveLength(0);
  });

  it("hiding a view drops its subscriptions, and the same id subscribes again; a retained panel keeps its own", async () => {
    const { api, providers, panels } = fakeApi();
    const r = router();
    let cleaned = 0;
    r.onSubscribe("events.subscribe", () => ({ dispose: () => { cleaned++; } }));
    const host = createWebviewHost(ctx(), "v", "e", r, api);
    host.register(); host.openPanel("P");
    const v = fakeView();
    resolveView(providers, "v", v);
    const sub = async (received: Set<(m: unknown) => void>) => { for (const cb of received) cb({ t: "sub", id: "a", name: "events.subscribe", body: {} }); await tick(); };
    await sub(v.received); await sub(panels[0].received);
    v.setVisible(false); panels[0].setVisible(false);
    expect(cleaned).toBe(1);   // the view's only: the panel's page is retained
    r.publish("events.subscribe", fx.event);
    await tick();
    expect(v.posted).toEqual([]);
    expect(panels[0].posted.map(m => (m as { t: string }).t)).toEqual(["evt"]);
    v.setVisible(true); panels[0].setVisible(true);
    await sub(v.received);
    r.publish("events.subscribe", { ...fx.event, id: "e2" });
    await tick();
    expect(v.posted.map(m => (m as { t: string }).t)).toEqual(["evt"]);
    expect(panels[0].posted.map(m => (m as { t: string }).t)).toEqual(["evt", "evt"]);
  });
});

describe("app.ping", () => {
  it("formats T+ from the setting", () => {
    expect(formatTPlus("2026-11-07T03:15:00Z", new Date("2026-11-07T08:20:00Z"))).toBe("T+05");
    expect(formatTPlus(undefined, new Date())).toBe("T+--");
    expect(formatTPlus("garbage", new Date())).toBe("T+--");
  });

  it("persists a machineId and reports tPlus", async () => {
    const store = new Map<string, unknown>();
    const globalState = { get: (k: string) => store.get(k), update: async (k: string, v: unknown) => { store.set(k, v); } };
    const r = router();
    const posted: { body: { machineId?: string; tPlus?: string } }[] = [];
    let onMsg: (m: unknown) => void = () => {};
    r.attach({ post: m => { posted.push(m as (typeof posted)[number]); }, onMessage: cb => { onMsg = cb; return { dispose() {} }; }, onDidDispose: () => ({ dispose() {} }), onDidChangeVisibility: () => ({ dispose() {} }) });
    registerAppPing(r, { globalState }, fakeApi("2026-11-07T03:15:00Z").api, () => new Date("2026-11-07T05:00:00Z"));
    onMsg({ t: "req", id: "1", name: "app.ping", body: {} });
    onMsg({ t: "req", id: "2", name: "app.ping", body: {} });
    await new Promise(r2 => setTimeout(r2, 5));
    expect(posted[0].body).toMatchObject({ pong: true, tPlus: "T+01" });
    expect(posted[0].body.machineId).toBe(posted[1].body.machineId);
    expect(store.get("nexus.machineId")).toBe(posted[0].body.machineId);
  });
});
