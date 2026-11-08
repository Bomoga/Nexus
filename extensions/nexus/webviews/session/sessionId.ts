import { isFakeMode } from "../shared";

// How the panel learns its session, in one place. The host renders <body data-session-id="...">; ?sessionId= is a dev
// convenience only (VS Code owns the webview's query string). The demo fallback exists only in ?fake=1 and the
// fixtures are loaded lazily so production bundles carry no demo data.
/** The host sets <body data-compose-seq="n"> (a new n each time) when "New task" asks the view for a blank composer. */
export function resolveComposeSeq(): number | undefined {
  const raw = document.body.dataset.composeSeq;
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

export async function resolveSessionId(): Promise<string | undefined> {
  const fromBody = document.body.dataset.sessionId;
  if (fromBody) return fromBody;
  const fromQuery = new URLSearchParams(location.search).get("sessionId");
  if (fromQuery) return fromQuery;
  if (!isFakeMode()) return undefined;
  const { fx } = await import("../../src/contracts/fixtures");
  return fx.session.id;
}
