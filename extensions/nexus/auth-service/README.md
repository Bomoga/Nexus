# Nexus auth service

A Cloudflare Worker that starts and polls Auth0 CIBA (push approval) requests. It holds the confidential app's
client secret, which the desktop app must never have. It stores nothing durable.

- `POST /ciba/start` body `{approvalId, sessionId, actionLabel, approverAuth0UserId}` returns `{authReqId, expiresIn, interval}`
- `POST /ciba/poll` body `{authReqId}` returns `{status: "pending" | "approved" | "rejected" | "expired", auth0UserId?}`
- Both need `Authorization: Bearer <Nexus Auth0 access token>`, verified against the tenant JWKS.

## Config (Worker env)

- `AUTH0_DOMAIN` bare host, e.g. `your-tenant.eu.auth0.com`
- `AUTH0_CLIENT_ID` the confidential application used for CIBA
- `AUTH0_CLIENT_SECRET` secret binding: `npx wrangler secret put AUTH0_CLIENT_SECRET`
- `AUTH0_AUDIENCE` optional; when set, the caller token must carry this audience

## Deploy

```
npm install && npm test
npx wrangler secret put AUTH0_CLIENT_SECRET
npx wrangler deploy
```
