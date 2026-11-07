import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeBinding } from "./binding";
import { handle, resetState, type Env } from "./index";
import { DOMAIN, ISS, json, makeKey, mockFetch, nowSec, signJwt, unsignedJwt, type Responder, type TestKey } from "./test-helpers";

const SECRET = "test-secret";
const env: Env = { AUTH0_DOMAIN: DOMAIN, AUTH0_CLIENT_ID: "test-client", AUTH0_CLIENT_SECRET: SECRET };
const JWKS_URL = `https://${DOMAIN}/.well-known/jwks.json`;
const BC_URL = `https://${DOMAIN}/bc-authorize`;
const TOKEN_URL = `https://${DOMAIN}/oauth/token`;

let key: TestKey;
let other: TestKey;
beforeAll(async () => { key = await makeKey("k1"); other = await makeKey("k1"); });
beforeEach(() => resetState());

const goodClaims = (extra: Record<string, unknown> = {}) => ({ iss: ISS, sub: "auth0|caller", aud: "nexus-api", exp: nowSec() + 600, ...extra });
const bearer = async (claims = goodClaims(), k = key) => `Bearer ${await signJwt(k, claims)}`;
const post = (path: string, body: unknown, auth?: string) =>
  new Request(`https://svc.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function setup(extra: Record<string, Responder> = {}) {
  return mockFetch({ [JWKS_URL]: () => json({ keys: [key.jwk] }), ...extra });
}
const startBody = { approvalId: "abcdef1234567890", sessionId: "s1", actionLabel: "run npm test", approverAuth0UserId: "auth0|approver" };
// poll requires the binding that /ciba/start issued to this caller (sub "auth0|caller")
const bound = async (authReqId = "req-1") => ({ authReqId, binding: await makeBinding(SECRET, authReqId, "auth0|caller") });
const bcOk = () => json({ auth_req_id: "req-1", expires_in: 300, interval: 5 });

describe("auth", () => {
  it("accepts a valid token", async () => {
    const m = setup({ [BC_URL]: bcOk });
    const res = await handle(post("/ciba/start", startBody, await bearer()), env, { fetch: m.fn });
    expect(res.status).toBe(200);
  });
  it("rejects a missing token", async () => {
    const m = setup({ [BC_URL]: bcOk });
    const res = await handle(post("/ciba/start", startBody), env, { fetch: m.fn });
    expect(res.status).toBe(401);
    expect(m.calls.some((c) => c.url === BC_URL)).toBe(false);
  });
  it("rejects a bad signature", async () => {
    const m = setup({ [BC_URL]: bcOk });
    const res = await handle(post("/ciba/start", startBody, await bearer(goodClaims(), other)), env, { fetch: m.fn });
    expect(res.status).toBe(401);
  });
  it("rejects an expired token", async () => {
    const m = setup({ [BC_URL]: bcOk });
    const res = await handle(post("/ciba/start", startBody, await bearer(goodClaims({ exp: nowSec() - 10 }))), env, { fetch: m.fn });
    expect(res.status).toBe(401);
  });
  it("rejects the wrong issuer", async () => {
    const m = setup({ [BC_URL]: bcOk });
    const res = await handle(post("/ciba/start", startBody, await bearer(goodClaims({ iss: "https://evil.example/" }))), env, { fetch: m.fn });
    expect(res.status).toBe(401);
  });
  it("checks aud only when AUTH0_AUDIENCE is set", async () => {
    const m = setup({ [BC_URL]: bcOk });
    const withAud = { ...env, AUTH0_AUDIENCE: "nexus-api" };
    expect((await handle(post("/ciba/start", startBody, await bearer(goodClaims({ aud: "other" }))), withAud, { fetch: m.fn })).status).toBe(401);
    resetState();
    expect((await handle(post("/ciba/start", startBody, await bearer(goodClaims({ aud: ["x", "nexus-api"] }))), withAud, { fetch: m.fn })).status).toBe(200);
    resetState();
    expect((await handle(post("/ciba/start", startBody, await bearer(goodClaims({ aud: "anything" }))), env, { fetch: m.fn })).status).toBe(200);
  });
  it("rejects alg none and non-bearer headers", async () => {
    const m = setup({ [BC_URL]: bcOk });
    expect((await handle(post("/ciba/start", startBody, `Bearer ${unsignedJwt(goodClaims())}`), env, { fetch: m.fn })).status).toBe(401);
    expect((await handle(post("/ciba/start", startBody, "Basic abc"), env, { fetch: m.fn })).status).toBe(401);
  });
  it("caches the JWKS", async () => {
    const m = setup({ [BC_URL]: bcOk });
    await handle(post("/ciba/start", startBody, await bearer()), env, { fetch: m.fn });
    await handle(post("/ciba/start", { ...startBody, approvalId: "zzzzzzzz1" }, await bearer()), env, { fetch: m.fn });
    expect(m.calls.filter((c) => c.url === JWKS_URL)).toHaveLength(1);
  });
  it("requires a valid token on poll too", async () => {
    const m = setup({ [TOKEN_URL]: () => json({}) });
    const res = await handle(post("/ciba/poll", { authReqId: "req-1" }), env, { fetch: m.fn });
    expect(res.status).toBe(401);
  });
});

describe("/ciba/start", () => {
  it("sends the exact bc-authorize form and returns the ids", async () => {
    const m = setup({ [BC_URL]: bcOk });
    const res = await handle(post("/ciba/start", startBody, await bearer()), env, { fetch: m.fn });
    expect(await res.json()).toEqual({ authReqId: "req-1", binding: (await bound()).binding, expiresIn: 300, interval: 5 });
    const call = m.calls.find((c) => c.url === BC_URL)!;
    expect(call.method).toBe("POST");
    expect(call.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    const form = new URLSearchParams(call.body);
    expect(Object.fromEntries(form)).toEqual({
      client_id: "test-client",
      client_secret: SECRET,
      scope: "openid",
      login_hint: JSON.stringify({ format: "iss_sub", iss: ISS, sub: "auth0|approver" }),
      binding_message: "NX abcdef12 run npm test",
      request_expiry: "300",
    });
  });
  it("sanitizes and caps the binding message", async () => {
    const m = setup({ [BC_URL]: bcOk });
    await handle(post("/ciba/start", { ...startBody, actionLabel: "rm -rf /*; <b>\"x\"</b> ok\n" }, await bearer()), env, { fetch: m.fn });
    const bm = new URLSearchParams(m.calls.find((c) => c.url === BC_URL)!.body).get("binding_message")!;
    expect(bm).toMatch(/^[A-Za-z0-9 +\-_.,:#]+$/);
    expect(bm.startsWith("NX abcdef12 ")).toBe(true);
    expect(bm.length).toBeLessThanOrEqual(64);
    resetState();
    await handle(post("/ciba/start", { ...startBody, approvalId: "a".repeat(100), actionLabel: "x".repeat(500) }, await bearer()), env, { fetch: m.fn });
    const bm2 = new URLSearchParams(m.calls.filter((c) => c.url === BC_URL)[1]!.body).get("binding_message")!;
    expect(bm2).toBe(`NX aaaaaaaa ${"x".repeat(20)}`);
    expect(bm2.length).toBeLessThanOrEqual(64);
  });
  it("never starts two requests for one approval", async () => {
    const m = setup({ [BC_URL]: bcOk });
    const a = await handle(post("/ciba/start", startBody, await bearer()), env, { fetch: m.fn });
    const b = await handle(post("/ciba/start", startBody, await bearer()), env, { fetch: m.fn });
    expect(((await a.json()) as { authReqId: string }).authReqId).toBe("req-1");
    expect(((await b.json()) as { authReqId: string }).authReqId).toBe("req-1");
    expect(m.calls.filter((c) => c.url === BC_URL)).toHaveLength(1);
  });
  it("passes an Auth0 429 through with a clear message", async () => {
    const m = setup({ [BC_URL]: () => json({ error: "too_many_requests", error_description: "slow" }, 429) });
    const res = await handle(post("/ciba/start", startBody, await bearer()), env, { fetch: m.fn });
    expect(res.status).toBe(429);
    expect(JSON.stringify(await res.json())).toMatch(/5 .*per minute|rate/i);
    // a failed start must not poison the guard
    const m2 = setup({ [BC_URL]: bcOk });
    expect((await handle(post("/ciba/start", startBody, await bearer()), env, { fetch: m2.fn })).status).toBe(200);
  });
  it("maps other Auth0 failures to 502 without leaking details", async () => {
    const m = setup({ [BC_URL]: () => json({ error: "invalid_request", error_description: `bad client_secret=${SECRET}` }, 400) });
    const res = await handle(post("/ciba/start", startBody, await bearer()), env, { fetch: m.fn });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(SECRET);
  });
  it("rejects bad bodies with 400", async () => {
    const m = setup({ [BC_URL]: bcOk });
    const auth = await bearer();
    for (const body of ["not json", {}, { ...startBody, approvalId: "" }, { ...startBody, approverAuth0UserId: 5 }, { ...startBody, extra: 1 }]) {
      const res = await handle(post("/ciba/start", body, auth), env, { fetch: m.fn });
      expect(res.status).toBe(400);
    }
    expect(m.calls.some((c) => c.url === BC_URL)).toBe(false);
  });
});

describe("/ciba/poll", () => {
  const poll = async (responder: Responder) => {
    const m = setup({ [TOKEN_URL]: responder });
    const res = await handle(post("/ciba/poll", await bound(), await bearer()), env, { fetch: m.fn });
    return { res, m, body: (await res.json()) as Record<string, unknown> };
  };

  it("sends the CIBA grant form", async () => {
    const { m } = await poll(() => json({ error: "authorization_pending" }, 400));
    const call = m.calls.find((c) => c.url === TOKEN_URL)!;
    expect(call.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(call.body))).toEqual({
      grant_type: "urn:openid:params:grant-type:ciba",
      auth_req_id: "req-1",
      client_id: "test-client",
      client_secret: SECRET,
    });
  });
  it("maps authorization_pending to pending", async () => {
    const { res, body } = await poll(() => json({ error: "authorization_pending" }, 400));
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "pending" });
  });
  it("maps slow_down to pending with a bumped Retry-After", async () => {
    const m = setup({ [TOKEN_URL]: () => json({ error: "slow_down" }, 400) });
    const auth = await bearer();
    const r1 = await handle(post("/ciba/poll", await bound(), auth), env, { fetch: m.fn });
    expect(await r1.json()).toEqual({ status: "pending", retryAfter: 10 });
    expect(r1.headers.get("Retry-After")).toBe("10");
    const r2 = await handle(post("/ciba/poll", await bound(), auth), env, { fetch: m.fn });
    expect(r2.headers.get("Retry-After")).toBe("15");
  });
  it("maps access_denied to rejected and expired_token to expired", async () => {
    expect((await poll(() => json({ error: "access_denied" }, 400))).body).toEqual({ status: "rejected" });
    expect((await poll(() => json({ error: "expired_token" }, 400))).body).toEqual({ status: "expired" });
  });
  it("maps success to approved with the sub from the id_token, never returning tokens", async () => {
    const idToken = unsignedJwt({ iss: ISS, sub: "auth0|approver" });
    const { res, body } = await poll(() => json({ access_token: "AT-secret", id_token: idToken, token_type: "Bearer", expires_in: 86400 }));
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "approved", auth0UserId: "auth0|approver" });
    expect(JSON.stringify(body)).not.toContain("AT-secret");
    expect(JSON.stringify(body)).not.toContain(idToken);
  });
  it("fails closed when success has no usable id_token", async () => {
    const { res } = await poll(() => json({ access_token: "AT", token_type: "Bearer" }));
    expect(res.status).toBe(502);
  });
  it("passes an Auth0 429 through", async () => {
    const { res } = await poll(() => json({ error: "too_many_requests" }, 429));
    expect(res.status).toBe(429);
  });
  it("maps unknown Auth0 errors to 502", async () => {
    const { res, body } = await poll(() => json({ error: "invalid_grant", error_description: `secret ${SECRET}` }, 403));
    expect(res.status).toBe(502);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
  it("rejects bad bodies with 400", async () => {
    const m = setup({ [TOKEN_URL]: () => json({}) });
    const auth = await bearer();
    for (const body of [{}, { authReqId: "" }, "nope", { ...(await bound()), more: true }, { ...(await bound()), binding: 5 }]) {
      expect((await handle(post("/ciba/poll", body, auth), env, { fetch: m.fn })).status).toBe(400);
    }
  });
});

describe("routing and safety", () => {
  it("404s unknown paths and 405s wrong methods", async () => {
    const m = setup();
    expect((await handle(post("/nope", {}, await bearer()), env, { fetch: m.fn })).status).toBe(404);
    expect((await handle(new Request("https://svc.test/ciba/start"), env, { fetch: m.fn })).status).toBe(405);
    expect((await handle(new Request("https://svc.test/ciba/poll", { method: "PUT" }), env, { fetch: m.fn })).status).toBe(405);
  });
  it("returns 500 without values when misconfigured", async () => {
    const m = setup();
    const res = await handle(post("/ciba/start", startBody, await bearer()), { ...env, AUTH0_CLIENT_SECRET: "" }, { fetch: m.fn });
    expect(res.status).toBe(500);
  });
  it("turns a thrown fetch error into a sanitized 502 with no secret", async () => {
    const m = setup({ [BC_URL]: () => { throw new Error(`boom client_secret=${SECRET}`); } });
    const res = await handle(post("/ciba/start", startBody, await bearer()), env, { fetch: m.fn });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(SECRET);
  });
});
