import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Requests } from "../../contracts";
import type { SecretStore } from "../accounts/accounts-service";
import { AUTH_REDIRECT_URI, Auth0Session, REFRESH_SECRET_KEY, authBridgeHandlers, challengeFor, decodeJwtClaims, type Auth0Config } from "./auth0-signin";

const DOMAIN = "nexus-demo.eu.auth0.com";
const CLIENT_ID = "native-client-id";
const CONFIG: Auth0Config = { domain: DOMAIN, clientId: CLIENT_ID, audience: "https://api.nexus.example" };
const NOW = 1_800_000_000;
const SECRET_CODE = "very-secret-auth-code-123";

const jwt = (claims: Record<string, unknown>) => `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const claims = (over: Record<string, unknown> = {}) => ({ iss: `https://${DOMAIN}/`, aud: CLIENT_ID, sub: "auth0|adrian", name: "Adrian", exp: NOW + 3600, ...over });

function memSecrets(initial: Record<string, string> = {}): SecretStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return { map, get: async k => map.get(k), store: async (k, v) => { map.set(k, v); }, delete: async k => { map.delete(k); } };
}

interface Req { url: string; body: URLSearchParams }

function setup(opts: { config?: Auth0Config | undefined; secrets?: Record<string, string>; callbackTimeoutMs?: number; openOk?: boolean } = {}) {
  const secrets = memSecrets(opts.secrets);
  const opened: string[] = [];
  const requests: Req[] = [];
  const logs: string[] = [];
  const now = { value: NOW };
  // The fake Auth0: what each grant returns can be changed per test, and the code grant echoes the nonce under test.
  const ctx = {
    nonce: "",
    idClaims: {} as Record<string, unknown>,
    omitNonce: false,
    refreshToken: "RT-secret" as string | undefined,
    refreshResponse: undefined as Response | (() => Response | Promise<Response>) | undefined,
    codeResponse: undefined as Response | undefined,
  };
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const r: Req = { url: String(url), body: new URLSearchParams(String(init?.body)) };
    requests.push(r);
    if (r.body.get("grant_type") === "refresh_token") {
      if (ctx.refreshResponse) return typeof ctx.refreshResponse === "function" ? ctx.refreshResponse() : ctx.refreshResponse;
      return new Response(JSON.stringify({ access_token: `AT-refreshed-${requests.length}`, expires_in: 3600, id_token: jwt(claims(ctx.idClaims)) }), { status: 200 });
    }
    if (ctx.codeResponse) return ctx.codeResponse;
    return new Response(JSON.stringify({ access_token: "AT-secret", expires_in: 3600, ...(ctx.refreshToken ? { refresh_token: ctx.refreshToken } : {}), id_token: jwt(claims({ ...(ctx.omitNonce ? {} : { nonce: ctx.nonce }), ...ctx.idClaims })) }), { status: 200 });
  }) as typeof fetch;
  let counter = 0;
  const session = new Auth0Session({
    config: () => ("config" in opts ? opts.config : CONFIG), secrets, fetch: f, now: () => now.value, callbackTimeoutMs: opts.callbackTimeoutMs, log: m => logs.push(m),
    random: n => Buffer.alloc(n, ++counter),
    openExternal: async url => { opened.push(url); return opts.openOk ?? true; },
  });
  return { session, secrets, opened, requests, logs, ctx, now };
}

/** Starts a sign-in and returns what the browser was sent to. The promise's rejection is observed by the caller. */
async function begin(s: ReturnType<typeof setup>) {
  const done = s.session.signIn();
  done.catch(() => undefined);
  await vi.waitFor(() => expect(s.opened.length).toBeGreaterThan(0));
  const url = new URL(s.opened.at(-1)!);
  s.ctx.nonce = url.searchParams.get("nonce")!;
  return { done, url, state: url.searchParams.get("state")! };
}

describe("signing in", () => {
  it("opens the system browser at Auth0 with PKCE S256, state, nonce, offline_access and the nexus:// redirect", async () => {
    const s = setup();
    const { url, done } = await begin(s);
    expect(url.origin + url.pathname).toBe(`https://${DOMAIN}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: AUTH_REDIRECT_URI, scope: "openid profile offline_access",
      code_challenge_method: "S256", audience: "https://api.nexus.example",
    });
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set([url.searchParams.get("state"), url.searchParams.get("nonce"), url.searchParams.get("code_challenge")]).size).toBe(3);
    await s.session.signOut();
    await expect(done).rejects.toThrow("cancelled");
  });

  it("completes the loop: exchanges the code with the matching verifier, keeps only the refresh token, and reports who signed in", async () => {
    const s = setup();
    const { done, url, state } = await begin(s);
    await s.session.handleCallback(`${AUTH_REDIRECT_URI}?code=${SECRET_CODE}&state=${state}`);
    expect(await done).toEqual({ signedIn: true, auth0UserId: "auth0|adrian", name: "Adrian", slackViaTokenVault: false });
    const req = s.requests[0];
    expect(req.url).toBe(`https://${DOMAIN}/oauth/token`);
    const verifier = req.body.get("code_verifier")!;
    expect(Object.fromEntries(req.body)).toEqual({ client_id: CLIENT_ID, grant_type: "authorization_code", code: SECRET_CODE, code_verifier: verifier, redirect_uri: AUTH_REDIRECT_URI });
    expect(challengeFor(verifier)).toBe(url.searchParams.get("code_challenge"));          // the verifier proves the challenge sent to the browser
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
    expect([...s.secrets.map.entries()]).toEqual([[REFRESH_SECRET_KEY, "RT-secret"]]);   // no access token, id token or code is persisted
    expect(await s.session.accessToken()).toBe("AT-secret");
    expect(s.session.status().signedIn).toBe(true);
  });

  it("accepts the callback in the form Lane 2's UriRouter hands over (nexus://auth/callback)", async () => {
    const s = setup();
    const { done, state } = await begin(s);
    await s.session.handleCallback(`nexus://auth/callback?code=c&state=${state}`);
    expect((await done).signedIn).toBe(true);
  });

  it("still signs in when Auth0 issues no refresh token, and stores nothing", async () => {
    const s = setup();
    s.ctx.refreshToken = undefined;
    const { done, state } = await begin(s);
    await s.session.handleCallback(`${AUTH_REDIRECT_URI}?code=c&state=${state}`);
    expect((await done).signedIn).toBe(true);
    expect(s.secrets.map.size).toBe(0);
  });

  it("rejects a state mismatch without exchanging anything or logging the code", async () => {
    const s = setup();
    const { done } = await begin(s);
    await s.session.handleCallback(`${AUTH_REDIRECT_URI}?code=${SECRET_CODE}&state=forged`);
    await expect(done).rejects.toThrow("state mismatch");
    expect(s.requests).toEqual([]);
    expect(s.logs.join("\n")).not.toContain(SECRET_CODE);
    expect(s.session.status().signedIn).toBe(false);
  });

  it("reports a refusal from Auth0 (the user said no) clearly", async () => {
    const s = setup();
    const { done, state } = await begin(s);
    await s.session.handleCallback(`${AUTH_REDIRECT_URI}?error=access_denied&error_description=User%20declined&state=${state}`);
    await expect(done).rejects.toThrow("Sign-in was refused: User declined");
    expect(s.requests).toEqual([]);
  });

  it("ignores a callback that is not the auth callback and keeps waiting, then times out", async () => {
    const s = setup({ callbackTimeoutMs: 40 });
    const { done, state } = await begin(s);
    await s.session.handleCallback(`nexus://coderef/ws/aaa/1-2/a.ts?state=${state}`);
    await s.session.handleCallback("https://evil.example/auth/callback?code=x&state=" + state);
    await s.session.handleCallback("not a url");
    expect(s.requests).toEqual([]);
    await expect(done).rejects.toThrow("timed out");
  });

  it("ignores a callback when no sign-in is waiting", async () => {
    const s = setup();
    await s.session.handleCallback(`${AUTH_REDIRECT_URI}?code=x&state=y`);
    expect(s.requests).toEqual([]);
    expect(s.logs.join("\n")).toMatch(/no sign-in waiting/);
  });

  it.each([
    ["a different issuer", { iss: "https://evil.example/" }, /unexpected issuer/],
    ["another application's audience", { aud: "someone-else" }, /different application/],
    ["an expired id_token", { exp: NOW - 1 }, /expired/],
    ["a replayed nonce", { nonce: "someone-elses-nonce" }, /nonce did not match/],
    ["no subject", { sub: "" }, /no subject/],
  ])("refuses %s and signs nobody in", async (_n, over, message) => {
    const s = setup();
    s.ctx.idClaims = over;
    const { done, state } = await begin(s);
    await s.session.handleCallback(`${AUTH_REDIRECT_URI}?code=c&state=${state}`);
    await expect(done).rejects.toThrow(message);
    expect(s.session.status().signedIn).toBe(false);
    expect(s.secrets.map.size).toBe(0);                                                  // nothing stored for a rejected login
    expect(await s.session.accessToken()).toBeUndefined();
  });

  it("refuses an id_token with no nonce, an unreadable id_token, and a response with no access token", async () => {
    const noNonce = setup();
    noNonce.ctx.omitNonce = true;
    const a = await begin(noNonce);
    await noNonce.session.handleCallback(`${AUTH_REDIRECT_URI}?code=c&state=${a.state}`);
    await expect(a.done).rejects.toThrow("nonce did not match");

    const garbled = setup();
    const b = await begin(garbled);
    garbled.ctx.codeResponse = new Response(JSON.stringify({ access_token: "x", id_token: "not.a.jwt!" }), { status: 200 });
    await garbled.session.handleCallback(`${AUTH_REDIRECT_URI}?code=c&state=${b.state}`);
    await expect(b.done).rejects.toThrow("could not be read");

    const noAccess = setup();
    const c = await begin(noAccess);
    noAccess.ctx.codeResponse = new Response(JSON.stringify({ id_token: "x" }), { status: 200 });
    await noAccess.session.handleCallback(`${AUTH_REDIRECT_URI}?code=c&state=${c.state}`);
    await expect(c.done).rejects.toThrow("no access token");
  });

  it("reports an Auth0 error response without leaking secrets", async () => {
    const s = setup();
    const { done, state } = await begin(s);
    s.ctx.codeResponse = new Response(JSON.stringify({ error: "invalid_grant", error_description: "bad code sk-ant-api03-SECRETSECRETSECRET1234567890" }), { status: 403 });
    await s.session.handleCallback(`${AUTH_REDIRECT_URI}?code=c&state=${state}`);
    await expect(done).rejects.toThrow("Auth0 refused the request");
    await done.catch((e: Error) => expect(e.message).not.toContain("SECRETSECRET"));
  });

  it("explains missing or malformed settings before opening any browser", async () => {
    for (const config of [undefined, { domain: "", clientId: "x" }, { domain: "https://t.auth0.com", clientId: "x" }, { domain: "t.auth0.com/path", clientId: "x" }]) {
      const s = setup({ config: config as Auth0Config | undefined });
      await expect(s.session.signIn()).rejects.toThrow(/nexus\.auth0\.(domain|clientId)|bare host name/);
      expect(s.opened).toEqual([]);
    }
  });

  it("allows one sign-in at a time, and fails cleanly if the browser cannot open", async () => {
    const s = setup();
    const { done } = await begin(s);
    await expect(s.session.signIn()).rejects.toThrow("already waiting");
    await s.session.signOut();
    await expect(done).rejects.toThrow("cancelled");
    const noBrowser = setup({ openOk: false });
    await expect(noBrowser.session.signIn()).rejects.toThrow("browser could not be opened");
    await expect(noBrowser.session.signIn()).rejects.toThrow("browser could not be opened");       // and it is not stuck "waiting"
  });
});

describe("restoring, refreshing and signing out", () => {
  it("restore() signs in silently from the stored refresh token", async () => {
    const s = setup({ secrets: { [REFRESH_SECRET_KEY]: "RT-old" } });
    const status = await s.session.restore();
    expect(status).toMatchObject({ signedIn: true, auth0UserId: "auth0|adrian" });
    expect(Object.fromEntries(s.requests[0].body)).toEqual({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: "RT-old" });
    expect(await s.session.accessToken()).toMatch(/^AT-refreshed/);
  });

  it("restore() drops a refresh token Auth0 rejects, but keeps one when Auth0 simply cannot be reached", async () => {
    const rejected = setup({ secrets: { [REFRESH_SECRET_KEY]: "RT-revoked" } });
    rejected.ctx.refreshResponse = new Response(JSON.stringify({ error: "invalid_grant" }), { status: 403 });
    expect((await rejected.session.restore()).signedIn).toBe(false);
    expect(rejected.secrets.map.has(REFRESH_SECRET_KEY)).toBe(false);

    const offline = setup({ secrets: { [REFRESH_SECRET_KEY]: "RT-ok" } });
    offline.ctx.refreshResponse = () => { throw new Error("ENOTFOUND"); };
    expect((await offline.session.restore()).signedIn).toBe(false);
    expect(offline.secrets.map.get(REFRESH_SECRET_KEY)).toBe("RT-ok");
  });

  it("restore() does nothing without a stored token or settings", async () => {
    expect((await setup().session.restore()).signedIn).toBe(false);
    const noCfg = setup({ config: undefined, secrets: { [REFRESH_SECRET_KEY]: "RT" } });
    expect((await noCfg.session.restore()).signedIn).toBe(false);
    expect(noCfg.requests).toEqual([]);
  });

  it("accessToken() reuses a fresh token and refreshes one that is about to expire; a revoked refresh signs out", async () => {
    const s = setup({ secrets: { [REFRESH_SECRET_KEY]: "RT" } });
    await s.session.restore();
    const first = await s.session.accessToken();
    expect(await s.session.accessToken()).toBe(first);
    expect(s.requests).toHaveLength(1);                                                   // cached
    s.now.value += 3600 - 30;                                                             // inside the 60 s expiry skew
    const second = await s.session.accessToken();
    expect(second).not.toBe(first);
    expect(s.requests).toHaveLength(2);
    s.now.value += 3600;
    s.ctx.refreshResponse = new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    expect(await s.session.accessToken()).toBeUndefined();
    expect(s.session.status().signedIn).toBe(false);
    expect(s.secrets.map.has(REFRESH_SECRET_KEY)).toBe(false);
  });

  it("signOut() clears the memory and the stored token", async () => {
    const s = setup({ secrets: { [REFRESH_SECRET_KEY]: "RT" } });
    await s.session.restore();
    await s.session.signOut();
    expect(s.session.status()).toEqual({ signedIn: false, slackViaTokenVault: false });
    expect(s.secrets.map.size).toBe(0);
    expect(await s.session.accessToken()).toBeUndefined();
  });

  it("serves auth.status with a contract-shaped response", async () => {
    const s = setup();
    Requests["auth.status"].res.parse(await authBridgeHandlers(s.session)["auth.status"]());
  });
});

describe("decodeJwtClaims", () => {
  it("reads the payload of a well-formed token and refuses anything else", () => {
    expect(decodeJwtClaims(jwt({ a: 1 }))).toEqual({ a: 1 });
    for (const bad of ["", "a.b", "a.b.c.d", "a.!!!.c", `a.${Buffer.from("[1]").toString("base64url")}.c`, `a.${Buffer.from("null").toString("base64url")}.c`]) expect(decodeJwtClaims(bad)).toBeUndefined();
  });
});
