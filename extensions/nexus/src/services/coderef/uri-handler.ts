// The extension's one nexus:// entry point. Other parts register a route by prefix; vscode.window.registerUriHandler is
// wired to `handle` by the lead in register/lane-2.ts. vscode-free. Every URI is untrusted input.
//
// Two spellings reach the same route, because the frozen links are nexus://<route>/... while VS Code hands an extension
// only URIs whose authority is its id: nexus://nexus.nexus/<route>/...
import { CODEREF_SCHEME } from "../../contracts";

export interface Disposable { dispose(): void }

/** Receives the normalized nexus://<route>/... string. Returns false if it did not act. */
export type UriRouteHandler = (uri: string) => boolean | void | Promise<boolean | void>;

const EXTENSION_ID = "nexus.nexus";
const MAX_URI_LENGTH = 4096;
const SEGMENT = /^[a-z0-9-]+$/;

/** nexus://nexus.nexus/auth/callback?code=1 -> nexus://auth/callback?code=1. Null for anything that is not a nexus:// URI. */
export function normalizeNexusUri(uri: string): string | null {
  if (uri.length > MAX_URI_LENGTH) return null;
  const prefix = `${CODEREF_SCHEME}://`;
  if (!uri.startsWith(prefix)) return null;
  const rest = uri.slice(prefix.length);
  return prefix + (rest.toLowerCase().startsWith(`${EXTENSION_ID}/`) ? rest.slice(EXTENSION_ID.length + 1) : rest);
}

/** The parts of a vscode.Uri the router reads. VS Code hands the extension an already-decoded path and query. */
export interface UriLike { scheme: string; authority: string; path: string; query: string }

/**
 * Rebuilds the nexus://<route>/<path>?<query> string from a vscode.Uri's decoded parts, so a handler can read the query with
 * new URL(...).searchParams (Uri.toString() would percent-encode "=" and "&"). Each path segment is percent-encoded again, so
 * every route receives the same encoded form a link string has (decodeCodeRef decodes exactly once, and a decoded "?" or "%"
 * in a file name cannot change the meaning).
 */
export function fromUri(uri: UriLike): string | null {
  if (uri.scheme !== CODEREF_SCHEME || uri.authority.toLowerCase() !== EXTENSION_ID) return null;
  const path = uri.path.replace(/^\/+/, "");
  if (!path) return null;
  return `${CODEREF_SCHEME}://${path.split("/").map(encodeURIComponent).join("/")}${uri.query ? `?${uri.query}` : ""}`;
}

export class UriRouter {
  private readonly routes = new Map<string, UriRouteHandler>();

  /** `prefix` is the first path segment: "auth", "coderef", "session" or "approval". Registering one twice throws. */
  registerRoute(prefix: string, handler: UriRouteHandler): Disposable {
    if (!SEGMENT.test(prefix)) throw new Error(`invalid route prefix: ${prefix}`);
    if (this.routes.has(prefix)) throw new Error(`route already registered: ${prefix}`);
    this.routes.set(prefix, handler);
    return { dispose: () => { this.routes.delete(prefix); } };
  }

  /** Runs the matching route. Unknown or malformed URIs and handler failures are ignored: returns false, never throws. */
  async handle(uri: string | UriLike): Promise<boolean> {
    const normalized = typeof uri === "string" ? normalizeNexusUri(uri) : fromUri(uri);
    if (normalized === null) return false;
    const route = /^[a-z]+:\/\/([a-z0-9-]+)(?:[/?#]|$)/.exec(normalized)?.[1];
    const handler = route === undefined ? undefined : this.routes.get(route);
    if (!handler) return false;
    try {
      return (await handler(normalized)) !== false;
    } catch {
      return false;
    }
  }
}
