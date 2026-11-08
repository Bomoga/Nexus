import type { ModelInfo, ProviderAccount } from "../../src/contracts";

const DATA_USE_LABEL = {
  not_used_for_training: "not used for training",
  may_be_used_for_training: "may be used for training",
  unknown: "data use unknown",
} as const;

/** One picker line per model: name, provider, what the provider's terms say about the data, and whether it leaves the machine (CLAUDE.md section 5). */
export function modelLabel(m: ModelInfo, account: ProviderAccount | undefined, viaPrune: boolean): string {
  // Through Prune (all_roles) the payload also goes to the Prune service, whatever the provider says (CLAUDE.md section 14).
  const use = viaPrune ? DATA_USE_LABEL.unknown : DATA_USE_LABEL[account?.dataUse ?? "unknown"];
  // No account means we cannot say the data stays local, so assume it leaves.
  const leaves = viaPrune || !account || account.dataLeavesMachine;
  return `${m.displayName} | ${m.provider} | ${use}${leaves ? " | LEAVES MACHINE" : ""}`;
}
