import { describe, expect, it, vi } from "vitest";
import type { SecretStore } from "../accounts/accounts-service";
import { AUTH_REDIRECT_URI, Auth0Session } from "./auth0-signin";
import type { LoopbackListener } from "./loopback";

const DOMAIN = "nexus-demo.eu.auth0.com";
const NOW = 1_800_000_000;
const LOOP = "http://127.0.0.1:51789/callback";
const jwt = (c: Record<string, unknown>) => `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(c)).toString("base64url")}.sig`;

function setup(loopback?: LoopbackListener, callbackTimeoutMs?: number) {
  const map = new Map<string, string>();
  const secrets: SecretStore = { get: async k => map.get(k), store: async (k, v) => { map.set(k, v); }, delete: async k => { map.delete(k); } };
  const opened: string[] = [];
  const tokenBodies: URLSearchParams[] = [];
  const logs: string[] = [];
  let nonce = "";
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    tokenBodies.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ access_token: "AT", expires_in: 3600, refresh_token: "RT", id_token: jwt({ iss: `https://${DOMAIN}/`, aud: "cid", sub: "auth0|a", exp: NOW + 3600, nonce }) }), { status: 200 });
  }) as typeof fetch;
  const session = new Auth0Session({
    config: () => ({ domain: DOMAIN, clientId: "cid" }), secrets, fetch: f, now: () => NOW, callbackTimeoutMs, log: m => logs.push(m),
    openExternal: async url => { opened.push(url); return true; },
    ...(loopback ? { loopback } : {}),
  });
  const begin = async () => {
    const done = session.signIn();
    done.catch(() => undefined);
    await vi.waitFor(() => expect(opened.length).toBeGreaterThan(0));
    const url = new URL(opened.at(-1)!);
    nonce = url.searchParams.get("nonce")!;
    return { done, url, state: url.searchParams.get("state")! };
  };
  return { session, opened, tokenBodies, logs, begin };
}

function fakeLoopback() {
  const closed = vi.fn();
  let deliver: (s: string) => void = () => undefined;
  const listener: LoopbackListener = { start: async cb => { deliver = cb; return { redirectUri: LOOP, close: closed }; } };
  return { listener, closed, deliver: (s: string) => deliver(s) };
}

describe("sign-in through the loopback redirect", () => {
  it("asks Auth0 to redirect to the loopback address and uses that same address when exchanging the code", async () => {
    const lb = fakeLoopback();
    const s = setup(lb.listener);
    const { done, url, state } = await s.begin();
    expect(url.searchParams.get("redirect_uri")).toBe(LOOP);
    lb.deliver(`?code=the-code&state=${state}`);
    expect((await done).signedIn).toBe(true);
    expect(s.tokenBodies[0].get("redirect_uri")).toBe(LOOP);          // Auth0 requires the exchange to repeat the authorize redirect_uri
    expect(s.tokenBodies[0].get("code")).toBe("the-code");
  });

  it("closes the listener once sign-in succeeds", async () => {
    const lb = fakeLoopback();
    const s = setup(lb.listener);
    const { done, state } = await s.begin();
    lb.deliver(`?code=c&state=${state}`);
    await done;
    expect(lb.closed).toHaveBeenCalledTimes(1);
  });

  it("ignores a loopback answer with the wrong state, so a stray web request cannot cancel the real sign-in", async () => {
    const lb = fakeLoopback();
    const s = setup(lb.listener);
    const { done, state } = await s.begin();
    lb.deliver("?code=evil&state=not-the-state");
    expect(s.tokenBodies).toHaveLength(0);                            // the attacker's code was never exchanged
    expect(lb.closed).not.toHaveBeenCalled();                         // and the real sign-in is still waiting
    lb.deliver(`?code=good&state=${state}`);
    expect((await done).signedIn).toBe(true);
    expect(s.tokenBodies).toHaveLength(1);
    expect(s.tokenBodies[0].get("code")).toBe("good");
  });

  it("exchanges a code only once when the browser repeats the callback", async () => {
    const lb = fakeLoopback();
    const s = setup(lb.listener);
    const { done, state } = await s.begin();
    lb.deliver(`?code=c&state=${state}`);
    lb.deliver(`?code=c&state=${state}`);
    await done;
    expect(s.tokenBodies).toHaveLength(1);
  });

  it("closes the listener and fails when opening the browser throws", async () => {
    const lb = fakeLoopback();
    const closed = lb.closed;
    const session = new Auth0Session({
      config: () => ({ domain: DOMAIN, clientId: "cid" }), secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
      openExternal: async () => { throw new Error("no browser"); }, loopback: lb.listener,
    });
    await expect(session.signIn()).rejects.toThrow("could not be opened");
    expect(closed).toHaveBeenCalledTimes(1);
    await expect(session.signIn()).rejects.not.toThrow("already waiting");     // a later attempt is not blocked
  });

  it("reports a refusal from Auth0 and closes the listener", async () => {
    const lb = fakeLoopback();
    const s = setup(lb.listener);
    const { done, state } = await s.begin();
    lb.deliver(`?error=access_denied&error_description=nope&state=${state}`);
    await expect(done).rejects.toThrow("refused");
    expect(lb.closed).toHaveBeenCalledTimes(1);
  });

  it("closes the listener when the sign-in times out", async () => {
    const lb = fakeLoopback();
    const s = setup(lb.listener, 30);
    const { done } = await s.begin();
    await expect(done).rejects.toThrow("timed out");
    expect(lb.closed).toHaveBeenCalledTimes(1);
  });

  it("closes the listener when the sign-in is cancelled", async () => {
    const lb = fakeLoopback();
    const s = setup(lb.listener);
    const { done } = await s.begin();
    await s.session.signOut();
    await expect(done).rejects.toThrow("cancelled");
    expect(lb.closed).toHaveBeenCalledTimes(1);
  });

  it("falls back to the nexus:// redirect when the loopback port is unavailable", async () => {
    const s = setup({ start: async () => { throw new Error("EADDRINUSE"); } });
    const { done, url, state } = await s.begin();
    expect(url.searchParams.get("redirect_uri")).toBe(AUTH_REDIRECT_URI);
    await s.session.handleCallback(`${AUTH_REDIRECT_URI}?code=c&state=${state}`);
    expect((await done).signedIn).toBe(true);
    expect(s.tokenBodies[0].get("redirect_uri")).toBe(AUTH_REDIRECT_URI);
    expect(s.logs.join(" ")).toContain("loopback listener unavailable");
  });

  it("refuses a second sign-in while the first is still starting its listener", async () => {
    let release: () => void = () => undefined;
    const slow: LoopbackListener = { start: () => new Promise(res => { release = () => res({ redirectUri: LOOP, close: () => undefined }); }) };
    const s = setup(slow);
    const first = s.session.signIn();
    first.catch(() => undefined);
    await expect(s.session.signIn()).rejects.toThrow("already waiting");
    release();
    await vi.waitFor(() => expect(s.opened.length).toBe(1));
    await s.session.signOut();
    await expect(first).rejects.toThrow("cancelled");
  });

  it("still works without a loopback listener at all (the nexus:// path is unchanged)", async () => {
    const s = setup();
    const { done, url, state } = await s.begin();
    expect(url.searchParams.get("redirect_uri")).toBe(AUTH_REDIRECT_URI);
    await s.session.handleCallback(`${AUTH_REDIRECT_URI}?code=c&state=${state}`);
    expect((await done).signedIn).toBe(true);
  });
});
