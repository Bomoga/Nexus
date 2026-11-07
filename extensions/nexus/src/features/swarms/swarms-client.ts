import { z } from "zod";
import { ProviderAuthError } from "../../models/provider";
import { redact } from "../../shared/redact";

// Swarms API client (PLAN L1-17), plain REST, text only (CLAUDE.md §14). Facts from the API reference
// (docs.swarms.ai swarm_completions, fetched 2026-11-07): POST /v1/swarm/completions and POST /v1/agent/completions
// with an `x-api-key` header; GET /v1/models/available answers 401 on a bad key. We never send tool, MCP or code
// fields, every outbound string is redacted, every call has a time limit, and each session has a request budget.
// Nothing that comes back is executed: it is text a human reads.

export const SWARMS_BASE_URL = "https://api.swarms.world";
export const DEFAULT_TIMEOUT_MS = 45_000;
export const DEFAULT_BUDGET_PER_SESSION = 6;
export const DEFAULT_AGENT_MODEL = "claude-sonnet-5";     // the API's documented default model_name

export type UnavailableReason = "timeout" | "budget" | "rate_limited" | "no_credit" | "auth" | "server" | "bad_request" | "bad_response" | "network";

/** The feature degrades instead of failing the flow: a review becomes "unavailable", a plan is not offered. */
export class SwarmsUnavailable extends Error {
  constructor(readonly reason: UnavailableReason, message: string) {
    super(message);
    this.name = "SwarmsUnavailable";
  }
}

export interface AgentSpec {
  agent_name: string;
  description?: string;
  system_prompt?: string;
  model_name?: string;
  max_loops?: number;
  max_tokens?: number;
  temperature?: number;
  role?: string;
}

export interface SwarmRunInput {
  apiKey: string;
  /** Budget key: the agent session (or "global" for calls outside a session). */
  sessionId?: string;
  swarmType: "CouncilAsAJudge" | "HierarchicalSwarm" | (string & {});
  task: string;
  agents?: AgentSpec[];
  maxLoops?: number;
  name?: string;
  /** Extra top-level SwarmSpec fields such as council_judge_model_name or director_model_name. */
  extra?: Record<string, string | number | boolean>;
}

export interface SwarmRun {
  jobId?: string;
  status?: string;
  /** Best-effort text of the result; the raw `output` is kept for callers that know the swarm type. */
  text: string;
  output: unknown;
  costUsd?: number;
  executionSeconds?: number;
}

export interface SwarmsClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  budgetPerSession?: number;
}

const SwarmResponse = z.object({
  job_id: z.string().optional(),
  status: z.string().optional(),
  output: z.unknown().optional(),
  execution_time: z.number().optional(),
  usage: z.object({ total_cost: z.number().optional() }).passthrough().optional(),
}).passthrough();

const AgentResponse = z.object({
  job_id: z.string().optional(),
  outputs: z.unknown().optional(),
  usage: z.object({ total_cost: z.number().optional() }).passthrough().optional(),
}).passthrough();

/** The text of a swarm `output`, whose shape varies by swarm type: string, list of {role, content} turns, or object. */
export function outputText(output: unknown, depth = 0): string {
  if (typeof output === "string") return output;
  if (output === null || output === undefined || depth > 4) return "";
  if (Array.isArray(output)) return output.map(o => outputText(o, depth + 1)).filter(t => t.length > 0).join("\n\n");
  if (typeof output === "object") {
    const o = output as Record<string, unknown>;
    for (const key of ["content", "output", "text", "response"]) {
      if (key in o) { const t = outputText(o[key], depth + 1); if (t.length > 0) return t; }
    }
    return JSON.stringify(output);
  }
  return String(output);
}

/** The last turn of a list-shaped output, which is where aggregated answers (judge, director) come last. */
export function lastTurnText(output: unknown): string {
  return Array.isArray(output) && output.length > 0 ? outputText(output[output.length - 1]) : outputText(output);
}

export class SwarmsClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly budget: number;
  private readonly used = new Map<string, number>();

  constructor(opts: SwarmsClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? SWARMS_BASE_URL).replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.budget = opts.budgetPerSession ?? DEFAULT_BUDGET_PER_SESSION;
  }

  /** Calls left for a session. */
  remaining(sessionId = "global"): number {
    return Math.max(0, this.budget - (this.used.get(sessionId) ?? 0));
  }

  /** Verifies a key with a real call that costs nothing; throws ProviderAuthError when the key is rejected. */
  async checkKey(apiKey: string): Promise<void> {
    try {
      await this.request("GET", "/v1/models/available", apiKey);
    } catch (e) {
      if (e instanceof SwarmsUnavailable && e.reason === "auth") throw new ProviderAuthError();
      throw e;
    }
  }

  async run(input: SwarmRunInput): Promise<SwarmRun> {
    this.spend(input.sessionId);
    const agents = (input.agents ?? [{ agent_name: "Reviewer", model_name: DEFAULT_AGENT_MODEL }]).map(a => this.cleanAgent(a));
    const body = {
      name: input.name ?? "Nexus",
      swarm_type: input.swarmType,
      task: redact(input.task),
      agents,
      max_loops: input.maxLoops ?? 1,
      ...input.extra,
    };
    const json = await this.request("POST", "/v1/swarm/completions", input.apiKey, body);
    const parsed = SwarmResponse.safeParse(json);
    if (!parsed.success) throw new SwarmsUnavailable("bad_response", "Swarms returned an unexpected response.");
    const r = parsed.data;
    return { jobId: r.job_id, status: r.status, output: r.output, text: outputText(r.output), costUsd: r.usage?.total_cost, executionSeconds: r.execution_time };
  }

  /** One agent, one task: used by the Swarms text-role provider. */
  async complete(input: { apiKey: string; sessionId?: string; system?: string; task: string; modelName?: string; maxTokens?: number }): Promise<{ text: string; costUsd?: number }> {
    this.spend(input.sessionId);
    const body = {
      agent_config: this.cleanAgent({ agent_name: "Nexus", system_prompt: input.system, model_name: input.modelName ?? DEFAULT_AGENT_MODEL, max_loops: 1, max_tokens: input.maxTokens ?? 4096 }),
      task: redact(input.task),
    };
    const json = await this.request("POST", "/v1/agent/completions", input.apiKey, body);
    const parsed = AgentResponse.safeParse(json);
    if (!parsed.success) throw new SwarmsUnavailable("bad_response", "Swarms returned an unexpected response.");
    return { text: outputText(parsed.data.outputs), costUsd: parsed.data.usage?.total_cost };
  }

  // ---- internals ----

  private spend(sessionId = "global"): void {
    const n = this.used.get(sessionId) ?? 0;
    if (n >= this.budget) throw new SwarmsUnavailable("budget", `The Swarms request budget for this session (${this.budget}) is used up.`);
    this.used.set(sessionId, n + 1);
  }

  /** Only plain text fields are ever sent: no tools, MCP, code or image fields. */
  private cleanAgent(a: AgentSpec): AgentSpec {
    return {
      agent_name: a.agent_name, ...(a.description ? { description: redact(a.description) } : {}),
      ...(a.system_prompt ? { system_prompt: redact(a.system_prompt) } : {}),
      model_name: a.model_name ?? DEFAULT_AGENT_MODEL, max_loops: a.max_loops ?? 1,
      ...(a.max_tokens ? { max_tokens: a.max_tokens } : {}), ...(a.temperature !== undefined ? { temperature: a.temperature } : {}),
      ...(a.role ? { role: a.role } : {}),
    };
  }

  private async request(method: "GET" | "POST", path: string, apiKey: string, body?: unknown): Promise<unknown> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}${path}`, {
        method, signal: ac.signal,
        headers: { "x-api-key": apiKey, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      if (ac.signal.aborted) throw new SwarmsUnavailable("timeout", `Swarms did not answer within ${Math.round(this.timeoutMs / 1000)} s.`);
      throw new SwarmsUnavailable("network", `Could not reach Swarms: ${redact(e instanceof Error ? e.message : "network error")}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      try { return await res.json(); } catch { throw new SwarmsUnavailable("bad_response", "Swarms returned a body that is not JSON."); }
    }
    throw new SwarmsUnavailable(reasonFor(res.status), `Swarms answered ${res.status}${await detail(res)}`);
  }
}

function reasonFor(status: number): UnavailableReason {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "no_credit";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";            // includes 502 from HierarchicalSwarm when the director gave no valid orders
  return "bad_request";                          // 400, 404, 422: a problem with what we sent
}

async function detail(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { detail?: unknown };
    const d = typeof j.detail === "string" ? j.detail : j.detail === undefined ? "" : JSON.stringify(j.detail);
    return d ? `: ${redact(d).slice(0, 300)}` : "";
  } catch {
    return "";
  }
}
