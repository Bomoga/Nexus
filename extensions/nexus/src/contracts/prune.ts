import { z } from "zod";
import { Id, IsoTime } from "./common";

export const OptimizerSetting = z.object({
  enabled: z.boolean(),                                  // off by default (§14)
  scope: z.enum(["text_roles", "all_roles"]),            // all_roles only once tool-calling passthrough is verified
  allowModelRouting: z.boolean(),                        // always false for role "agent"; enforced in the adapter
}).strict();
export type OptimizerSetting = z.infer<typeof OptimizerSetting>;
export const DEFAULT_OPTIMIZER: OptimizerSetting = { enabled: false, scope: "text_roles", allowModelRouting: false };

export const ModelCallReceipt = z.object({
  callId: Id,
  sessionId: Id.optional(),
  role: z.union([z.enum(["agent", "brief", "summary", "approval_wording", "swarm_input"]), z.string()]),
  requestedModel: z.string(),
  servedModel: z.string(),
  costUsd: z.number().nonnegative(),
  baselineCostUsd: z.number().nonnegative().optional(),
  optimizations: z.array(z.string()),                    // as reported: "cache_hit", "prompt_trimmed", "routed", "output_cap"
  pruneReceiptId: z.string(),                            // verifiable at Prune's /verify
  at: IsoTime,
}).strict();

export const SpendSummary = z.object({                   // status bar totals (derived from receipts)
  sessionId: Id.optional(),
  calls: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  savedUsd: z.number().nonnegative(),                    // sum(baseline - cost) where baseline is known
}).strict();

export type ModelCallReceipt = z.infer<typeof ModelCallReceipt>;
export type SpendSummary = z.infer<typeof SpendSummary>;
