import { describe, expect, it } from "vitest";
import { fx } from "../contracts/fixtures";
import { SwarmsClient } from "../features/swarms/swarms-client";
import { ProviderAuthError, collectTurn, roleEligible, type TurnRequest } from "./provider";
import { SWARMS_MODEL_ID, createSwarmsProvider } from "./swarms-provider";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(respond: (url: string, body: unknown) => Response = () => json(200, { outputs: [{ content: "A short summary." }], models: [] })) {
  const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url: String(url), body });
    return respond(String(url), body);
  }) as typeof fetch;
  return { provider: createSwarmsProvider(new SwarmsClient({ fetch: f }), { budgetKey: () => "ses_01" }), calls };
}

const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({ modelId: SWARMS_MODEL_ID, role: "summary", system: "Summarize for Slack.", messages: [{ role: "user", content: "What changed?" }], tools: [], ...over });

describe("swarms provider", () => {
  it("lists one text-only model after a real key check, and the fixture agrees on its shape", async () => {
    const s = setup();
    const models = await s.provider.listModels("k");
    expect(models).toEqual([{ provider: "swarms", modelId: "swarms:single-agent", displayName: "Swarms (text only)", supportsTools: false }]);
    expect(models[0]).toEqual(fx.models.find(m => m.provider === "swarms"));
    expect(s.calls[0].url).toBe("https://api.swarms.world/v1/models/available");
  });

  it("propagates a rejected key as ProviderAuthError", async () => {
    const s = setup(() => json(401, { detail: "Missing or invalid x-api-key" }));
    await expect(s.provider.listModels("bad")).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it("is never eligible for the agent role", async () => {
    const [model] = await setup().provider.listModels("k");
    expect(roleEligible(model, "agent")).toBe(false);
    for (const role of ["brief", "summary", "approval_wording", "swarm_input"] as const) expect(roleEligible(model, role)).toBe(true);
  });

  it("answers a text role with one single-agent completion", async () => {
    const s = setup();
    const r = await collectTurn(s.provider.turn(req(), "k"));
    expect(r.text).toBe("A short summary.");
    expect(r.done?.stopReason).toBe("end_turn");
    expect(r.toolCalls).toEqual([]);
    expect(s.calls[0]).toMatchObject({ url: "https://api.swarms.world/v1/agent/completions" });
    expect(s.calls[0].body).toMatchObject({ task: "What changed?", agent_config: { system_prompt: "Summarize for Slack.", model_name: "claude-sonnet-5" } });
  });

  it("refuses the coding-agent role without making any request", async () => {
    const s = setup();
    const r = await collectTurn(s.provider.turn(req({ role: "agent" }), "k"));
    expect(r.error).toMatch(/cannot drive the coding agent/);
    expect(s.calls).toEqual([]);
  });

  it("flattens a multi-message history into one task, and honours swarms:<model> ids", async () => {
    const s = setup();
    await collectTurn(s.provider.turn(req({ modelId: "swarms:some-model", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }), "k"));
    expect(s.calls[0].body).toMatchObject({ task: "User: a\n\nAssistant: b\n\nUser: c", agent_config: { model_name: "some-model" } });
  });

  it("turns Swarms failures into error events with a clear message, and an abort into cancelled", async () => {
    const s = setup(() => json(429, { detail: "Rate limit exceeded" }));
    const r = await collectTurn(s.provider.turn(req(), "k"));
    expect(r.error).toMatch(/Swarms answered 429/);
    const ac = new AbortController();
    ac.abort();
    const aborted = await collectTurn(setup().provider.turn(req({ signal: ac.signal }), "k"));
    expect(aborted.done?.stopReason).toBe("cancelled");
  });

  it("holds no key", () => {
    expect(Object.keys(setup().provider).sort()).toEqual(["id", "listModels", "turn"]);
  });
});
