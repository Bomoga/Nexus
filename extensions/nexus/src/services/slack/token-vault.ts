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

/** Keeps only a short, token-free identifier from Auth0's `error` field. */
function safeErrorCode(body: unknown): string | undefined {
  const e = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  return typeof e === "string" && /^[a-z0-9_.-]{1,64}$/i.test(e) ? e : undefined;
}

export function createTokenVault(deps: TokenVaultDeps): TokenVault {
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<{ token: string; source: "token_vault" } | null> | undefined;
  let generation = 0;                                          // invalidate() during an exchange must not let that result be cached

  async function exchange(cfg: TokenVaultConfig, refresh: string, gen: number): Promise<{ token: string; source: "token_vault" }> {
    let res: Awaited<ReturnType<TokenVaultDeps["fetch"]>>;
    try {
      res = await deps.fetch(`https://${cfg.domain}/oauth/token`, {
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
    const ttl = typeof b.expires_in === "number" && b.expires_in > 0 ? b.expires_in : DEFAULT_TTL_S;
    if (gen === generation) cached = { token: b.access_token, expiresAt: deps.clock() + ttl * 1000 - EXPIRY_SKEW_MS };
    return { token: b.access_token, source: "token_vault" };
  }

  return {
    async getUserToken() {
      if (cached && deps.clock() < cached.expiresAt) return { token: cached.token, source: "token_vault" };
      if (inflight) return inflight;
      const cfg = deps.config();
      if (!cfg) return null;
      const gen = generation;
      const run = (async () => {
        const refresh = await deps.getRefreshToken();
        if (!refresh) return null;
        return exchange(cfg, refresh, gen);
      })();
      inflight = run;
      try { return await run; } finally { if (inflight === run) inflight = undefined; }
    },
    invalidate() { cached = undefined; generation++; },
    connectAccountUrl() {
      // verify: checked live. Sends the user through Auth0's authorize endpoint with the Slack connection so Auth0 stores a Slack
      // refresh token for them (Connected Accounts). The exact parameters may change once tested against the tenant.
      const cfg = deps.config();
      if (!cfg) return null;
      const url = new URL(`https://${cfg.domain}/authorize`);
      url.search = new URLSearchParams({ client_id: cfg.clientId, response_type: "code", connection: cfg.slackConnection, prompt: "consent" }).toString();
      return url.toString();
    },
  };
}
