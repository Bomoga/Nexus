// ui.openExternal: a webview asks the host to open a link in the system browser. The URL usually comes from Slack, so it is
// untrusted: the host validates it again (the contract already requires https), and the injected opener is
// vscode.env.openExternal, which applies VS Code's own link protection prompt for untrusted domains.
import type { Req } from "../../contracts";
import { BridgeError } from "../../bridge/types";
import type { BridgeRouter, Disposable } from "../../bridge/types";

const MAX_URL_LENGTH = 2048;

/** The normalized https URL, or null if it must not be opened. */
export function safeExternalUrl(raw: string): string | null {
  if (raw.length > MAX_URL_LENGTH || [...raw].some(ch => ch.charCodeAt(0) <= 0x20 || ch.charCodeAt(0) === 0x7f)) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
  return url.toString();
}

/** Registers the handler. `open` receives only URLs that passed safeExternalUrl. */
export function registerOpenExternal(router: BridgeRouter, open: (url: string) => Promise<boolean>): Disposable {
  return router.handle("ui.openExternal", async (req: Req<"ui.openExternal">) => {
    const url = safeExternalUrl(req.url);
    if (!url) throw new BridgeError("invalid_request", "only plain https links can be opened");
    if (!(await open(url))) throw new BridgeError("cancelled", "the link was not opened");
    return {};
  });
}
