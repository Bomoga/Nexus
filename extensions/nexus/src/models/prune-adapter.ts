import type { ModelCallReceipt, ModelRole } from "../contracts";
import { redact } from "../shared/redact";
import { toReceipt, type PruneMetadata } from "./prune-receipt";
import type { Provider, StopReason, TurnEvent, TurnMessage, TurnRequest } from "./provider";

// Prune gateway adapter (PLAN L1-20, CLAUDE.md §5 Prune semantics and §14). When "Optimize with Prune" is on, calls in
// scope go through Prune's OpenAI-compatible endpoint and each yields a ModelCallReceipt from the response's signed
// `prune_metadata`. Documented contract (withprune.com/docs, 2026-11-06): POST {base}/chat/completions, the Prune key as
// a Bearer token, the model id in the body, provider keys held in Prune's vault (so no provider key is sent), responses
// non-streaming here. Whether tool calls pass through for Anthropic and Gemini models is NOT documented, so by default
// the agent role is out of scope (scope "text_roles") until the live check (smoke L1-S4) says otherwise.
//
//  - The code-editing agent is never answered by a different model: if Prune reports routing it elsewhere, the answer is
//    discarded and the call fails with the receipt recorded (routing is a dashboard toggle, not a per-request flag).
//  - A request Prune blocks (403 shield codes, quota, caps) is a clear error and is never resent elsewhere.
//  - A Prune outage (5xx, timeout, network) is retried ONCE directly against the provider, and the session notes it.

export const PRUNE_BASE_URL = "https://api.withprune.com/v1";
export const PRUNE_TIMEOUT_MS = 60_000;

export interface PruneConfig {
  /** The Prune API key (SecretStorage; passed per wrap, never stored on the provider). */
  apiKey: string;
  scope: "text_roles" | "all_roles";
  allowModelRouting: boolean;
  sessionId?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  newCallId(): string;
  now(): string;
  onReceipt?(receipt: ModelCallReceipt, metadata: PruneMetadata): void;
  /** Called when a call fell back to the provider directly, so the session can say so. */
  onNote?(note: string): void;
}

export function inScope(scope: PruneConfig["scope"], role: ModelRole): boolean {
  return scope === "all_roles" || role !== "agent";
}

/** Routing to another model is allowed only for text roles, and only when the user enabled it. Never for the agent. */
export function routingAllowed(cfg: Pick<PruneConfig, "allowModelRouting">, role: ModelRole): boolean {
  return cfg.allowModelRouting && role !== "agent";
}

// ---- OpenAI chat-completions mapping ----

interface OaiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export function toOpenAiMessages(system: string, messages: readonly TurnMessage[]): OaiMessage[] {
  const out: OaiMessage[] = [];
  if (system.length > 0) out.push({ role: "system", content: redact(system) });
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: redact(m.content) });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant", content: m.content.length > 0 ? redact(m.content) : null,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) } : {}),
      });
    } else out.push({ role: "tool", tool_call_id: m.toolCallId, content: redact(m.content) });
  }
  return out;
}

interface OaiResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  prune_metadata?: PruneMetadata;
}

const FINISH: Record<string, StopReason | undefined> = { stop: "end_turn", tool_calls: "tool_use", length: "max_tokens", function_call: "tool_use" };

class Unreachable extends Error {}

async function blockedMessage(res: Response): Promise<string> {
  const code = res.headers.get("x-prune-shield-code");
  let detail = "";
  try {
    const j = (await res.json()) as { message?: string; error?: string; code?: string };
    detail = j.message ?? j.error ?? "";
    if (!code && j.code) return `Prune refused the request (${res.status} ${j.code}): ${redact(detail).slice(0, 300)}`;
  } catch { /* no JSON body */ }
  return `Prune refused the request (${res.status}${code ? ` ${code}` : ""})${detail ? `: ${redact(detail).slice(0, 300)}` : ""}. It was not sent anywhere else.`;
}

/** Wraps a provider: calls in scope go through Prune; everything else is the untouched provider. */
export function wrapProvider(direct: Provider, cfg: PruneConfig): Provider {
  const doFetch = cfg.fetch ?? fetch;
  const base = (cfg.baseUrl ?? PRUNE_BASE_URL).replace(/\/+$/, "");

  return {
    id: direct.id,
    listModels: key => direct.listModels(key),                   // listing and key checks always go straight to the provider

    async *turn(req: TurnRequest, providerKey: string): AsyncIterable<TurnEvent> {
      if (!inScope(cfg.scope, req.role)) { yield* direct.turn(req, providerKey); return; }

      const callId = cfg.newCallId();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), cfg.timeoutMs ?? PRUNE_TIMEOUT_MS);
      const onAbort = () => ac.abort();
      req.signal?.addEventListener("abort", onAbort, { once: true });

      let body: OaiResponse;
      let metadata: PruneMetadata | undefined;
      try {
        let res: Response;
        try {
          res = await doFetch(`${base}/chat/completions`, {
            method: "POST", signal: ac.signal,
            headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({
              model: req.modelId, messages: toOpenAiMessages(req.system, req.messages), stream: false,
              ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
              ...(req.tools.length > 0 ? { tools: req.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}),
            }),
          });
        } catch (e) {
          if (req.signal?.aborted) { yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "cancelled" }; return; }
          throw new Unreachable(ac.signal.aborted ? "Prune did not answer in time" : `Prune could not be reached: ${redact(e instanceof Error ? e.message : "network error")}`);
        }
        if (res.status >= 500) throw new Unreachable(`Prune answered ${res.status}`);
        if (!res.ok) { yield { type: "error", message: await blockedMessage(res) }; return; }     // blocked: never resent elsewhere
        try { body = (await res.json()) as OaiResponse; } catch { throw new Unreachable("Prune returned a body that is not JSON"); }
        metadata = body.prune_metadata;
      } catch (e) {
        if (!(e instanceof Unreachable)) throw e;
        cfg.onNote?.(`${e.message}; this call went directly to the provider.`);
        yield* direct.turn(req, providerKey);                    // one direct retry, noted on the session
        return;
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
      }

      // Record what actually happened, honestly, before deciding whether the answer may be used.
      const md = metadata ?? {};
      const receipt = toReceipt(md, { callId, sessionId: cfg.sessionId, role: req.role, requestedModel: req.modelId, at: cfg.now() });
      cfg.onReceipt?.(receipt, md);

      if (receipt.servedModel !== req.modelId && !routingAllowed(cfg, req.role)) {
        yield { type: "error", message: `Prune answered with ${receipt.servedModel} instead of ${req.modelId}. ${req.role === "agent" ? "The coding agent is pinned to the model you picked" : "Model routing is off for this role"}; turn off model routing in the Prune dashboard. The answer was discarded.` };
        return;
      }

      const choice = body.choices?.[0];
      const text = choice?.message?.content;
      if (typeof text === "string" && text.length > 0) yield { type: "text_delta", text };
      let sawTool = false;
      for (const [i, c] of (choice?.message?.tool_calls ?? []).entries()) {
        let args: unknown;
        try { args = c.function?.arguments?.trim() ? JSON.parse(c.function.arguments) : {}; } catch {
          yield { type: "error", message: `the model sent malformed arguments for tool ${c.function?.name ?? "?"}` };
          return;
        }
        sawTool = true;
        yield { type: "tool_call", id: c.id ?? `prune_call_${i + 1}`, name: c.function?.name ?? "", args };
      }
      const stopReason: StopReason = sawTool ? "tool_use" : (FINISH[choice?.finish_reason ?? ""] ?? "end_turn");
      yield { type: "done", usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 }, stopReason };
    },
  };
}
