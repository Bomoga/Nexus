import type { DataUse, ModelInfo, ModelRole, OptimizerSetting, ProviderAccount } from "../../contracts";
import { roleEligible } from "../../models/provider";
import type { StateStore } from "./accounts-service";

// The status bar model picker (PLAN L1-07): a status bar item showing the chosen agent model, and a quick pick of
// the models each connected key returned, grouped by provider, with its data-use label. Built-in QuickPick only.

export type PickerItem =
  | { kind: "separator"; label: string }
  | { kind: "model"; label: string; description: string; detail: string; model: ModelInfo }
  | { kind: "optimizer"; label: string; description: string; detail: string };

export interface PickerUi {
  showPick(items: PickerItem[], placeHolder: string): Promise<PickerItem | undefined>;
  setStatus(text: string, tooltip: string): void;
}

export interface AccountsView {
  list(): Promise<ProviderAccount[]>;
  models(role?: ModelRole): ModelInfo[];
}

/** The "Optimize with Prune" toggle; its implementation is L1-21. Without it the picker shows no such row. */
export interface OptimizerView {
  get(): OptimizerSetting;
  toggle(): Promise<void>;
}

export interface ChosenModel {
  provider: string;
  modelId: string;
}

export const DATA_USE_LABELS: Record<DataUse, string> = {
  not_used_for_training: "not used for training",
  may_be_used_for_training: "may be used for training",
  unknown: "data use unknown",
};

const stateKey = (role: ModelRole) => `nexus.model.${role}`;

export class ModelPicker {
  constructor(private readonly deps: { accounts: AccountsView; state: StateStore; ui: PickerUi; optimizer?: OptimizerView }) {}

  /** The remembered choice for a role, only while that model is still returned by a connected, eligible account. */
  selected(role: ModelRole = "agent"): ChosenModel | undefined {
    const saved = this.deps.state.get<ChosenModel>(stateKey(role));
    if (!saved) return undefined;
    return this.deps.accounts.models(role).some(m => m.provider === saved.provider && m.modelId === saved.modelId) ? saved : undefined;
  }

  async choose(role: ModelRole, model: ChosenModel): Promise<void> {
    await this.deps.state.update(stateKey(role), { provider: model.provider, modelId: model.modelId });
    await this.refreshStatus();
  }

  async refreshStatus(): Promise<void> {
    const chosen = this.selected("agent");
    if (!chosen) {
      this.deps.ui.setStatus("⬡ pick a model", "Nexus: no agent model selected. Click to choose one.");
      return;
    }
    const account = (await this.deps.accounts.list()).find(a => a.provider === chosen.provider);
    const use = account ? `${DATA_USE_LABELS[account.dataUse]}${account.dataLeavesMachine ? ", leaves this machine" : ""}` : "";
    this.deps.ui.setStatus(`⬡ ${chosen.provider} · ${chosen.modelId}`, `Nexus agent model: ${chosen.provider} ${chosen.modelId}${use ? ` (${use})` : ""}. Click to change.`);
  }

  /** Items for the quick pick. Only agent-eligible models appear (tool calling, never Swarms). */
  async buildItems(): Promise<PickerItem[]> {
    const accounts = await this.deps.accounts.list();
    const models = this.deps.accounts.models("agent").filter(m => roleEligible(m, "agent"));
    const items: PickerItem[] = [];
    const providers = [...new Set(models.map(m => m.provider))];
    for (const provider of providers) {
      const account = accounts.find(a => a.provider === provider);
      const use = account ? `${DATA_USE_LABELS[account.dataUse]}${account.dataLeavesMachine ? " · leaves machine" : ""}` : DATA_USE_LABELS.unknown;
      items.push({ kind: "separator", label: account?.label ?? provider });
      for (const m of models.filter(x => x.provider === provider)) {
        items.push({ kind: "model", label: m.displayName, description: m.modelId, detail: use, model: m });
      }
    }
    const opt = this.deps.optimizer;
    if (opt) {
      const on = opt.get().enabled;
      items.push({ kind: "separator", label: "Optimization" });
      items.push({
        kind: "optimizer",
        label: `Optimize with Prune: ${on ? "ON" : "OFF"}`,
        description: on ? "click to turn off" : "click to turn on",
        detail: "Prune routes model calls through its servers: data use unknown · leaves machine",
      });
    }
    return items;
  }

  /** Opens the quick pick; returns what happened so callers (and tests) can react. */
  async pick(): Promise<"model" | "optimizer" | "none" | "empty"> {
    const items = await this.buildItems();
    if (!items.some(i => i.kind === "model")) return "empty";
    const picked = await this.deps.ui.showPick(items, "Pick the model for the coding agent");
    if (!picked) return "none";
    if (picked.kind === "model") {
      await this.choose("agent", picked.model);
      return "model";
    }
    if (picked.kind === "optimizer" && this.deps.optimizer) {
      await this.deps.optimizer.toggle();
      await this.refreshStatus();
      return "optimizer";
    }
    return "none";
  }
}
