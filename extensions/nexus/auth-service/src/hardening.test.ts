import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handle, resetState, type Env } from "./index";
import { DOMAIN, ISS, json, makeKey, mockFetch, nowSec, rawToken, signJwt, unsignedJwt, type Responder, type TestKey } from "./test-helpers";

const env: Env = { AUTH0_DOMAIN: DOMAIN, AUTH0_CLIENT_ID: "test-client", AUTH0_CLIENT_SECRET: "test-secret" };
const JWKS_URL = `https://${DOMAIN}/.well-known/jwks.json`;
const BC_URL = `https://${DOMAIN}/bc-authorize`;
const TOKEN_URL = `https://${DOMAIN}/oauth/token`;

let k1: TestKey;
let k2: TestKey;
beforeAll(async () => { k1 = await makeKey("k1"); k2 = await makeKey("k2"); });
beforeEach(() => resetState());

const claims = (extra: Record<string, unknown> = {}) => ({ iss: ISS, sub: "auth0|caller", aud: "nexus-api", exp: nowSec() + 600, ...extra });
const post = (path: string, body: unknown, auth?: string) =>
  new Request(`https://svc.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
const startBody = { approvalId: "abcdef1234567890", sessionId: "s1", actionLabel: "run npm test", approverAuth0UserId: "auth0|approver" };
const bcOk = () => json({ auth_req_id: "req-1", expires_in: 300, interval: 5 });
const bearer = async (k: TestKey, c: Record<string, unknown> = claims(), header: Record<string, unknown> = {}) => `Bearer ${await signJwt(k, c, header)}`;

function setup(keys: () => TestKey[], extra: Record<string, Responder> = {}) {
  return mockFetch({ [JWKS_URL]: () => json({ keys: keys().map((k) => k.jwk) }), ...extra });
}
const status = async (auth: string, m: ReturnType<typeof setup>, now?: number) =>
  (await handle(post("/ciba/start", startBody, auth), env, { fetch: m.fn, ...(now ? { now: () => now } : {}) })).status;
const jwksFetches = (m: ReturnType<typeof setup>) => m.calls.filter((c) => c.url === JWKS_URL).length;

describe("concurrent starts", () => {
  it("calls bc-authorize exactly once for two simultaneous starts", async () => {
    const m = setup(() => [k1], { [BC_URL]: async () => { await new Promise((r) => setTimeout(r, 20)); return bcOk(); } });
    const auth = await bearer(k1);
    const [a, b] = await Promise.all([
      handle(post("/ciba/start", startBody, auth), env, { fetch: m.fn }),
      handle(post("/ciba/start", startBody, auth), env, { fetch: m.fn }),
    ]);
    expect(m.calls.filter((c) => c.url === BC_URL)).toHaveLength(1);
    expect(((await a.json()) as { authReqId: string }).authReqId).toBe("req-1");
    expect(((await b.json()) as { authReqId: string }).authReqId).toBe("req-1");
  });
  it("lets a retry through after a concurrent failure", async () => {
    let fail = true;
    const m = setup(() => [k1], { [BC_URL]: async () => { await new Promise((r) => setTimeout(r, 10)); return fail ? json({ error: "x" }, 400) : bcOk(); } });
    const auth = await bearer(k1);
    const rs = await Promise.all([1, 2].map(() => handle(post("/ciba/start", startBody, auth), env, { fetch: m.fn })));
    expect(rs.map((r) => r.status)).toEqual([502, 502]);
    expect(m.calls.filter((c) => c.url === BC_URL)).toHaveLength(1);
    fail = false;
    expect((await handle(post("/ciba/start", startBody, auth), env, { fetch: m.fn })).status).toBe(200);
  });
  it("expires the cached entry after expiresIn so a new start is allowed", async () => {
    const m = setup(() => [k1], { [BC_URL]: bcOk });
    const auth = await bearer(k1);
    const t0 = Date.now();
    expect(await status(auth, m, t0)).toBe(200);
    expect(await status(auth, m, t0 + 100_000)).toBe(200);
    expect(m.calls.filter((c) => c.url === BC_URL)).toHaveLength(1);
    expect(await status(auth, m, t0 + 301_000)).toBe(200);
    expect(m.calls.filter((c) => c.url === BC_URL)).toHaveLength(2);
  });
});

describe("concurrent starts after expiry", () => {
  it("starts one new request, not two, when two callers find the same expired entry", async () => {
    const m = setup(() => [k1], { [BC_URL]: async () => { await new Promise((r) => setTimeout(r, 10)); return bcOk(); } });
    const auth = await bearer(k1);
    const t0 = Date.now();
    expect(await status(auth, m, t0)).toBe(200);
    const later = t0 + 301_000;
    const rs = await Promise.all([1, 2, 3].map(() => handle(post("/ciba/start", startBody, auth), env, { fetch: m.fn, now: () => later })));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(m.calls.filter((c) => c.url === BC_URL)).toHaveLength(2);   // the first start plus exactly one restart
  });
});

describe("JWKS refetch limits", () => {
  it("refetches at most once per 30s for unknown kids and rejects them", async () => {
    const m = setup(() => [k1], { [BC_URL]: bcOk });
    const t0 = Date.now();
    expect(await status(await bearer(k1), m, t0)).toBe(200);          // primes the cache: 1 fetch
    const ghost = { ...k1, kid: "ghost" };
    for (let i = 0; i < 3; i++) expect(await status(await bearer(ghost), m, t0 + i * 1000)).toBe(401);
    expect(jwksFetches(m)).toBe(2);                                    // one forced refetch, not three
    expect(await status(await bearer(ghost), m, t0 + 31_000)).toBe(401);
    expect(jwksFetches(m)).toBe(3);
  });
  it("accepts a rotated kid after one refetch", async () => {
    let keys = [k1];
    const m = setup(() => keys, { [BC_URL]: bcOk });
    expect(await status(await bearer(k1), m)).toBe(200);
    keys = [k1, k2];
    expect(await status(await bearer(k2), m)).toBe(200);
    expect(jwksFetches(m)).toBe(2);
  });
  it("rejects a kid longer than 128 characters without fetching", async () => {
    const m = setup(() => [k1], { [BC_URL]: bcOk });
    expect(await status(await bearer(k1, claims(), { kid: "k".repeat(129) }), m)).toBe(401);
    expect(jwksFetches(m)).toBe(0);
  });
});

describe("malformed tokens", () => {
  const m = () => setup(() => [k1], { [BC_URL]: bcOk });
  it("401 for a signature segment of length mod 4 equal 1", async () => {
    expect(await status(`Bearer ${rawToken({ alg: "RS256", kid: "k1" }, claims(), "abcde")}`, m())).toBe(401);
  });
  it("401 for a header that decodes to null", async () => {
    expect(await status(`Bearer ${rawToken(null, claims())}`, m())).toBe(401);
  });
  it("401 for HS256 and alg none even with a kid", async () => {
    expect(await status(`Bearer ${rawToken({ alg: "HS256", kid: "k1" }, claims())}`, m())).toBe(401);
    expect(await status(`Bearer ${rawToken({ alg: "none", kid: "k1" }, claims())}`, m())).toBe(401);
  });
  it("401 for a token with no kid", async () => {
    expect(await status(await bearer(k1, claims(), { kid: undefined }), m())).toBe(401);
  });
  it("401 for a future nbf", async () => {
    expect(await status(await bearer(k1, claims({ nbf: nowSec() + 3600 })), m())).toBe(401);
  });
  it("401 for a wrong or missing iss with a valid exp", async () => {
    expect(await status(await bearer(k1, claims({ iss: "https://other.example/" })), m())).toBe(401);
    const noIss: Record<string, unknown> = { ...claims() };
    delete noIss.iss;
    expect(await status(await bearer(k1, noIss), m())).toBe(401);
  });
});

describe("poll with an unusable id_token", () => {
  const approvedWith = async (idToken: string) => {
    const m = setup(() => [k1], { [TOKEN_URL]: () => json({ access_token: "AT-secret", id_token: idToken }) });
    const res = await handle(post("/ciba/poll", { authReqId: "req-1" }, await bearer(k1)), env, { fetch: m.fn });
    return { res, text: await res.text(), idToken };
  };
  it("502 when the id_token has no sub", async () => {
    const r = await approvedWith(unsignedJwt({ iss: ISS }));
    expect(r.res.status).toBe(502);
    expect(r.text).not.toContain("AT-secret");
    expect(r.text).not.toContain(r.idToken);
  });
  it("502 when the sub is not a string", async () => {
    const r = await approvedWith(unsignedJwt({ iss: ISS, sub: 5 }));
    expect(r.res.status).toBe(502);
    expect(r.text).not.toContain("AT-secret");
    expect(r.text).not.toContain(r.idToken);
  });
});
