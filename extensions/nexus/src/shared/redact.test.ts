import { describe, expect, it } from "vitest";
import { PATTERNS, redact } from "./redact";

// Fake secrets assembled at runtime so no real-looking key literal sits in the repo.
const a = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
const cases: [string, string, string][] = [
  ["anthropic", `key sk-ant-api03-${a} end`, "key [REDACTED:anthropic-key] end"],
  ["google", `AIza${"Sy" + a + "x"} used`, "[REDACTED:google-key] used"],
  ["slack user", `token xoxp-1234567890-abcdef${a}`, "token [REDACTED:slack-token]"],
  ["slack bot", `xoxb-1234567890-${a}`, "[REDACTED:slack-token]"],
  ["slack app", `xapp-1-A0123-4567-${a}`, "[REDACTED:slack-app-token]"],
  ["prune", `PRUNE ${"prune_" + a}`, "PRUNE [REDACTED:prune-key]"],
  ["swarms", `swarms_${a}`, "[REDACTED:swarms-key]"],
  ["aws", "id AKIAIOSFODNN7EXAMPLE ok", "id [REDACTED:aws-key] ok"],
  ["bearer", `Authorization: Bearer ${a}.${a}`, "Authorization: [REDACTED:bearer]"],
  ["postgres url", "postgres://nexus:hunter2pass@db.tsdb.cloud:5432/tsdb?sslmode=require", "[REDACTED:postgres-url]"],
  ["postgresql url", "postgresql://u:p@host/db", "[REDACTED:postgres-url]"],
  ["pem", "x\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\nMIIdef\n-----END RSA PRIVATE KEY-----\ny", "x\n[REDACTED:pem]\ny"],
  ["pem truncated", "-----BEGIN PRIVATE KEY-----\nMIIabc", "[REDACTED:pem]"],
  ["generic token=", `token=${a}`, "token=[REDACTED:generic-secret]"],
  ["generic json", `"api_key": "${a}"`, `"api_key": "[REDACTED:generic-secret]"`],
  ["env line", "DB_PASSWORD=hunter2\nPORT=3000", "DB_PASSWORD=[REDACTED:env]\nPORT=3000"],
  ["env export", "export MY_API_KEY = abc", "export MY_API_KEY = [REDACTED:env]"],
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

  it("leaves a 40-char git SHA alone, bare or after commit=", () => {
    const sha = "3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21";
    expect(redact(sha)).toBe(sha);
    expect(redact(`commit=${sha} base: ${sha}`)).toBe(`commit=${sha} base: ${sha}`);
  });

  it("leaves ordinary prose and code alone", () => {
    const s = "const token = getToken();\nPORT=3000\nsee nexus://coderef/ws_demo/3f2a/1-2/a.ts";
    expect(redact(s)).toBe(s);
  });

  it("handles several secrets in one string", () => {
    const out = redact(`sk-ant-${a} and xoxp-1234567890-${a} and AKIAIOSFODNN7EXAMPLE`);
    expect(out).toBe("[REDACTED:anthropic-key] and [REDACTED:slack-token] and [REDACTED:aws-key]");
  });

  it("exports PATTERNS with a kind each", () => {
    expect(PATTERNS.length).toBeGreaterThan(8);
    for (const p of PATTERNS) expect(p.kind).toMatch(/^[a-z-]+$/);
  });
});
