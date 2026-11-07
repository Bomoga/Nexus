import type { AccountsService } from "./accounts-service";

// `Nexus: Connect provider` (PLAN L1-06): pick a provider, paste the key into a password box, verify it.
// The UI is a port so the flow is testable; register/lane-1.ts adapts it to vscode.window.

export interface ConnectUi {
  pickProvider(items: Array<{ id: string; label: string }>): Promise<string | undefined>;
  promptKey(label: string): Promise<string | undefined>;
  askYesNo(question: string): Promise<boolean | undefined>;
  info(message: string): void;
  error(message: string): void;
}

/** Providers whose key is stored for later use but cannot be verified by listing models. */
export interface AuxKeyStore {
  saveAuxKey(name: string, key: string): Promise<void>;
}

const AUX_LABELS: Record<string, string> = { prune: "Prune (API key)" };
const LABELS: Record<string, string> = {
  anthropic: "Anthropic (API key)",
  google: "Google Gemini (API key)",
  swarms: "Swarms (API key)",
};

export async function connectProvider(deps: { accounts: AccountsService; ui: ConnectUi; aux?: AuxKeyStore }): Promise<void> {
  const { accounts, ui, aux } = deps;
  const items = [
    ...accounts.supportedProviders().map(id => ({ id, label: LABELS[id] ?? `${id} (API key)` })),
    ...(aux ? Object.entries(AUX_LABELS).map(([id, label]) => ({ id, label })) : []),
  ];
  const picked = await ui.pickProvider(items);
  const chosen = items.find(i => i.id === picked);
  if (!chosen) return;                                      // cancelled, or an id that was never offered
  const { id: provider, label } = chosen;

  const key = await ui.promptKey(label);
  if (key === undefined) return;
  if (key.trim().length === 0) { ui.error("The API key was empty; nothing was saved."); return; }

  if (provider in AUX_LABELS) {
    await aux!.saveAuxKey(provider, key.trim());
    ui.info(`${label} saved. It is verified the first time Nexus uses it.`);
    return;
  }

  let billingEnabled: boolean | undefined;
  if (provider === "google") {
    billingEnabled = await ui.askYesNo("Is this key's Google Cloud project billing-enabled? (Unpaid-quota prompts may be used by Google to improve its products.)");
    if (billingEnabled === undefined) return;
  }

  try {
    const account = await accounts.connect(provider, key, { billingEnabled });
    if (account.status === "connected") {
      const n = accounts.models().filter(m => m.provider === provider).length;
      ui.info(`${label} connected: ${n} model${n === 1 ? "" : "s"} available.`);
    } else if (account.status === "invalid") {
      ui.error(`${label}: the provider rejected this key. Nothing was saved.`);
    } else {
      ui.error(`${label}: no key found.`);
    }
  } catch (e) {
    ui.error(e instanceof Error ? e.message : "Could not connect the provider.");
  }
}
