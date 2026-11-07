// Verifies a Nexus caller access token (RS256) against the tenant JWKS. Standard Worker APIs only.
export interface VerifyOptions {
  domain: string;
  audience?: string;
  fetch: typeof fetch;
  nowSec: number;
}

interface Jwks { keys: (JsonWebKey & { kid?: string })[] }
const JWKS_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map<string, { at: number; jwks: Jwks }>();
const keyCache = new Map<string, CryptoKey>();
const lastForced = new Map<string, number>();   // domain -> ms of the last forced (unknown kid) refetch
const FORCED_REFETCH_MS = 30_000;
const MAX_KID = 128;

export function resetJwtState(): void { jwksCache.clear(); keyCache.clear(); lastForced.clear(); }

export function b64uToBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const v = JSON.parse(new TextDecoder().decode(b64uToBytes(parts[1]!)));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch { return undefined; }
}

async function getJwks(o: VerifyOptions, force: boolean): Promise<Jwks | undefined> {
  const hit = jwksCache.get(o.domain);
  const nowMs = o.nowSec * 1000;
  if (hit && !force && nowMs - hit.at < JWKS_TTL_MS) return hit.jwks;
  const res = await o.fetch(`https://${o.domain}/.well-known/jwks.json`);
  if (!res.ok) return undefined;
  const jwks = (await res.json()) as Jwks;
  if (!jwks || !Array.isArray(jwks.keys)) return undefined;
  jwksCache.set(o.domain, { at: nowMs, jwks });
  return jwks;
}

async function importKey(o: VerifyOptions, kid: string): Promise<CryptoKey | undefined> {
  const id = `${o.domain}/${kid}`;
  let jwks = await getJwks(o, false);
  let jwk = jwks?.keys.find((k) => k.kid === kid);
  const cached = keyCache.get(id);
  if (cached && jwk) return cached;
  if (!jwk) {   // key rotation: at most one forced refetch per domain per 30s, so unknown kids cannot drive fetches
    const last = lastForced.get(o.domain);
    if (last !== undefined && o.nowSec * 1000 - last < FORCED_REFETCH_MS) return undefined;
    lastForced.set(o.domain, o.nowSec * 1000);
    jwks = await getJwks(o, true);
    jwk = jwks?.keys.find((k) => k.kid === kid);
  }
  if (!jwk || jwk.kty !== "RSA") return undefined;
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  keyCache.set(id, key);
  return key;
}

/** Returns the verified claims, or undefined for any failure. */
export async function verifyAccessToken(header: string | null, o: VerifyOptions): Promise<Record<string, unknown> | undefined> {
  const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!m) return undefined;
  const token = m[1]!;
  const [h, p, s] = token.split(".") as [string, string, string];
  let head: { alg?: unknown; kid?: unknown } | null;
  let sig: Uint8Array;
  try {
    head = JSON.parse(new TextDecoder().decode(b64uToBytes(h)));
    sig = b64uToBytes(s);
  } catch { return undefined; }
  if (!head || typeof head !== "object") return undefined;
  if (head.alg !== "RS256" || typeof head.kid !== "string" || head.kid.length === 0 || head.kid.length > MAX_KID) return undefined;
  const key = await importKey(o, head.kid);
  if (!key) return undefined;
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return undefined;
  const c = decodeJwtPayload(token);
  if (!c) return undefined;
  if (c.iss !== `https://${o.domain}/`) return undefined;
  if (typeof c.exp !== "number" || c.exp <= o.nowSec) return undefined;
  if (typeof c.nbf === "number" && c.nbf > o.nowSec + 60) return undefined;
  if (o.audience) {
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.includes(o.audience)) return undefined;
  }
  return c;
}
