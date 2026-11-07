// Test-only helpers: a throwaway RSA key pair, a JWT signer and a routing fetch mock. No network.
export const DOMAIN = "tenant.test.auth0.com";
export const ISS = `https://${DOMAIN}/`;

export interface TestKey { kid: string; privateKey: CryptoKey; jwk: JsonWebKey & { kid: string } }

const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64u(new TextEncoder().encode(JSON.stringify(o)));

export async function makeKey(kid = "k1"): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

export async function signJwt(key: TestKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const h = enc({ alg: "RS256", typ: "JWT", kid: key.kid, ...header });
  const p = enc(claims);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}

export const unsignedJwt = (claims: Record<string, unknown>) => `${enc({ alg: "none" })}.${enc(claims)}.sig`;

export const nowSec = () => Math.floor(Date.now() / 1000);

export interface Call { url: string; method: string; body: string; headers: Headers }
export type Responder = (call: Call) => Response | Promise<Response>;

export function mockFetch(routes: Record<string, Responder>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const call: Call = { url: req.url, method: req.method, body: await req.text(), headers: req.headers };
    calls.push(call);
    const r = routes[req.url];
    if (!r) throw new Error(`unexpected fetch ${req.url}`);
    return r(call);
  }) as typeof fetch;
  return { fn, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A token with an arbitrary header and signature segment, for malformed-token tests. */
export const rawToken = (header: unknown, claims: Record<string, unknown>, sig = "c2ln") => `${enc(header)}.${enc(claims)}.${sig}`;
