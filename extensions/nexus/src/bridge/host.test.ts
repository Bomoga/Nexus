import { describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { buildCsp, buildHtml, createWebviewHost, formatTPlus, registerAppPing } from "./host";
import type { HostApi } from "./host";
import { NexusBridgeRouter } from "./router";

function fakeApi(t0?: string) {
  const created: { html?: string; options?: vscode.WebviewOptions }[] = [];
  const providers = new Map<string, vscode.WebviewViewProvider>();
  const api: HostApi = {
    Uri: { joinPath: (b, ...p) => ({ toString: () => [b.toString(), ...p].join("/"), path: [b.toString(), ...p].join("/") }) as unknown as vscode.Uri },
    window: {
      registerWebviewViewProvider: (id, p) => { providers.set(id, p); return { dispose() {} }; },
      createWebviewPanel: () => { throw new Error("unused"); },
    },
    workspace: { getConfiguration: () => ({ get: <T,>() => t0 as T | undefined }) },
    ViewColumn: { Active: -1 as vscode.ViewColumn },
  };
  return { api, providers, created };
}

function fakeView() {
  const webview = {
    options: undefined as vscode.WebviewOptions | undefined, html: "", cspSource: "https://file+.vscode-resource.test",
    asWebviewUri: (u: vscode.Uri) => ({ toString: () => `https://file+.vscode-resource.test/${(u as unknown as { path: string }).path}` }),
    postMessage: async () => true,
    onDidReceiveMessage: () => ({ dispose() {} }),
  };
  return { webview, title: "T", onDidDispose: () => ({ dispose() {} }) };
}

const ctx = () => ({ extensionUri: { toString: () => "ext", path: "ext" }, subscriptions: [] as { dispose(): void }[] }) as unknown as vscode.ExtensionContext;
const router = () => new NexusBridgeRouter({ containsSecret: () => false, log: () => {} });

describe("webview host", () => {
  it("CSP carries the nonce, blocks connect, and has no remote source", () => {
    const csp = buildCsp("NONCE123", "https://file+.vscode-resource.test");
    expect(csp).toContain("script-src 'nonce-NONCE123'");
    expect(csp).toContain("style-src 'nonce-NONCE123'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toMatch(/https?:\/\/(?!file\+\.vscode-resource\.test)/);
    expect(csp).not.toContain("unsafe-");
    expect(csp).not.toContain("*");
  });

  it("html loads media/<entry>.js under the same nonce", () => {
    const html = buildHtml({ nonce: "N", cspSource: "src", scriptUri: "u/media/globe.js", title: "A\"<b>" });
    expect(html).toContain('<script nonce="N" src="u/media/globe.js">');
    expect(html).not.toContain("<b>");
  });

  it("resolves a view with scripts on, only media/ as a local root, and the entry script", () => {
    const { api, providers } = fakeApi();
    createWebviewHost(ctx(), "nexus.globe", "globe", router(), api).register();
    const view = fakeView();
    providers.get("nexus.globe")!.resolveWebviewView(view as unknown as vscode.WebviewView, {} as never, {} as never);
    expect(view.webview.options?.enableScripts).toBe(true);
    expect(view.webview.options?.localResourceRoots).toHaveLength(1);
    expect(String(view.webview.options?.localResourceRoots?.[0])).toBe("ext/media");
    const nonce = /nonce-([^']+)'/.exec(view.webview.html)![1];
    expect(view.webview.html).toContain(`<script nonce="${nonce}" src="https://file+.vscode-resource.test/ext/media/globe.js">`);
  });

  it("uses a fresh nonce per webview", () => {
    const { api, providers } = fakeApi();
    createWebviewHost(ctx(), "v", "e", router(), api).register();
    const a = fakeView(), b = fakeView();
    providers.get("v")!.resolveWebviewView(a as never, {} as never, {} as never);
    providers.get("v")!.resolveWebviewView(b as never, {} as never, {} as never);
    expect(/nonce-([^']+)'/.exec(a.webview.html)![1]).not.toBe(/nonce-([^']+)'/.exec(b.webview.html)![1]);
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
    r.attach({ post: m => { posted.push(m as (typeof posted)[number]); }, onMessage: cb => { onMsg = cb; return { dispose() {} }; }, onDidDispose: () => ({ dispose() {} }) });
    registerAppPing(r, { globalState }, fakeApi("2026-11-07T03:15:00Z").api, () => new Date("2026-11-07T05:00:00Z"));
    onMsg({ t: "req", id: "1", name: "app.ping", body: {} });
    onMsg({ t: "req", id: "2", name: "app.ping", body: {} });
    await new Promise(r2 => setTimeout(r2, 5));
    expect(posted[0].body).toMatchObject({ pong: true, tPlus: "T+01" });
    expect(posted[0].body.machineId).toBe(posted[1].body.machineId);
    expect(store.get("nexus.machineId")).toBe(posted[0].body.machineId);
  });
});
