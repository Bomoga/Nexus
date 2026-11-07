import { describe, expect, it } from "vitest";
import type { PruneConfig } from "./prune-adapter";
import { nativeRouteFor, postToPrune, sameModel } from "./prune-native-shared";

const cfg = (f: typeof fetch): PruneConfig => ({
  apiKey: "prune-test-key", scope: "all_roles", allowModelRouting: false, fetch: f, newCallId: () => "c", now: () => "2026-11-07T00:00:00Z",
});
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;

describe("nativeRouteFor", () => {
  it("names the verified native routes only", () => {
    expect(nativeRouteFor("anthropic")).toBe("anthropic-messages");
    expect(nativeRouteFor("google")).toBe("gemini-chat-completions");
    expect(nativeRouteFor("swarms")).toBeUndefined();
    expect(nativeRouteFor("openai")).toBeUndefined();
  });
});

describe("sameModel", () => {
  it("allows only a trailing 8-digit date on the same base id", () => {
    expect(sameModel("claude-sonnet-5-5", "claude-sonnet-5-5")).toBe(true);
    expect(sameModel("claude-sonnet-5-5", "claude-sonnet-5-5-20251001")).toBe(true);
    expect(sameModel("claude-sonnet-5-5", "claude-haiku-4-5-20251001")).toBe(false);
    expect(sameModel("claude-sonnet-5", "claude-sonnet-5-5")).toBe(false);
  });
});

describe("postToPrune refusal text", () => {
  it("uses the body code when there is no shield header, like prune-adapter", async () => {
    const out = await postToPrune(cfg(reply(429, { code: "quota_exceeded", message: "monthly cap" })), "http://x", {}, {});
    expect(out).toEqual({ kind: "blocked", message: expect.stringMatching(/429 quota_exceeded.*monthly cap/) });
  });
  it("uses the shield header when present", async () => {
    const out = await postToPrune(cfg(reply(403, { message: "no" }, { "x-prune-shield-code": "pii" })), "http://x", {}, {});
    expect(out).toEqual({ kind: "blocked", message: expect.stringMatching(/403 pii.*not sent anywhere else/) });
  });
});
