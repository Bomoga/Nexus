// Stateless binding of a CIBA auth_req_id to the signed-in user who started it.
// binding = base64url(HMAC-SHA256(key = confidential client secret, "nexus-ciba-bind-v1" | authReqId | sub)).
// Verification uses WebCrypto's HMAC verify, which compares in constant time. Nothing here logs or returns the secret.
const enc = new TextEncoder();
const PREFIX = "nexus-ciba-bind-v1";

const toB64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function fromB64u(s: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(s)) return undefined;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch { return undefined; }
}

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
// Length-prefixed fields so (authReqId, sub) pairs can never collide by shifting a separator.
const message = (authReqId: string, sub: string) => enc.encode(`${PREFIX}|${authReqId.length}:${authReqId}|${sub.length}:${sub}`);

export async function makeBinding(secret: string, authReqId: string, sub: string): Promise<string> {
  return toB64u(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), message(authReqId, sub))));
}

export async function verifyBinding(secret: string, authReqId: string, sub: string, binding: unknown): Promise<boolean> {
  if (typeof binding !== "string") return false;
  const sig = fromB64u(binding);
  if (!sig) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), sig, message(authReqId, sub));
}
