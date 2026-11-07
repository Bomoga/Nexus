import type { ModelCallReceipt } from "../contracts";
import { redact } from "../shared/redact";
import { PRUNE_BASE_URL, PRUNE_TIMEOUT_MS, routingAllowed, type PruneConfig } from "./prune-adapter";
import { toReceipt, type PruneMetadata } from "./prune-receipt";
import type { TurnEvent, TurnRequest } from "./provider";

// Helpers shared by the Prune native-route wrappers (L1-S4b): transport, refusal text, served-model checks.

export type NativeRoute = "anthropic-messages" | "gemini-chat-completions";

/** Which provider ids have a verified Prune route that carries tool calls. Everything else stays out of all_roles. */
export function nativeRouteFor(providerId: string): NativeRoute | undefined {
  if (providerId === "anthropic") return "anthropic-messages";
  if (providerId === "google") return "gemini-chat-completions";
  return undefined;
}

export function baseOf(cfg: PruneConfig): string {
  return (cfg.baseUrl ?? PRUNE_BASE_URL).replace(/\/+$/, "");
}

export const cancelled = (): TurnEvent => ({ type: "done", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "cancelled" });

/** Redacts every string anywhere inside a value (messages, tool arguments, tool results). */
export function redactDeep(v: unknown): unknown {
  if (typeof v === "string") return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

export type PruneOutcome<T> =
  | { kind: "ok"; body: T }
  | { kind: "blocked"; message: string }                 // Prune refused: surfaced as an error, never resent
  | { kind: "cancelled" }
  | { kind: "unreachable"; reason: string };             // outage: one direct retry

// Same wording as prune-adapter.ts.
async function blockedMessage(res: Response): Promise<string> {
  const code = res.headers.get("x-prune-shield-code");
  let detail = "";
  try {
    const j = (await res.json()) as { message?: string; error?: string | { message?: string }; code?: string };
    detail = j.message ?? (typeof j.error === "string" ? j.error : j.error?.message) ?? "";
    if (!code && j.code) return `Prune refused the request (${res.status} ${j.code}): ${redact(detail).slice(0, 300)}`;
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

/** True when `served` is `requested`, or `requested` plus a trailing -YYYYMMDD date on the same base id. */
export function sameModel(requested: string, served: string): boolean {
  return served === requested || (served.startsWith(requested) && /^-\d{8}$/.test(served.slice(requested.length)));
}

export interface BodyModel {
  /** The model field of the provider response itself (Anthropic `model`, Gemini `modelVersion`). */
  value?: string;
  /** strict: a difference is a mismatch (Anthropic). Otherwise it is only noted (Gemini's modelVersion can legitimately differ). */
  strict: boolean;
}

/**
 * Records the receipt and says whether the answer may be used. Pinned on Prune's routed_model when it reports one;
 * otherwise on the response's own model field (strict) or a note (soft). With no prune_metadata at all the served model
 * is unverified, and the agent role discards the answer.
 */
export function checkServedModel(cfg: PruneConfig, req: TurnRequest, md: PruneMetadata | undefined, bodyModel?: BodyModel): { receipt: ModelCallReceipt; error?: string } {
  let effective: PruneMetadata = md ?? {};
  const noRouted = typeof effective.routed_model !== "string" || effective.routed_model.length === 0;
  const bm = bodyModel?.value;
  if (noRouted && bm && !sameModel(req.modelId, bm)) {
    if (bodyModel.strict) effective = { ...effective, routed_model: bm };
    else cfg.onNote?.(`Prune did not report a routed model and the response says ${bm} for a request of ${req.modelId}; keeping the answer.`);
  }
  const receipt = toReceipt(effective, { callId: cfg.newCallId(), sessionId: cfg.sessionId, role: req.role, requestedModel: req.modelId, at: cfg.now() });
  cfg.onReceipt?.(receipt, effective);

  if (!md && req.role === "agent") {
    return { receipt, error: "Prune did not report which model served this call (no prune_metadata), so the agent answer could not be verified and was discarded." };
  }
  if (receipt.servedModel !== req.modelId && !sameModel(req.modelId, receipt.servedModel) && !routingAllowed(cfg, req.role)) {
    return { receipt, error: `Prune answered with ${receipt.servedModel} instead of ${req.modelId}. ${req.role === "agent" ? "The coding agent is pinned to the model you picked" : "Model routing is off for this role"}; turn off model routing in the Prune dashboard. The answer was discarded.` };
  }
  return { receipt };
}
