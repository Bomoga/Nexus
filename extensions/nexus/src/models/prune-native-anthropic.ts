import type { ModelCallReceipt } from "../contracts";
import { redact } from "../shared/redact";
import { DEFAULT_MAX_TOKENS, toApiMessages } from "./anthropic";
import { PRUNE_BASE_URL, PRUNE_TIMEOUT_MS, inScope, routingAllowed, templateIdFor, type PruneConfig } from "./prune-adapter";
import { toReceipt, type PruneMetadata } from "./prune-receipt";
import type { Provider, StopReason, TurnEvent, TurnRequest } from "./provider";

// Anthropic-native Prune route (L1-S4b). Live tests on 2026-11-07 showed Prune's OpenAI-style /chat/completions cannot
// carry tool calls for Anthropic models, while POST {base}/proxy/anthropic/messages (header x-prune-key, Anthropic
// body, response = a normal Anthropic message plus a top-level `prune_metadata`) does. Same safety rules as
// prune-adapter.ts: model pinned for the agent role (checked on EVERY call), a Prune-blocked request is an error and is
// never resent elsewhere, an outage is retried ONCE directly against the provider with a note, everything sent is
// redacted, abort and timeouts honoured. Not wired into the registry or optimizer; the lead decides.

export const PRUNE_NATIVE_ANTHROPIC_PATH = "/proxy/anthropic/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

export type NativeRoute = "anthropic-messages" | "gemini-chat-completions";

/** Which provider ids have a verified Prune route that carries tool calls. Everything else stays out of all_roles. */
export function nativeRouteFor(providerId: string): NativeRoute | undefined {
  if (providerId === "anthropic") return "anthropic-messages";
  if (providerId === "google") return "gemini-chat-completions";
  return undefined;
}

// ---- Shared transport (also used by prune-native-gemini.ts) ----

export type PruneOutcome<T> =
  | { kind: "ok"; body: T }
  | { kind: "blocked"; message: string }                 // Prune refused: surfaced as an error, never resent
  | { kind: "cancelled" }
  | { kind: "unreachable"; reason: string };             // outage: one direct retry

async function blockedMessage(res: Response): Promise<string> {
  const code = res.headers.get("x-prune-shield-code");
  let detail = "";
  try {
    const j = (await res.json()) as { message?: string; error?: string | { message?: string } };
    const err = typeof j.error === "string" ? j.error : j.error?.message;
    detail = j.message ?? err ?? "";
  } catch { /* no JSON body */ }
  return `Prune refused the request (${res.status}${code ? ` ${code}` : ""})${detail ? `: ${redact(detail).slice(0, 300)}` : ""}. It was not sent anywhere else.`;
}

/** POSTs a JSON payload to Prune with the config's timeout and the caller's abort signal. */
export async function postToPrune<T>(cfg: PruneConfig, url: string, headers: Record<string, string>, payload: unknown, signal?: AbortSignal): Promise<PruneOutcome<T>> {
  const doFetch = cfg.fetch ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs ?? PRUNE_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let res: Response;
    try {
      res = await doFetch(url, { method: "POST", signal: ac.signal, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload) });
    } catch (e) {
      if (signal?.aborted) return { kind: "cancelled" };
      return { kind: "unreachable", reason: ac.signal.aborted ? "Prune did not answer in time" : `Prune could not be reached: ${redact(e instanceof Error ? e.message : "network error")}` };
    }
    if (res.status >= 500) return { kind: "unreachable", reason: `Prune answered ${res.status}` };
    if (!res.ok) return { kind: "blocked", message: await blockedMessage(res) };
    try { return { kind: "ok", body: (await res.json()) as T }; } catch {
      return signal?.aborted ? { kind: "cancelled" } : { kind: "unreachable", reason: "Prune returned a body that is not JSON" };
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Records the receipt and returns an error message when the served model may not answer this call. */
export function checkServedModel(cfg: PruneConfig, req: TurnRequest, md: PruneMetadata | undefined): { receipt: ModelCallReceipt; error?: string } {
  const receipt = toReceipt(md ?? {}, { callId: cfg.newCallId(), sessionId: cfg.sessionId, role: req.role, requestedModel: req.modelId, at: cfg.now() });
  cfg.onReceipt?.(receipt, md ?? {});
  if (receipt.servedModel !== req.modelId && !routingAllowed(cfg, req.role)) {
    return { receipt, error: `Prune answered with ${receipt.servedModel} instead of ${req.modelId}. ${req.role === "agent" ? "The coding agent is pinned to the model you picked" : "Model routing is off for this role"}; turn off model routing in the Prune dashboard. The answer was discarded.` };
  }
  return { receipt };
}

export const cancelled = (): TurnEvent => ({ type: "done", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "cancelled" });

export function baseOf(cfg: PruneConfig): string {
  return (cfg.baseUrl ?? PRUNE_BASE_URL).replace(/\/+$/, "");
}

// ---- Anthropic Messages mapping ----

function redactDeep(v: unknown): unknown {
  if (typeof v === "string") return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

interface MessagesResponse {
  content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number | null; output_tokens?: number | null };
  prune_metadata?: PruneMetadata;
}

const STOP: Record<string, StopReason | undefined> = { end_turn: "end_turn", stop_sequence: "end_turn", pause_turn: "end_turn", tool_use: "tool_use", max_tokens: "max_tokens" };

/** Wraps an Anthropic provider so in-scope calls go through Prune's Anthropic-native route (tool calls included). */
export function wrapAnthropicNative(direct: Provider, cfg: PruneConfig): Provider {
  const url = `${baseOf(cfg)}${PRUNE_NATIVE_ANTHROPIC_PATH}`;
  return {
    id: direct.id,
    listModels: key => direct.listModels(key),

    async *turn(req: TurnRequest, providerKey: string): AsyncIterable<TurnEvent> {
      if (!inScope(cfg.scope, req.role)) { yield* direct.turn(req, providerKey); return; }

      // Replayed assistant turns carry only {type,id,name,input}: extra keys echoed by the route cause a 400.
      const payload = {
        model: req.modelId, max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS, system: redact(req.system),
        messages: redactDeep(toApiMessages(req.messages)),
        ...(req.tools.length > 0 ? { tools: req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
        stream: false,
      };
      const out = await postToPrune<MessagesResponse>(cfg, url, {
        "x-prune-key": cfg.apiKey, "anthropic-version": ANTHROPIC_VERSION, "x-prune-template-id": templateIdFor(req.role),
      }, payload, req.signal);

      if (out.kind === "cancelled") { yield cancelled(); return; }
      if (out.kind === "blocked") { yield { type: "error", message: out.message }; return; }
      if (out.kind === "unreachable") {
        cfg.onNote?.(`${out.reason}; this call went directly to the provider.`);
        yield* direct.turn(req, providerKey);
        return;
      }

      const body = out.body;
      const checked = checkServedModel(cfg, req, body.prune_metadata);
      if (checked.error) { yield { type: "error", message: checked.error }; return; }

      const stop = body.stop_reason;
      if (!stop) { yield { type: "error", message: "The Anthropic response (via Prune) was not complete." }; return; }
      if (stop === "refusal") { yield { type: "error", message: "the model refused the request" }; return; }
      if (stop === "model_context_window_exceeded") { yield { type: "error", message: "the conversation no longer fits the model's context window" }; return; }

      for (const b of body.content ?? []) {
        if (b.type === "text" && b.text) yield { type: "text_delta", text: b.text };
        else if (b.type === "tool_use") yield { type: "tool_call", id: b.id ?? "", name: b.name ?? "", args: b.input ?? {} };
      }
      yield { type: "done", usage: { inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 }, stopReason: STOP[stop] ?? "end_turn" };
    },
  };
}
