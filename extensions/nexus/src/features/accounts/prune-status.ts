import type { Unsubscribe } from "../ports";
import type { OptimizerService } from "./optimizer";

// The status bar's Prune readout (CLAUDE.md §6, model picker): "PRUNE $0.0123 · saved $0.0210" from this machine's
// receipts, shown while Prune is on or any call has been routed through it, hidden otherwise.

export interface PruneStatusUi {
  /** Shows the text, or hides the item when it is undefined. */
  set(text: string | undefined, tooltip: string): void;
}

export function startPruneStatus(optimizer: Pick<OptimizerService, "statusText" | "subscribe" | "onSettingChange">, ui: PruneStatusUi, onError?: (message: string) => void): Unsubscribe {
  let alive = true;
  const refresh = (): void => {
    optimizer.statusText().then(text => {
      if (alive) ui.set(text, "Nexus: spend and savings from Prune's receipts on this machine. Open the agent view for each call's receipt.");
    }, e => onError?.(`could not read Prune spend: ${e instanceof Error ? e.message : "unknown error"}`));
  };
  const offReceipt = optimizer.subscribe(refresh);
  const offSetting = optimizer.onSettingChange(refresh);
  refresh();
  return () => { alive = false; offReceipt(); offSetting(); };
}
