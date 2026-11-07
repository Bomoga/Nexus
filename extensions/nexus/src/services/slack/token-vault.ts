// Slack user token from Auth0 Token Vault (federated connection access token exchange). vscode-free.
// The token is held in memory only: never written to disk, settings, logs or the event store.
// Error messages are built from our own code and Auth0's `error` field only; response bodies can echo tokens.

export const TOKEN_EXCHANGE_GRANT = "urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token";
export const REFRESH_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:refresh_token";
export const FEDERATED_TOKEN_TYPE = "http://auth0.com/oauth/token-type/federated-connection-access-token";

/** Shortly before expiry the cached token is dropped, so a call never starts with a token about to die. */
const EXPIRY_SKEW_MS = 60_000;
/** Used when Auth0 omits expires_in. */
const DEFAULT_TTL_S = 300;
const MAX_TTL_S = 12 * 3600;

/** A bad or missing configured domain is reported as "unauthorized" (nothing is sent), without echoing the domain. */
export type TokenVaultErrorCode = "not_connected" | "unauthorized" | "unavailable";

export class TokenVaultError extends Error {
  constructor(readonly code: TokenVaultErrorCode, readonly auth0Error?: string) {
    super(`Token Vault: ${code}${auth0Error ? ` (${auth0Error})` : ""}`);
    this.name = "TokenVaultError";
  }
}

export interface TokenVaultConfig { domain: string; clientId: string; slackConnection: string }

export interface TokenVaultDeps {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  config(): TokenVaultConfig | undefined;
  getRefreshToken(): Promise<string | undefined>;
  /** Milliseconds since the epoch. */
  clock(): number;
}

export interface TokenVault {
  getUserToken(): Promise<{ token: string; source: "token_vault" } | null>;
  invalidate(): void;
  /** Where to send the user when Slack is not linked in Auth0 yet; null without config. */
  connectAccountUrl(): string | null;
}

// Auth0 codes that mean the user has not linked Slack (verify live: names come from Auth0's docs/behavior, not a captured response).
const NOT_CONNECTED = new Set([
  "federated_connection_refresh_token_not_found",
  "federated_connection_access_token_not_found",
  "federated_connection_not_found",
  "missing_refresh_token",
]);

/** Keeps only Auth0-style lowercase snake_case codes; anything else (e.g. a token-shaped string) is dropped. */
function safeErrorCode(body: unknown): string | undefined {
  const e = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  return typeof e === "string" && /^[a-z_]{1,64}$/.test(e) ? e : undefined;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** The refresh token is sent to this host, so only a bare lowercase host name is accepted (no userinfo, port, path, query, fragment). */
function validDomain(d: string): boolean {
  if (d.length === 0 || d.length > 253) return false;
  const labels = d.split(".");
  if (labels.length < 2 || !labels.every(l => l.length >= 1 && l.length <= 63 && LABEL.test(l))) return false;
  try {
    const u = new URL(`https://${d}`);
    return u.host === d && u.pathname === "/" && u.search === "" && u.hash === "" && u.username === "" && u.password === "";
  } catch { return false; }
}

const cfgKey = (c: TokenVaultConfig) => `${c.domain}\n${c.clientId}\n${c.slackConnection}`;

export function createTokenVault(deps: TokenVaultDeps): TokenVault {
  let cached: { token: string; expiresAt: number; key: string } | undefined;
  let inflight: { promise: Promise<{ token: string; source: "token_vault" } | null>; key: string } | undefined;
  let generation = 0;                                          // invalidate() during an exchange must not let that result be cached

  async function exchange(cfg: TokenVaultConfig, refresh: string, gen: number): Promise<{ token: string; source: "token_vault" }> {
    let res: Awaited<ReturnType<TokenVaultDeps["fetch"]>>;
    try {
      res = await deps.fetch(new URL("/oauth/token", `https://${cfg.domain}`).toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: TOKEN_EXCHANGE_GRANT,
          client_id: cfg.clientId,
          subject_token: refresh,
          subject_token_type: REFRESH_TOKEN_TYPE,
          connection: cfg.slackConnection,
          requested_token_type: FEDERATED_TOKEN_TYPE,
        }).toString(),
      });
    } catch {
      throw new TokenVaultError("unavailable");
    }
    let body: unknown;
    try { body = await res.json(); } catch { body = undefined; }
    if (!res.ok) {
      const err = safeErrorCode(body);
      if (res.status >= 500 || res.status === 429) throw new TokenVaultError("unavailable", err);
      if (err && NOT_CONNECTED.has(err)) throw new TokenVaultError("not_connected", err);
      if (res.status === 400 || res.status === 401 || res.status === 403) throw new TokenVaultError("unauthorized", err);
      throw new TokenVaultError("unavailable", err);
    }
    const b = (body ?? {}) as { access_token?: unknown; expires_in?: unknown };
    if (typeof b.access_token !== "string" || b.access_token.length === 0) throw new TokenVaultError("unavailable", "no_access_token");
    const ttl = typeof b.expires_in === "number" && Number.isFinite(b.expires_in) && b.expires_in > 0 ? Math.min(b.expires_in, MAX_TTL_S) : DEFAULT_TTL_S;
    if (gen === generation) cached = { token: b.access_token, expiresAt: deps.clock() + ttl * 1000 - EXPIRY_SKEW_MS, key: cfgKey(cfg) };
    return { token: b.access_token, source: "token_vault" };
  }

  return {
    async getUserToken() {
      const cfg = deps.config();
      if (!cfg) return null;
      const key = cfgKey(cfg);
      if (cached && cached.key !== key) cached = undefined;
      if (cached && deps.clock() < cached.expiresAt) return { token: cached.token, source: "token_vault" };
      if (inflight && inflight.key === key) return inflight.promise;
      const gen = generation;
      const run = (async () => {
        let refresh: string | undefined;
        try { refresh = await deps.getRefreshToken(); } catch { throw new TokenVaultError("unavailable", "refresh_token_unreadable"); }
        if (!refresh) return null;
        if (!validDomain(cfg.domain)) throw new TokenVaultError("unauthorized", "invalid_domain");
        return exchange(cfg, refresh, gen);
      })();
      inflight = { promise: run, key };
      try { return await run; } finally { if (inflight?.promise === run) inflight = undefined; }
    },
    invalidate() { cached = undefined; inflight = undefined; generation++; },
    connectAccountUrl() {
      // verify: checked live. Sends the user through Auth0's authorize endpoint with the Slack connection so Auth0 stores a Slack
      // refresh token for them (Connected Accounts). The exact parameters may change once tested against the tenant.
      const cfg = deps.config();
      if (!cfg || !validDomain(cfg.domain)) return null;
      const url = new URL("/authorize", `https://${cfg.domain}`);
      url.search = new URLSearchParams({ client_id: cfg.clientId, response_type: "code", connection: cfg.slackConnection, prompt: "consent" }).toString();
      return url.toString();
    },
  };
}
