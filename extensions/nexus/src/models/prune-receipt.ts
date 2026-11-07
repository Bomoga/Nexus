import { ModelCallReceipt, type ModelRole } from "../contracts";

// Prune receipts (PLAN L1-20). Facts from withprune.com/docs, fetched 2026-11-06: a response body carries
// `prune_metadata` with original_model, routed_model, optimizations_applied, cache_hit, cost_with_prune_usd,
// cost_without_prune_usd, receipt_signature (Ed25519, base64) and receipt_signing_key_id. No separate receipt id is
// documented, so the signature is the receipt id; the full metadata is what the public verify page checks.

export const PRUNE_VERIFY_URL = "https://withprune.com/verify";

export interface PruneMetadata {
  cache_hit?: boolean;
  original_model?: string;
  routed_model?: string;
  route_applied?: boolean;
  optimizations_applied?: unknown;
  cost_with_prune_usd?: number;
  cost_without_prune_usd?: number;
  cost_saved?: number;
  receipt_signature?: string;
  receipt_signing_key_id?: string;
  [key: string]: unknown;
}

export interface ReceiptContext {
  callId: string;
  sessionId?: string;
  role: ModelRole;
  requestedModel: string;
  at: string;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Optimizations as Prune reports them (strings such as "model_routing", "output_cap:400"), plus cache_hit. */
export function optimizationsOf(md: PruneMetadata): string[] {
  const listed = Array.isArray(md.optimizations_applied) ? md.optimizations_applied.filter((o): o is string => typeof o === "string") : [];
  return md.cache_hit === true && !listed.includes("cache_hit") ? ["cache_hit", ...listed] : listed;
}

export function toReceipt(md: PruneMetadata, ctx: ReceiptContext): ModelCallReceipt {
  const cost = num(md.cost_with_prune_usd);
  const baseline = num(md.cost_without_prune_usd);
  const optimizations = optimizationsOf(md);
  return ModelCallReceipt.parse({
    callId: ctx.callId,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    role: ctx.role,
    requestedModel: ctx.requestedModel,
    servedModel: str(md.routed_model) ?? ctx.requestedModel,        // never assumed to be the requested model once Prune reports one
    costUsd: cost ?? 0,
    ...(baseline !== undefined ? { baselineCostUsd: baseline } : {}),
    optimizations: cost === undefined ? [...optimizations, "cost_unreported"] : optimizations,
    pruneReceiptId: str(md.receipt_signature) ?? `unsigned:${ctx.callId}`,
    at: ctx.at,
  });
}

/** True when the receipt can be checked on Prune's verify page (it carries a signature). */
export function isVerifiable(md: PruneMetadata | undefined): boolean {
  return !!md && typeof md.receipt_signature === "string" && md.receipt_signature.length > 0;
}
