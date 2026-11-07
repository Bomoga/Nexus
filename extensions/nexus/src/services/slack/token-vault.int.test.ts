// Live check: one real Token Vault exchange, then Slack auth.test with the result. Prints only ok / user id, never a token.
//   AUTH0_DOMAIN=... AUTH0_CLIENT_ID=... AUTH0_REFRESH_TOKEN=... AUTH0_SLACK_CONNECTION=... npx vitest run -c vitest.int.config.ts src/services/slack/token-vault
import { describe, expect, it } from "vitest";
import { createTokenVault } from "./token-vault";

const domain = process.env.AUTH0_DOMAIN;
const clientId = process.env.AUTH0_CLIENT_ID;
const refresh = process.env.AUTH0_REFRESH_TOKEN;
const slackConnection = process.env.AUTH0_SLACK_CONNECTION;
const live = !!(domain && clientId && refresh && slackConnection);

describe.skipIf(!live)("L2-15 live token vault", () => {
  it("exchanges the refresh token for a Slack token that passes auth.test", async () => {
    const vault = createTokenVault({
      fetch: (url, init) => fetch(url, init),
      config: () => ({ domain: domain as string, clientId: clientId as string, slackConnection: slackConnection as string }),
      getRefreshToken: async () => refresh,
      clock: () => Date.now(),
    });
    const got = await vault.getUserToken();
    expect(got?.source).toBe("token_vault");
    const r = await fetch("https://slack.com/api/auth.test", { method: "POST", headers: { authorization: `Bearer ${got?.token}` } });
    const j = (await r.json()) as { ok: boolean; user_id?: string };
    console.log(`L2-15: auth.test ok=${j.ok} user=${j.user_id ?? "?"}`);
    expect(j.ok).toBe(true);
  });
});
