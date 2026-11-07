import { describe, expect, it } from "vitest";
import { MAX_REDACT_CHARS, PATTERNS, redact } from "./redact";

// Fake secrets assembled at runtime so no real-looking key literal sits in the repo.
const a = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
const cases: [string, string, string][] = [
  ["anthropic", `key sk-ant-api03-${a} end`, "key [REDACTED:anthropic-key] end"],
  ["google", `AIza${"Sy" + a + "x"} used`, "[REDACTED:google-key] used"],
  ["slack user", `token xoxp-1234567890-abcdef${a}`, "token [REDACTED:slack-token]"],
  ["slack bot", `xoxb-1234567890-${a}`, "[REDACTED:slack-token]"],
  ["slack app", `xapp-1-A0123-4567-${a}`, "[REDACTED:slack-app-token]"],
  ["github", `ghp_${a}`, "[REDACTED:github-token]"],
  ["prune", `PRUNE ${"prune_" + a}`, "PRUNE [REDACTED:prune-key]"],
  ["swarms", `swarms_${a}`, "[REDACTED:swarms-key]"],
  ["aws", "id AKIAIOSFODNN7EXAMPLE ok", "id [REDACTED:aws-key] ok"],
  ["bearer", `Authorization: Bearer ${a}.${a}`, "Authorization: [REDACTED:bearer]"],
  ["bearer lowercase", `authorization: bearer ${a}`, "authorization: [REDACTED:bearer]"],
  ["bearer url-encoded", `?h=Bearer%20${a}`, "?h=[REDACTED:bearer]"],
  ["postgres url", "postgres://nexus:hunter2pass@db.tsdb.cloud:5432/tsdb?sslmode=require", "[REDACTED:db-url]"],
  ["postgresql url", "postgresql://u:p@host/db", "[REDACTED:db-url]"],
  ["empty user", "postgres://:pw@host/db", "[REDACTED:db-url]"],
  ["mongodb url", "mongodb+srv://u:pw@cluster0.example.net/db", "[REDACTED:db-url]"],
  ["pem", "x\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\nMIIdef\n-----END RSA PRIVATE KEY-----\ny", "x\n[REDACTED:pem]\ny"],
  ["two pems", "-----BEGIN PRIVATE KEY-----\na\n-----END PRIVATE KEY-----\nmid\n-----BEGIN PRIVATE KEY-----\nb\n-----END PRIVATE KEY-----", "[REDACTED:pem]\nmid\n[REDACTED:pem]"],
  ["pem truncated", "-----BEGIN PRIVATE KEY-----\nMIIabc", "[REDACTED:pem]"],
  ["generic token=", `curl -H x --data token=${a}`, "curl -H x --data token=[REDACTED:generic-secret]"],
  ["token= at line start is an env-style line", `token=${a}`, "token=[REDACTED:env]"],
  ["generic json", `"api_key": "${a}"`, `"api_key": "[REDACTED:generic-secret]"`],
  ["generic yaml", `  secret: ${a}`, "  secret: [REDACTED:generic-secret]"],
  ["env line", "DB_PASSWORD=hunter2\nPORT=3000", "DB_PASSWORD=[REDACTED:env]\nPORT=3000"],
  ["env export", "export MY_API_KEY = abc", "export MY_API_KEY = [REDACTED:env]"],
  ["env in a diff (added)", "+DB_PASSWORD=hunter2", "+DB_PASSWORD=[REDACTED:env]"],
  ["env in a diff (removed)", "-SLACK_BOT_TOKEN=xoxb-123-abc", "-SLACK_BOT_TOKEN=[REDACTED:env]"],
  ["env in a diff (context)", " AWS_SECRET_ACCESS_KEY=abc/def", " AWS_SECRET_ACCESS_KEY=[REDACTED:env]"],
];

describe("redact", () => {
  it.each(cases)("%s", (_n, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("is idempotent on every case", () => {
    for (const [, input] of cases) {
      const once = redact(input);
      expect(redact(once)).toBe(once);
    }
  });

  it("leaves a 40-char git SHA alone: bare, after commit=, and as a token= value", () => {
    const sha = "3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21";
    expect(redact(sha)).toBe(sha);
    expect(redact(`commit=${sha} base: ${sha}`)).toBe(`commit=${sha} base: ${sha}`);
    expect(redact(`x --data token=${sha}`)).toBe(`x --data token=${sha}`);
  });

  it("leaves ordinary prose and code alone, including look-alike identifiers and env names", () => {
    const s = [
      "const token = getToken();",
      "PORT=3000",
      "MONKEY=1",
      "function prune_expired_entries_from_cache() {}",
      "import { swarms_client_configuration } from './swarms_review_controller_component.ts';",
      "see nexus://coderef/ws_demo/3f2a/1-2/a.ts",
    ].join("\n");
    expect(redact(s)).toBe(s);
  });

  it("handles several secrets in one string", () => {
    const out = redact(`sk-ant-${a} and xoxp-1234567890-${a} and AKIAIOSFODNN7EXAMPLE`);
    expect(out).toBe("[REDACTED:anthropic-key] and [REDACTED:slack-token] and [REDACTED:aws-key]");
  });

  it("exports PATTERNS with a kind each", () => {
    expect(PATTERNS.length).toBeGreaterThanOrEqual(10);
    for (const p of PATTERNS) expect(p.kind).toMatch(/^[a-z-]+$/);
  });

  it("fails closed on oversized input", () => {
    const out = redact("a".repeat(MAX_REDACT_CHARS + 1));
    expect(out).toMatch(/^\[REDACTED:oversized input/);
    expect(out.length).toBeLessThan(100);
  });
});

describe("redact on adversarial input (it runs synchronously in the extension host)", () => {
  const MB = 1_000_000;
  const rep = (s: string) => s.repeat(Math.ceil(MB / s.length)).slice(0, MB);
  const inputs: [string, string][] = [
    ["KEY repeated", rep("KEY")],
    ["TOKEN_ repeated", rep("TOKEN_")],
    ["api_key repeated", rep("api_key")],
    ["postgres://a:b repeated", rep("postgres://a:b")],
    ["PEM headers without a footer", rep("-----BEGIN PRIVATE KEY-----")],
    ["Bearer repeated", rep("Bearer ")],
    ["sk-ant- repeated", rep("sk-ant-")],
    ["xoxb- repeated", rep("xoxb-")],
    ["prune_ repeated", rep("prune_a")],
    ["token= repeated", rep("token=")],
    ["one long identifier", "A".repeat(MB)],
    ["a= repeated", rep("a=")],
    ["whitespace", " ".repeat(MB)],
    ["newlines", "\n".repeat(MB)],
    ["env-ish lines", rep("API_KEY\n")],
    ["a long value after token=", "token=" + "A".repeat(MB - 6)],
  ];

  it.each(inputs)("1 MB of %s finishes quickly", (_n, input) => {
    expect(input.length).toBeLessThanOrEqual(MB);
    const t0 = performance.now();
    const out = redact(input);
    const ms = performance.now() - t0;
    expect(typeof out).toBe("string");
    expect(ms).toBeLessThan(2000);
  });
});
