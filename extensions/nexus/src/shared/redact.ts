// Secret-pattern redaction (PLAN L1-23). Used by Swarms, Prune, Tiger writes, test_output and the logger.
// Treated like a contract after wave 1: callers rely on "[REDACTED:<kind>]" and on idempotence.

export interface RedactPattern {
  kind: string;
  re: RegExp;
  /** Replace only this capture group, keeping the surrounding text (e.g. the key name in KEY=value). */
  group?: number;
}

// Order matters: multi-line and structured secrets first, then prefixed tokens, then generic key=value.
export const PATTERNS: readonly RedactPattern[] = [
  { kind: "pem", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { kind: "pem", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/g }, // truncated block (tail cut off)
  { kind: "postgres-url", re: /postgres(?:ql)?:\/\/[^\s:/@]+:[^\s@]+@[^\s'"]+/g },
  { kind: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: "google-key", re: /AIza[0-9A-Za-z_-]{30,}/g },
  { kind: "slack-app-token", re: /xapp-[A-Za-z0-9-]{10,}/g },
  { kind: "slack-token", re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "prune-key", re: /prune_[A-Za-z0-9_-]{16,}/g },
  // Swarms key format is not documented in the plan (verify in L1-S5); match the obvious prefixes.
  { kind: "swarms-key", re: /\b(?:sk-)?swarms[_-][A-Za-z0-9_-]{16,}/gi },
  { kind: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  // .env-style line whose NAME looks secret: keep the name, drop the value. Idempotent (value is replaced by itself).
  {
    kind: "env",
    re: /^[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*[ \t]*=[ \t]*(.+)$/gim,
    group: 1,
  },
  // key=/token=/secret= followed by a long hex/base64 blob. Never matches a bare 40-char git SHA.
  {
    kind: "generic-secret",
    re: /\b(?:api[_-]?key|token|secret|password|passwd)["']?\s*[:=]\s*["']?([A-Za-z0-9+/_=-]{32,})/gi,
    group: 1,
  },
];

export function redact(text: string): string {
  let out = text;
  for (const p of PATTERNS) {
    const replacement = `[REDACTED:${p.kind}]`;
    if (p.group === undefined) {
      out = out.replace(p.re, replacement);
    } else {
      const g = p.group;
      out = out.replace(p.re, (...args) => {
        const m = args as unknown as string[];
        const whole = m[0];
        const secret = m[g];
        if (secret === undefined || secret === replacement) return whole;
        const idx = whole.lastIndexOf(secret);
        return whole.slice(0, idx) + replacement + whole.slice(idx + secret.length);
      });
    }
  }
  return out;
}
