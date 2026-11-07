// Secret-pattern redaction (PLAN L1-23). Used by Swarms, Prune, Tiger writes, test_output and the logger.
// Treated like a contract after wave 1: callers rely on "[REDACTED:<kind>]" and on idempotence.
//
// Runs synchronously in the extension host on untrusted text (diffs, logs, command output), so every pattern is
// bounded: no unbounded quantifier is nested or can re-scan the same long run from many starting points.

export interface RedactPattern {
  kind: string;
  re: RegExp;
}

/** Longer input is replaced wholesale (fail closed) instead of risking a slow scan. */
export const MAX_REDACT_CHARS = 2_000_000;

// Prefixed tokens. The prune/swarms key formats are not documented in the plan (verify in L1-S4/L1-S5), so those two
// require a long alphanumeric run containing a digit: that keeps identifiers like prune_expired_entries from matching.
export const PATTERNS: readonly RedactPattern[] = [
  { kind: "db-url", re: /\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis|amqps?):\/\/[^\s:/@'"]{0,128}:[^\s@'"]{1,256}@[^\s'"]{1,256}/g },
  { kind: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: "google-key", re: /AIza[0-9A-Za-z_-]{30,}/g },
  { kind: "slack-app-token", re: /xapp-[A-Za-z0-9-]{10,}/g },
  { kind: "slack-token", re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { kind: "prune-key", re: /\bprune_(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{20,}/g },
  { kind: "swarms-key", re: /\b(?:sk-)?swarms[_-](?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{20,}/gi },
  { kind: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "bearer", re: /\bBearer(?:\s|%20){1,4}[A-Za-z0-9._~+/=%-]{16,}/gi },
];

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
const PEM_END = "PRIVATE KEY-----";

// NAME=value lines: optional diff marker (+/-) and `export`; the name must contain a secret word as a whole segment,
// so DB_PASSWORD and SLACK_BOT_TOKEN match but MONKEY does not.
const ENV_LINE = /^([+-]?[ \t]{0,8}(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]{0,80})([ \t]{0,4}=[ \t]{0,4})([^\r\n]+)$/gm;
const SECRET_NAME = /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)/i;

// key=/token=/secret=/password= followed by a long hex/base64 blob (optionally quoted, JSON or YAML style).
const GENERIC = /\b(?:api[_-]?key|token|secret|password|passwd)(["']?\s{0,8}[:=]\s{0,8}["']?)([A-Za-z0-9+/_=-]{32,})/gi;
const GIT_SHA = /^[0-9a-f]{40}$/;

function redactPem(text: string): string {
  if (!text.includes("PRIVATE KEY-----")) return text;
  let out = "";
  let pos = 0;
  PEM_BEGIN.lastIndex = 0;
  for (let m = PEM_BEGIN.exec(text); m !== null; m = PEM_BEGIN.exec(text)) {
    if (m.index < pos) continue;
    out += text.slice(pos, m.index);
    const footer = text.indexOf(PEM_END, m.index + m[0].length);
    if (footer === -1) { out += "[REDACTED:pem]"; pos = text.length; break; }     // truncated block: drop the tail
    pos = footer + PEM_END.length;
    out += "[REDACTED:pem]";
    PEM_BEGIN.lastIndex = pos;
  }
  return out + text.slice(pos);
}

export function redact(text: string): string {
  if (text.length > MAX_REDACT_CHARS) return `[REDACTED:oversized input, ${text.length} chars]`;
  let out = redactPem(text);
  for (const p of PATTERNS) out = out.replace(p.re, `[REDACTED:${p.kind}]`);
  out = out.replace(ENV_LINE, (whole, lead: string, name: string, eq: string, value: string) =>
    SECRET_NAME.test(name) && value.trim() !== "[REDACTED:env]" ? `${lead}${name}${eq}[REDACTED:env]` : whole);
  out = out.replace(GENERIC, (whole, _sep: string, value: string) => (GIT_SHA.test(value) ? whole : whole.slice(0, whole.length - value.length) + "[REDACTED:generic-secret]"));
  return out;
}
