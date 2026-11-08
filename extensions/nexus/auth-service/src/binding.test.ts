import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handle, resetState, type Env } from "./index";
import { DOMAIN, ISS, json, makeKey, mockFetch, nowSec, signJwt, type TestKey } from "./test-helpers";

const SECRET = "test-secret";
const env: Env = { AUTH0_DOMAIN: DOMAIN, AUTH0_CLIENT_ID: "test-client", AUTH0_CLIENT_SECRET: SECRET };
const JWKS_URL = `https://${DOMAIN}/.well-known/jwks.json`;
const BC_URL = `https://${DOMAIN}/bc-authorize`;
const TOKEN_URL = `https://${DOMAIN}/oauth/token`;

let key: TestKey;
beforeAll(async () => { key = await makeKey("k1"); });
beforeEach(() => resetState());

const bearerFor = async (sub: string) => `Bearer ${await signJwt(key, { iss: ISS, sub, aud: "nexus-api", exp: nowSec() + 600 })}`;
const post = (path: string, body: unknown, auth?: string) =>
  new Request(`https://svc.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
const m = () => mockFetch({
  [JWKS_URL]: () => json({ keys: [key.jwk] }),
  [BC_URL]: () => json({ auth_req_id: "req-1", expires_in: 300, interval: 5 }),
  [TOKEN_URL]: () => json({ error: "authorization_pending" }, 400),
});
const startBody = { approvalId: "abcdef1234567890", sessionId: "s1", actionLabel: "run npm test", approverAuth0UserId: "auth0|approver" };

async function startAs(sub: string, f: ReturnType<typeof m>, body = startBody) {
  const res = await handle(post("/ciba/start", body, await bearerFor(sub)), env, { fetch: f.fn });
  return { res, data: (await res.json()) as { authReqId?: string; binding?: string } };
}
const pollAs = async (sub: string, f: ReturnType<typeof m>, body: Record<string, unknown>) =>
  handle(post("/ciba/poll", body, await bearerFor(sub)), env, { fetch: f.fn });

describe("CIBA poll binding", () => {
  it("start returns a binding token and never the client secret", async () => {
    const f = m();
    const { res, data } = await startAs("auth0|alice", f);
    expect(res.status).toBe(200);
    expect(data.authReqId).toBe("req-1");
    expect(typeof data.binding).toBe("string");
    expect(JSON.stringify(data)).not.toContain(SECRET);
  });
  it("poll by the starting user succeeds", async () => {
    const f = m();
    const { data } = await startAs("auth0|alice", f);
    const res = await pollAs("auth0|alice", f, { authReqId: data.authReqId, binding: data.binding });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "pending" });
  });
  it("poll by a different user is 403 and never reaches Auth0", async () => {
    const f = m();
    const { data } = await startAs("auth0|alice", f);
    const res = await pollAs("auth0|mallory", f, { authReqId: data.authReqId, binding: data.binding });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    expect(f.calls.some((c) => c.url === TOKEN_URL)).toBe(false);
  });
  it("a missing binding is rejected (403) before Auth0 is called", async () => {
    const f = m();
    const { data } = await startAs("auth0|alice", f);
    const res = await pollAs("auth0|alice", f, { authReqId: data.authReqId });
    expect(res.status).toBe(403);
    expect(f.calls.some((c) => c.url === TOKEN_URL)).toBe(false);
  });
  it("a tampered binding, or a binding for another authReqId, is 403", async () => {
    const f = m();
    const { data } = await startAs("auth0|alice", f);
    const b = data.binding!;
    const flipped = (b[0] === "A" ? "B" : "A") + b.slice(1);
    for (const binding of [flipped, b.slice(0, -2), `${b}x`, "", "!!not-base64!!"]) {
      expect((await pollAs("auth0|alice", f, { authReqId: data.authReqId, binding })).status).toBe(403);
    }
    expect((await pollAs("auth0|alice", f, { authReqId: "req-other", binding: b })).status).toBe(403);
    expect(f.calls.some((c) => c.url === TOKEN_URL)).toBe(false);
  });
  it("a binding made under a different client secret is rejected", async () => {
    const f = m();
    const { data } = await startAs("auth0|alice", f);
    const res = await handle(post("/ciba/poll", { authReqId: data.authReqId, binding: data.binding }, await bearerFor("auth0|alice")),
      { ...env, AUTH0_CLIENT_SECRET: "rotated" }, { fetch: f.fn });
    expect(res.status).toBe(403);
  });
  it("another user cannot obtain a binding by starting the same approval", async () => {
    const f = m();
    const a = await startAs("auth0|alice", f);
    expect(a.res.status).toBe(200);
    const b = await startAs("auth0|mallory", f);
    expect(b.res.status).toBe(403);
    expect(b.data.binding).toBeUndefined();
    expect(f.calls.filter((c) => c.url === BC_URL)).toHaveLength(1);
  });
  it("the same user starting again gets the same request and a valid binding", async () => {
    const f = m();
    const a = await startAs("auth0|alice", f);
    const b = await startAs("auth0|alice", f);
    expect(b.data.authReqId).toBe(a.data.authReqId);
    expect(b.data.binding).toBe(a.data.binding);
  });
});
