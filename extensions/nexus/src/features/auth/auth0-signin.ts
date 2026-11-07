import { createHash, randomBytes } from "node:crypto";
import type { Res } from "../../contracts";
import { redact } from "../../shared/redact";
import type { SecretStore } from "../accounts/accounts-service";

// Auth0 sign-in for the desktop app (PLAN L1-14): Authorization Code + PKCE in the system browser, the callback arriving
// as nexus://auth/callback, only the REFRESH token kept (in SecretStorage), the access token in memory. This is Nexus's
// own identity layer, never a consumer AI login (CLAUDE.md §14). The flow is standard OAuth 2.0 / OIDC with PKCE
// (RFC 7636); the Auth0 specifics (token endpoint path, offline_access for a refresh token, native-app client) are the
// ones the plan names and are confirmed live by smoke L1-S6.

export const AUTH_REDIRECT_URI = "nexus://nexus.nexus/auth/callback";   // VS Code routes a URI to the extension named by its authority (extensionUrlHandler.ts:155), so it is nexus.nexus, not "auth"
export const REFRESH_SECRET_KEY = "nexus.auth0.refresh";
export const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60_000;
const SCOPE = "openid profile offline_access";
const EXPIRY_SKEW_SECONDS = 60;

export interface Auth0Config {
  domain: string;                // "your-tenant.eu.auth0.com", no scheme
  clientId: string;              // the Native application; never a secret
  audience?: string;
}

export interface AuthDeps {
  config(): Auth0Config | undefined;
  secrets: SecretStore;
  openExternal(url: string): Promise<boolean>;
  fetch?: typeof fetch;
  random?: (bytes: number) => Buffer;
  /** Epoch seconds. */
  now?: () => number;
  callbackTimeoutMs?: number;
  log?: (message: string) => void;
}

export type AuthStatus = Res<"auth.status">;

interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  resolve(): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const b64url = (b: Buffer) => b.toString("base64url");

export function challengeFor(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

/** The claims of a JWT, read WITHOUT checking the signature: acceptable only for an id_token received straight from the token endpoint over TLS. */
export function decodeJwtClaims(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return claims && typeof claims === "object" && !Array.isArray(claims) ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export class Auth0Session {
  private pending?: Pending;
  private access?: { token: string; expiresAt: number };
  private identity?: { sub: string; name?: string };

  constructor(private readonly deps: AuthDeps) {}

  status(): AuthStatus {
    return { signedIn: this.identity !== undefined, ...(this.identity ? { auth0UserId: this.identity.sub, ...(this.identity.name ? { name: this.identity.name } : {}) } : {}), slackViaTokenVault: false };
  }

  private cfg(): Auth0Config {
    const c = this.deps.config();
    if (!c?.domain || !c.clientId) throw new Error("Set nexus.auth0.domain and nexus.auth0.clientId in settings before signing in.");
    if (/^https?:\/\//.test(c.domain) || c.domain.includes("/")) throw new Error("nexus.auth0.domain must be a bare host name such as your-tenant.eu.auth0.com.");
    return c;
  }

  private now(): number {
    return this.deps.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /** Opens the browser and resolves once the callback has been exchanged for tokens. One sign-in at a time. */
  async signIn(): Promise<AuthStatus> {
    const cfg = this.cfg();
    if (this.pending) throw new Error("A sign-in is already waiting for the browser.");
    const random = this.deps.random ?? randomBytes;
    const verifier = b64url(random(32));
    const state = b64url(random(16));
    const nonce = b64url(random(16));
    const url = new URL(`https://${cfg.domain}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code", client_id: cfg.clientId, redirect_uri: AUTH_REDIRECT_URI, scope: SCOPE,
      state, nonce, code_challenge: challengeFor(verifier), code_challenge_method: "S256",
      ...(cfg.audience ? { audience: cfg.audience } : {}),
    }).toString();

    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = undefined; reject(new Error("Sign-in timed out waiting for the browser.")); }, this.deps.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS);
      this.pending = { state, nonce, verifier, resolve, reject, timer };
    });
    done.catch(() => undefined);                                  // the caller awaits it below; never an unhandled rejection
    if (!(await this.deps.openExternal(url.toString()))) {
      this.fail(new Error("The browser could not be opened."));
    }
    await done;
    return this.status();
  }

  /** Called with the URI the system browser sent back: nexus://nexus.nexus/auth/callback?code=…&state=… */
  async handleCallback(uri: string): Promise<void> {
    const p = this.pending;
    if (!p) { this.deps.log?.("auth callback with no sign-in waiting; ignored"); return; }
    let params: URLSearchParams;
    try {
      const u = new URL(uri);
      if (u.protocol !== "nexus:" || u.host !== "nexus.nexus" || u.pathname !== "/auth/callback") throw new Error("not the auth callback");
      params = u.searchParams;
    } catch {
      this.deps.log?.("auth callback with an unexpected address; ignored");
      return;                                                     // not ours: leave the real sign-in waiting
    }
    // A mismatched state is rejected and logged WITHOUT the code (CLAUDE.md §14).
    if (params.get("state") !== p.state) { this.deps.log?.("auth callback state mismatch; rejected"); this.fail(new Error("The sign-in response did not match this sign-in (state mismatch).")); return; }
    const err = params.get("error");
    if (err) { this.fail(new Error(`Sign-in was refused: ${redact(params.get("error_description") ?? err).slice(0, 200)}`)); return; }
    const code = params.get("code");
    if (!code) { this.fail(new Error("The sign-in response had no code.")); return; }
    try {
      const tokens = await this.tokenRequest({ grant_type: "authorization_code", code, code_verifier: p.verifier, redirect_uri: AUTH_REDIRECT_URI });
      this.acceptTokens(tokens, p.nonce);
      if (tokens.refresh_token) await this.deps.secrets.store(REFRESH_SECRET_KEY, tokens.refresh_token);
      this.finish();
    } catch (e) {
      this.fail(e instanceof Error ? e : new Error("Sign-in failed."));
    }
  }

  /** At startup: if a refresh token is stored, sign in silently with it. A bad token is dropped. */
  async restore(): Promise<AuthStatus> {
    const refresh = await this.deps.secrets.get(REFRESH_SECRET_KEY);
    if (!refresh || !this.deps.config()) return this.status();
    try {
      this.acceptTokens(await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refresh }));
    } catch (e) {
      if (e instanceof RefreshRejected) await this.deps.secrets.delete(REFRESH_SECRET_KEY);
      this.deps.log?.("could not restore the Auth0 sign-in; sign in again");
    }
    return this.status();
  }

  async signOut(): Promise<void> {
    if (this.pending) this.fail(new Error("Sign-in cancelled."));
    this.access = undefined;
    this.identity = undefined;
    await this.deps.secrets.delete(REFRESH_SECRET_KEY);
  }

  /** A valid access token, refreshed when it is about to expire; undefined when signed out. Never persisted. */
  async accessToken(): Promise<string | undefined> {
    if (!this.identity) return undefined;
    if (this.access && this.access.expiresAt - EXPIRY_SKEW_SECONDS > this.now()) return this.access.token;
    const refresh = await this.deps.secrets.get(REFRESH_SECRET_KEY);
    if (!refresh) return undefined;
    try {
      this.acceptTokens(await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refresh }));
      return this.access?.token;
    } catch (e) {
      if (e instanceof RefreshRejected) { await this.signOut(); }
      return undefined;
    }
  }

  // ---- internals ----

  private finish(): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = undefined;
    p.resolve();
  }

  private fail(e: Error): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = undefined;
    p.reject(e);
  }

  private async tokenRequest(extra: Record<string, string>): Promise<TokenResponse> {
    const cfg = this.cfg();
    const doFetch = this.deps.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`https://${cfg.domain}/oauth/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: cfg.clientId, ...extra }).toString(),
      });
    } catch (e) {
      throw new Error(`Could not reach Auth0: ${redact(e instanceof Error ? e.message : "network error")}`, { cause: e });
    }
    let body: Record<string, unknown> = {};
    try { body = (await res.json()) as Record<string, unknown>; } catch { /* handled below */ }
    if (!res.ok) {
      const why = redact(String(body.error_description ?? body.error ?? res.status)).slice(0, 200);
      if (extra.grant_type === "refresh_token" && (res.status === 400 || res.status === 401 || res.status === 403)) throw new RefreshRejected(why);
      throw new Error(`Auth0 refused the request: ${why}`);
    }
    if (typeof body.access_token !== "string") throw new Error("Auth0 returned no access token.");
    return body as unknown as TokenResponse;
  }

  /** Validates the id_token claims and keeps the access token in memory. */
  private acceptTokens(t: TokenResponse, expectedNonce?: string): void {
    const cfg = this.cfg();
    if (t.id_token) {
      const c = decodeJwtClaims(t.id_token);
      if (!c) throw new Error("Auth0 returned an id_token that could not be read.");
      const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
      if (c.iss !== `https://${cfg.domain}/`) throw new Error("The id_token came from an unexpected issuer.");
      if (!aud.includes(cfg.clientId)) throw new Error("The id_token was issued for a different application.");
      if (typeof c.exp !== "number" || c.exp <= this.now()) throw new Error("The id_token has expired.");
      if (expectedNonce !== undefined && c.nonce !== expectedNonce) throw new Error("The id_token nonce did not match this sign-in.");
      if (typeof c.sub !== "string" || c.sub.length === 0) throw new Error("The id_token has no subject.");
      this.identity = { sub: c.sub, ...(typeof c.name === "string" ? { name: c.name } : typeof c.nickname === "string" ? { name: c.nickname } : {}) };
    } else if (!this.identity) {
      throw new Error("Auth0 returned no id_token, so the user is unknown.");
    }
    this.access = { token: t.access_token, expiresAt: this.now() + (typeof t.expires_in === "number" ? t.expires_in : 3600) };
  }
}

interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

class RefreshRejected extends Error {}

/** The webview-protocol handler this serves; Lane 2's bridge router registers it by name. */
export function authBridgeHandlers(session: Auth0Session) {
  return {
    "auth.status": async (): Promise<Res<"auth.status">> => session.status(),
  };
}
