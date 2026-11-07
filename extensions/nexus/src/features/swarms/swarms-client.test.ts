import { describe, expect, it } from "vitest";
import { ProviderAuthError } from "../../models/provider";
import { DEFAULT_AGENT_MODEL, SwarmsClient, SwarmsUnavailable, lastTurnText, outputText, type AgentSpec } from "./swarms-client";

const SECRET = "sk-ant-api03-SECRETSECRETSECRET1234567890";

interface Seen { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | undefined }

function fakeFetch(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const entry: Seen = { url: String(url), method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(entry);
    return respond(entry);
  }) as typeof fetch;
  return { f, seen };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const councilResponse = {
  job_id: "swarm-1", status: "success", swarm_type: "CouncilAsAJudge", execution_time: 8.4,
  output: [{ role: "Technical Judge", content: "Correct arithmetic." }, { role: "Aggregator", content: '{"verdict":"looks_good"}' }],
  usage: { total_cost: 0.0385, input_tokens: 10 },
};

describe("SwarmsClient.checkKey", () => {
  it("makes a GET to /v1/models/available with the x-api-key header", async () => {
    const t = fakeFetch(() => json(200, { success: true, count: 1, models: [] }));
    await new SwarmsClient({ fetch: t.f }).checkKey("k1");
    expect(t.seen[0]).toMatchObject({ url: "https://api.swarms.world/v1/models/available", method: "GET", headers: { "x-api-key": "k1" } });
    expect(t.seen[0].body).toBeUndefined();
  });

  it("maps 401 and 403 to ProviderAuthError and other failures to SwarmsUnavailable", async () => {
    for (const status of [401, 403]) {
      await expect(new SwarmsClient({ fetch: fakeFetch(() => json(status, { detail: "bad key" })).f }).checkKey("k")).rejects.toBeInstanceOf(ProviderAuthError);
    }
    const err = await new SwarmsClient({ fetch: fakeFetch(() => json(500, {})).f }).checkKey("k").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SwarmsUnavailable);
    expect((err as SwarmsUnavailable).reason).toBe("server");
  });
});

describe("SwarmsClient.run", () => {
  it("posts a minimal SwarmSpec and parses the list-shaped output, cost and job id", async () => {
    const t = fakeFetch(() => json(200, councilResponse));
    const run = await new SwarmsClient({ fetch: t.f }).run({
      apiKey: "k", swarmType: "CouncilAsAJudge", task: "Review this diff", name: "Nexus review", maxLoops: 1,
      extra: { council_judge_model_name: "some-model" },
    });
    expect(t.seen[0]).toMatchObject({ url: "https://api.swarms.world/v1/swarm/completions", method: "POST", headers: { "x-api-key": "k", "content-type": "application/json" } });
    expect(t.seen[0].body).toEqual({
      name: "Nexus review", swarm_type: "CouncilAsAJudge", task: "Review this diff", max_loops: 1, council_judge_model_name: "some-model",
      agents: [{ agent_name: "Reviewer", model_name: DEFAULT_AGENT_MODEL, max_loops: 1 }],
    });
    expect(run).toMatchObject({ jobId: "swarm-1", status: "success", costUsd: 0.0385, executionSeconds: 8.4 });
    expect(run.text).toBe('Correct arithmetic.\n\n{"verdict":"looks_good"}');
    expect(run.output).toEqual(councilResponse.output);
  });

  it("never sends tool, MCP or code fields, even if a caller passes them", async () => {
    const t = fakeFetch(() => json(200, councilResponse));
    const sneaky = { agent_name: "A", system_prompt: "p", tools_list_dictionary: [{ x: 1 }], mcp_url: "https://evil", selected_tools: ["run_bash"], mcp_config: {} } as unknown as AgentSpec;
    await new SwarmsClient({ fetch: t.f }).run({ apiKey: "k", swarmType: "HierarchicalSwarm", task: "t", agents: [sneaky] });
    const sent = JSON.stringify(t.seen[0].body);
    for (const bad of ["tools_list_dictionary", "mcp_", "selected_tools", "run_bash", "evil"]) expect(sent).not.toContain(bad);
    expect(t.seen[0].body!.agents).toEqual([{ agent_name: "A", system_prompt: "p", model_name: DEFAULT_AGENT_MODEL, max_loops: 1 }]);
  });

  it("redacts secrets in everything it sends", async () => {
    const t = fakeFetch(() => json(200, councilResponse));
    await new SwarmsClient({ fetch: t.f }).run({ apiKey: "k", swarmType: "CouncilAsAJudge", task: `diff has ${SECRET}`, agents: [{ agent_name: "A", system_prompt: `use ${SECRET}`, description: SECRET }] });
    expect(JSON.stringify(t.seen[0].body)).not.toContain("SECRETSECRET");
    expect(JSON.stringify(t.seen[0].body)).toContain("REDACTED");
  });

  it.each([
    [402, "no_credit"], [429, "rate_limited"], [422, "bad_request"], [400, "bad_request"], [404, "bad_request"],
    [502, "server"], [500, "server"], [401, "auth"],
  ] as const)("maps HTTP %i to reason %s", async (status, reason) => {
    const err = await new SwarmsClient({ fetch: fakeFetch(() => json(status, { detail: `problem ${SECRET}` })).f }).run({ apiKey: "k", swarmType: "CouncilAsAJudge", task: "t" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SwarmsUnavailable);
    expect((err as SwarmsUnavailable).reason).toBe(reason);
    expect((err as SwarmsUnavailable).message).toContain(`${status}`);
    expect((err as SwarmsUnavailable).message).not.toContain("SECRETSECRET");
  });

  it("reports a timeout, a network failure and bad bodies as unavailable", async () => {
    const hang = fakeFetch((): Promise<Response> => new Promise(() => {}));
    const slow = ((_url: string, init?: RequestInit) => new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const timedOut = await new SwarmsClient({ fetch: slow, timeoutMs: 20 }).run({ apiKey: "k", swarmType: "CouncilAsAJudge", task: "t" }).catch((e: unknown) => e);
    expect((timedOut as SwarmsUnavailable).reason).toBe("timeout");
    expect(hang.seen).toEqual([]);

    const down = (async () => { throw new Error(`ECONNRESET ${SECRET}`); }) as unknown as typeof fetch;
    const net = await new SwarmsClient({ fetch: down }).run({ apiKey: "k", swarmType: "CouncilAsAJudge", task: "t" }).catch((e: unknown) => e);
    expect((net as SwarmsUnavailable).reason).toBe("network");
    expect((net as SwarmsUnavailable).message).not.toContain("SECRETSECRET");

    const notJson = await new SwarmsClient({ fetch: fakeFetch(() => new Response("<html>", { status: 200 })).f }).run({ apiKey: "k", swarmType: "CouncilAsAJudge", task: "t" }).catch((e: unknown) => e);
    expect((notJson as SwarmsUnavailable).reason).toBe("bad_response");
    const wrongShape = await new SwarmsClient({ fetch: fakeFetch(() => json(200, null)).f }).run({ apiKey: "k", swarmType: "CouncilAsAJudge", task: "t" }).catch((e: unknown) => e);
    expect((wrongShape as SwarmsUnavailable).reason).toBe("bad_response");
  });

  it("enforces a per-session budget without making the call, and counts sessions separately", async () => {
    const t = fakeFetch(() => json(200, councilResponse));
    const c = new SwarmsClient({ fetch: t.f, budgetPerSession: 2 });
    const go = (sessionId?: string) => c.run({ apiKey: "k", sessionId, swarmType: "CouncilAsAJudge", task: "t" });
    await go("s1"); await go("s1");
    expect(c.remaining("s1")).toBe(0);
    const err = await go("s1").catch((e: unknown) => e);
    expect((err as SwarmsUnavailable).reason).toBe("budget");
    expect(t.seen).toHaveLength(2);
    await go("s2");
    expect(c.remaining("s2")).toBe(1);
    expect(c.remaining()).toBe(60);                                               // calls outside a session share a larger global budget
  });
});

describe("SwarmsClient hardening", () => {
  it("only allowlisted extras reach the request, they are redacted, and they can never override the fixed fields", async () => {
    const t = fakeFetch(() => json(200, councilResponse));
    const extra = {
      council_judge_model_name: "judge-" + SECRET, director_model_name: "dir",
      task: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", swarm_type: "X", agents: "[]", max_loops: "99", name: "evil",
      tools_list_dictionary: "[]", mcp_url: "https://evil", selected_tools: "run_bash",
    } as unknown as Record<string, string>;
    await new SwarmsClient({ fetch: t.f }).run({ apiKey: "k", swarmType: "CouncilAsAJudge", task: "real task", extra });
    const body = t.seen[0].body!;
    expect(body).toMatchObject({ swarm_type: "CouncilAsAJudge", task: "real task", max_loops: 1, name: "Nexus", director_model_name: "dir" });
    expect(body.council_judge_model_name).toBe("judge-[REDACTED:anthropic-key]");
    expect(Object.keys(body).sort()).toEqual(["agents", "council_judge_model_name", "director_model_name", "max_loops", "name", "swarm_type", "task"]);
    expect(JSON.stringify(body)).not.toMatch(/ghp_|evil|run_bash|tools_list|mcp_/);
  });

  it("the time limit also covers reading a response body that stalls", async () => {
    const stalled = (async (_u: string, init?: RequestInit) => {
      const body = new ReadableStream({ start(controller) { init!.signal!.addEventListener("abort", () => controller.error(new Error("aborted"))); } });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const err = await new SwarmsClient({ fetch: stalled, timeoutMs: 30 }).run({ apiKey: "k", swarmType: "CouncilAsAJudge", task: "t" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SwarmsUnavailable);
    expect((err as SwarmsUnavailable).reason).toBe("timeout");
  });

  it("calls outside a session use a separate, larger budget and report it when it runs out", async () => {
    const t = fakeFetch(() => json(200, councilResponse));
    const c = new SwarmsClient({ fetch: t.f, budgetPerSession: 1, globalBudget: 2 });
    await c.run({ apiKey: "k", swarmType: "CouncilAsAJudge", task: "t" });
    await c.run({ apiKey: "k", swarmType: "CouncilAsAJudge", task: "t" });
    const err = await c.run({ apiKey: "k", swarmType: "CouncilAsAJudge", task: "t" }).catch((e: unknown) => e);
    expect((err as SwarmsUnavailable).message).toContain("(2)");
    await c.run({ apiKey: "k", sessionId: "s1", swarmType: "CouncilAsAJudge", task: "t" });   // sessions are unaffected
  });
});

describe("SwarmsClient.complete", () => {
  it("posts an agent_config and task to /v1/agent/completions and reads outputs", async () => {
    const t = fakeFetch(() => json(200, { job_id: "j", success: true, outputs: [{ role: "assistant", content: "Summary text" }], usage: { total_cost: 0.01 } }));
    const res = await new SwarmsClient({ fetch: t.f }).complete({ apiKey: "k", system: "Be brief", task: `Summarize ${SECRET}`, modelName: "m1", maxTokens: 100 });
    expect(t.seen[0].url).toBe("https://api.swarms.world/v1/agent/completions");
    expect(t.seen[0].body).toEqual({ agent_config: { agent_name: "Nexus", system_prompt: "Be brief", model_name: "m1", max_loops: 1, max_tokens: 100 }, task: "Summarize [REDACTED:anthropic-key]" });
    expect(res).toEqual({ text: "Summary text", costUsd: 0.01 });
  });

  it("accepts a plain-string outputs field", async () => {
    const t = fakeFetch(() => json(200, { outputs: "plain" }));
    expect((await new SwarmsClient({ fetch: t.f }).complete({ apiKey: "k", task: "t" })).text).toBe("plain");
  });
});

describe("outputText / lastTurnText", () => {
  it("handles strings, turn lists, nested content, objects and nothing", () => {
    expect(outputText("hi")).toBe("hi");
    expect(outputText([{ role: "a", content: "one" }, "two", { role: "b", content: [{ content: "three" }] }])).toBe("one\n\ntwo\n\nthree");
    expect(outputText({ output: "inner" })).toBe("inner");
    expect(outputText({ weird: 1 })).toBe('{"weird":1}');
    expect(outputText(undefined)).toBe("");
    expect(outputText(null)).toBe("");
    expect(outputText(42)).toBe("42");
  });

  it("lastTurnText returns the final turn of a list and the whole text otherwise", () => {
    expect(lastTurnText([{ content: "a" }, { content: "b" }])).toBe("b");
    expect(lastTurnText("only")).toBe("only");
    expect(lastTurnText([])).toBe("");
  });
});
