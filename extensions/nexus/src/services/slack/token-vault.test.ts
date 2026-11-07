import { describe, expect, it, vi } from "vitest";
import { createTokenVault, TokenVaultError, type TokenVaultDeps } from "./token-vault";

const CFG = { domain: "nexus.us.auth0.com", clientId: "CID", slackConnection: "sign-in-with-slack" };
const REFRESH = "REFRESH-SECRET-123";
const SLACK = "xoxp-SLACK-SECRET";

function res(status: number, body: unknown) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }

function setup(over: Partial<TokenVaultDeps> = {}, reply: () => ReturnType<typeof res> | Promise<ReturnType<typeof res>> = () => res(200, { access_token: SLACK, expires_in: 3600 })) {
  let now = 1_000_000;
  const fetch = vi.fn(async () => reply());
  const vault = createTokenVault({ fetch: fetch as unknown as TokenVaultDeps["fetch"], config: () => CFG, getRefreshToken: async () => REFRESH, clock: () => now, ...over });
  return { vault, fetch, advance: (ms: number) => { now += ms; } };
}

describe("token vault", () => {
  it("sends the exact token exchange request", async () => {
    const { vault, fetch } = setup();
    expect(await vault.getUserToken()).toEqual({ token: SLACK, source: "token_vault" });
    expect(fetch.mock.calls[0]).toMatchInlineSnapshot(`
      [
        "https://nexus.us.auth0.com/oauth/token",
        {
          "body": "grant_type=urn%3Aauth0%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange%3Afederated-connection-access-token&client_id=CID&subject_token=REFRESH-SECRET-123&subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Arefresh_token&connection=sign-in-with-slack&requested_token_type=http%3A%2F%2Fauth0.com%2Foauth%2Ftoken-type%2Ffederated-connection-access-token",
          "headers": {
            "content-type": "application/x-www-form-urlencoded",
          },
          "method": "POST",
        },
      ]
    `);
  });

  it("caches until shortly before expiry, then re-exchanges", async () => {
    const { vault, fetch, advance } = setup();
    await vault.getUserToken(); await vault.getUserToken();
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(3600_000 - 61_000);
    await vault.getUserToken();
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(2_000);
    await vault.getUserToken();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("re-exchanges after invalidate()", async () => {
    const { vault, fetch } = setup();
    await vault.getUserToken(); vault.invalidate(); await vault.getUserToken();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache an exchange that was invalidated while in flight", async () => {
    const { vault, fetch } = setup();
    const p = vault.getUserToken(); vault.invalidate(); await p;
    await vault.getUserToken();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shares one request between concurrent callers", async () => {
    const { vault, fetch } = setup();
    const [a, b] = await Promise.all([vault.getUserToken(), vault.getUserToken()]);
    expect(a).toEqual(b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns null without a request when not signed in or not configured", async () => {
    const a = setup({ getRefreshToken: async () => undefined });
    expect(await a.vault.getUserToken()).toBeNull();
    const b = setup({ config: () => undefined });
    expect(await b.vault.getUserToken()).toBeNull();
    expect(b.vault.connectAccountUrl()).toBeNull();
    expect(a.fetch).not.toHaveBeenCalled();
    expect(b.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [403, { error: "federated_connection_refresh_token_not_found", error_description: `no token ${REFRESH}` }, "not_connected"],
    [404, { error: "federated_connection_not_found" }, "not_connected"],
    [403, { error: "invalid_grant", error_description: `bad ${REFRESH}` }, "unauthorized"],
    [401, { error: "invalid_client" }, "unauthorized"],
    [503, { error: "server_error", access_token: SLACK }, "unavailable"],
    [429, {}, "unavailable"],
  ])("maps status %i %j to %s without leaking secrets", async (status, body, code) => {
    const { vault } = setup({}, () => res(status, body));
    const err = await vault.getUserToken().catch(e => e) as TokenVaultError;
    expect(err).toBeInstanceOf(TokenVaultError);
    expect(err.code).toBe(code);
    for (const s of [REFRESH, SLACK, "no token", "bad "]) expect(err.message).not.toContain(s);
  });

  it("maps network failures and unreadable bodies to unavailable without leaking", async () => {
    const net = setup({ fetch: (async () => { throw new Error(`connect failed ${REFRESH}`); }) as unknown as TokenVaultDeps["fetch"] });
    const e1 = await net.vault.getUserToken().catch(e => e) as TokenVaultError;
    expect(e1.code).toBe("unavailable");
    expect(e1.message).not.toContain(REFRESH);
    const bad = setup({}, () => res(200, { expires_in: 5 }));
    expect(((await bad.vault.getUserToken().catch(e => e)) as TokenVaultError).code).toBe("unavailable");
  });

  it("ignores an error field that is not a plain identifier", async () => {
    const { vault } = setup({}, () => res(400, { error: `weird ${SLACK}` }));
    const err = await vault.getUserToken().catch(e => e) as TokenVaultError;
    expect(err.code).toBe("unauthorized");
    expect(err.message).not.toContain(SLACK);
  });

  it("builds the connect-account url", () => {
    expect(setup().vault.connectAccountUrl()).toBe("https://nexus.us.auth0.com/authorize?client_id=CID&response_type=code&connection=sign-in-with-slack&prompt=consent");
  });
});
