import { isFakeMode } from "../shared";

// How the panel learns its session, in one place. The host renders <body data-session-id="...">; ?sessionId= is a dev
// convenience only (VS Code owns the webview's query string). The demo fallback exists only in ?fake=1 and the
// fixtures are loaded lazily so production bundles carry no demo data.
export async function resolveSessionId(): Promise<string | undefined> {
  const fromBody = document.body.dataset.sessionId;
  if (fromBody) return fromBody;
  const fromQuery = new URLSearchParams(location.search).get("sessionId");
  if (fromQuery) return fromQuery;
  if (!isFakeMode()) return undefined;
  const { fx } = await import("../../src/contracts/fixtures");
  return fx.session.id;
}
