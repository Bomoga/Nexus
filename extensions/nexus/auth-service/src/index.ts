// Nexus auth service: starts and polls Auth0 CIBA requests for approvals. Stores nothing durable.
// Secrets stay in the Worker env; nothing here logs, throws or returns the client secret or any token.
import { z } from "zod";
import { decodeJwtPayload, resetJwtState, verifyAccessToken } from "./jwt";

export interface Env {
  AUTH0_DOMAIN: string;
  AUTH0_CLIENT_ID: string;
  AUTH0_CLIENT_SECRET: string;
  AUTH0_AUDIENCE?: string;
}
export interface Deps { fetch?: typeof fetch; now?: () => number }

const StartBody = z.object({
  approvalId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  actionLabel: z.string().min(1).max(500),
  approverAuth0UserId: z.string().min(1).max(200),
}).strict();
const PollBody = z.object({ authReqId: z.string().min(1).max(500) }).strict();

const DEFAULT_INTERVAL = 5;
const MAX_ENTRIES = 1000;

// Per Worker instance only (best effort guard; Auth0 allows 5 CIBA requests per minute per user).
const started = new Map<string, { authReqId: string; interval: number; expiresAt: number }>();
const intervals = new Map<string, number>();

export function resetState(): void { started.clear(); intervals.clear(); resetJwtState(); }

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const fail = (status: number, error: string, message: string) => reply({ error, message }, status);

function bindingMessage(approvalId: string, actionLabel: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9 +\-_.,:#]/g, "");
  return clean(`NX ${approvalId.slice(0, 8)} ${actionLabel.slice(0, 20)}`).slice(0, 64);
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try { const v = await res.json(); return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

const RATE_MSG = "Auth0 allows 5 CIBA requests per minute per user; try again shortly.";

async function start(req: Request, env: Env, f: typeof fetch, now: number): Promise<Response> {
  const parsed = StartBody.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) return fail(400, "bad_request", "Body must be {approvalId, sessionId, actionLabel, approverAuth0UserId}.");
  const b = parsed.data;
  const existing = started.get(b.approvalId);
  if (existing && existing.expiresAt > now) {
    return reply({ authReqId: existing.authReqId, expiresIn: Math.max(1, Math.round((existing.expiresAt - now) / 1000)), interval: existing.interval });
  }
  started.delete(b.approvalId);
  const res = await f(`https://${env.AUTH0_DOMAIN}/bc-authorize`, {
    method: "POST",
    headers: FORM_HEADERS,
    body: form({
      client_id: env.AUTH0_CLIENT_ID,
      client_secret: env.AUTH0_CLIENT_SECRET,
      scope: "openid",
      login_hint: JSON.stringify({ format: "iss_sub", iss: `https://${env.AUTH0_DOMAIN}/`, sub: b.approverAuth0UserId }),
      binding_message: bindingMessage(b.approvalId, b.actionLabel),
      request_expiry: "300",
    }),
  });
  if (res.status === 429) return fail(429, "rate_limited", RATE_MSG);
  const data = await readJson(res);
  if (!res.ok || typeof data.auth_req_id !== "string") return fail(502, "auth0_error", "Auth0 did not start the approval request.");
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 300;
  const interval = typeof data.interval === "number" ? data.interval : DEFAULT_INTERVAL;
  if (started.size >= MAX_ENTRIES) started.delete(started.keys().next().value as string);
  started.set(b.approvalId, { authReqId: data.auth_req_id, interval, expiresAt: now + expiresIn * 1000 });
  return reply({ authReqId: data.auth_req_id, expiresIn, interval });
}

async function poll(req: Request, env: Env, f: typeof fetch): Promise<Response> {
  const parsed = PollBody.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) return fail(400, "bad_request", "Body must be {authReqId}.");
  const { authReqId } = parsed.data;
  const res = await f(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: FORM_HEADERS,
    body: form({
      grant_type: "urn:openid:params:grant-type:ciba",
      auth_req_id: authReqId,
      client_id: env.AUTH0_CLIENT_ID,
      client_secret: env.AUTH0_CLIENT_SECRET,
    }),
  });
  if (res.status === 429) return fail(429, "rate_limited", "Auth0 is rate limiting polls; wait for the Retry-After interval.");
  const data = await readJson(res);
  if (res.ok) {
    const sub = typeof data.id_token === "string" ? decodeJwtPayload(data.id_token)?.sub : undefined;
    if (typeof sub !== "string" || !sub) return fail(502, "auth0_error", "Approved, but Auth0 returned no usable identity.");
    intervals.delete(authReqId);
    return reply({ status: "approved", auth0UserId: sub });
  }
  switch (data.error) {
    case "authorization_pending": return reply({ status: "pending" });
    case "slow_down": {
      const next = (intervals.get(authReqId) ?? DEFAULT_INTERVAL) + 5;
      if (intervals.size >= MAX_ENTRIES) intervals.delete(intervals.keys().next().value as string);
      intervals.set(authReqId, next);
      return reply({ status: "pending", retryAfter: next }, 200, { "Retry-After": String(next) });
    }
    case "access_denied": return reply({ status: "rejected" });
    case "expired_token": return reply({ status: "expired" });
    default: return fail(502, "auth0_error", "Auth0 could not report the approval result.");
  }
}

export async function handle(req: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path !== "/ciba/start" && path !== "/ciba/poll") return fail(404, "not_found", "Not found.");
  if (req.method !== "POST") return reply({ error: "method_not_allowed", message: "Use POST." }, 405, { Allow: "POST" });
  if (!env.AUTH0_DOMAIN || !env.AUTH0_CLIENT_ID || !env.AUTH0_CLIENT_SECRET) return fail(500, "misconfigured", "Service is not configured.");
  const f = deps.fetch ?? fetch;
  const now = (deps.now ?? Date.now)();
  try {
    const claims = await verifyAccessToken(req.headers.get("authorization"),
      { domain: env.AUTH0_DOMAIN, audience: env.AUTH0_AUDIENCE || undefined, fetch: f, nowSec: Math.floor(now / 1000) });
    if (!claims) return fail(401, "unauthorized", "A valid Nexus access token is required.");
    return path === "/ciba/start" ? await start(req, env, f, now) : await poll(req, env, f);
  } catch {
    return fail(502, "upstream_error", "The request to Auth0 failed.");   // never echo the underlying error
  }
}

export default {
  fetch: (req: Request, env: Env): Promise<Response> => handle(req, env),
};
