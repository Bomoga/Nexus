import type { DataUse } from "../contracts";

// What each provider's terms say about using prompts for training (CLAUDE.md §5 semantics: when unsure, "unknown",
// never a guess in the user's favor). Change an entry only with a source.

export interface DataUseFacts {
  dataUse: DataUse;
  dataLeavesMachine: boolean;
  /** Where the claim comes from, so the next reader can re-check it. */
  source: string;
}

export const DATA_USE: Record<string, DataUseFacts> = {
  anthropic: {
    dataUse: "not_used_for_training",
    dataLeavesMachine: true,
    source: "privacy.claude.com: commercial products (Anthropic API) are excluded from training by default (checked 2026-11-06)",
  },
  swarms: { dataUse: "unknown", dataLeavesMachine: true, source: "no published statement found; Swarms routes to its own model providers" },
  openai: { dataUse: "unknown", dataLeavesMachine: true, source: "not checked" },
  ollama: { dataUse: "not_used_for_training", dataLeavesMachine: false, source: "local models: nothing leaves the machine" },
};

/** Gemini depends on the Google project's billing: paid-tier prompts are not used, unpaid-quota prompts may be (CLAUDE.md §14). */
export const GEMINI_FACTS = {
  billingEnabled: { dataUse: "not_used_for_training", dataLeavesMachine: true, source: "CLAUDE.md §14: billing-enabled project" },
  unpaid: { dataUse: "may_be_used_for_training", dataLeavesMachine: true, source: "CLAUDE.md §14: unpaid quota; Google may use prompts and human reviewers may read them" },
} as const satisfies Record<string, DataUseFacts>;

export function dataUseFor(provider: string, opts: { billingEnabled?: boolean } = {}): DataUseFacts {
  if (provider === "google") return opts.billingEnabled ? GEMINI_FACTS.billingEnabled : GEMINI_FACTS.unpaid;
  return DATA_USE[provider] ?? { dataUse: "unknown", dataLeavesMachine: true, source: "unlisted provider" };
}
