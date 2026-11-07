import type { ModelInfo, ModelRole, ProviderAccount, Req, Res } from "../../contracts";
import { dataUseFor } from "../../models/data-use";
import { ListingCache } from "../../models/listing-cache";
import { ProviderAuthError, roleEligible, type Provider } from "../../models/provider";
import { redact } from "../../shared/redact";

// Provider accounts (PLAN L1-06). Keys live only in SecretStorage (or, in development, NEXUS_<PROVIDER>_KEY when
// SecretStorage is empty). A ProviderAccount never carries a key, and its status comes from a real listModels call,
// never from "a key was saved" (CLAUDE.md §5).

/** vscode.SecretStorage, narrowed. An in-memory map implements it in tests. */
export interface SecretStore {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

/** vscode.Memento, narrowed. */
export interface StateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface AccountsDeps {
  secrets: SecretStore;
  state: StateStore;
  /** Providers that can list models in this process, by id. Only these can be connected. */
  providers: Record<string, Provider>;
  env?: NodeJS.ProcessEnv;
  cache?: ListingCache;
}

const LABELS: Record<string, string> = {
  anthropic: "Anthropic (API key)",
  google: "Google Gemini (API key)",
  swarms: "Swarms (API key)",
};
const ORDER = ["anthropic", "google", "swarms"];

export const secretKeyFor = (provider: string) => `nexus.key.${provider}`;
export const accountIdFor = (provider: string) => `acc_${provider}`;
const providerOf = (accountId: string) => accountId.replace(/^acc_/, "");
const billingStateKey = "nexus.google.billingEnabled";

export class AccountsService {
  private readonly cache: ListingCache;

  constructor(private readonly deps: AccountsDeps) {
    this.cache = deps.cache ?? new ListingCache();
  }

  /** Provider ids that can be connected here, in picker order. */
  supportedProviders(): string[] {
    const ids = Object.keys(this.deps.providers);
    return [...ORDER.filter(p => ids.includes(p)), ...ids.filter(p => !ORDER.includes(p)).sort()];
  }

  /** The key for one provider call, or undefined. Used by the credentials.get handler; never returned to a webview. */
  async getKey(provider: string): Promise<string | undefined> {
    const stored = await this.deps.secrets.get(secretKeyFor(provider));
    if (stored) return stored;
    const fromEnv = (this.deps.env ?? process.env)[`NEXUS_${provider.toUpperCase()}_KEY`];
    return fromEnv ? fromEnv : undefined;
  }

  /** Stores the key, verifies it with a real listing, and drops it again if the provider rejects it. */
  async connect(provider: string, key: string, opts: { billingEnabled?: boolean } = {}): Promise<ProviderAccount> {
    if (!Object.hasOwn(this.deps.providers, provider)) throw new Error(`${LABELS[provider] ?? provider} cannot be connected yet.`);
    const trimmed = key.trim();
    if (trimmed.length === 0) throw new Error("The API key is empty.");
    if (provider === "google") await this.deps.state.update(billingStateKey, opts.billingEnabled === true);
    await this.deps.secrets.store(secretKeyFor(provider), trimmed);
    const account = await this.test(accountIdFor(provider));
    if (account.status === "invalid") await this.deps.secrets.delete(secretKeyFor(provider));   // never keep a rejected key
    return account;
  }

  async disconnect(provider: string): Promise<void> {
    await this.deps.secrets.delete(secretKeyFor(provider));
    this.cache.recordFailure(accountIdFor(provider), "missing");
  }

  /** Re-runs listModels for one account and records the outcome. Throws only when the provider could not be reached. */
  async test(accountId: string): Promise<ProviderAccount> {
    const provider = providerOf(accountId);
    // Own properties only: "acc_constructor" or "acc___proto__" must not resolve to something inherited.
    const impl = Object.hasOwn(this.deps.providers, provider) ? this.deps.providers[provider] : undefined;
    if (!impl) throw new Error(`Unknown account ${accountId}.`);
    const key = await this.getKey(provider);
    if (!key) {
      this.cache.recordFailure(accountId, "missing");
      return this.describe(provider);
    }
    try {
      this.cache.recordSuccess(accountId, await impl.listModels(key));
    } catch (e) {
      if (e instanceof ProviderAuthError) this.cache.recordFailure(accountId, "invalid");
      // No `cause`: the provider error can carry request details; only the redacted message travels on.
      // eslint-disable-next-line preserve-caught-error
      else throw new Error(`Could not reach ${LABELS[provider] ?? provider}: ${redact(e instanceof Error ? e.message : "unknown error")}`);
    }
    return this.describe(provider);
  }

  /**
   * All connectable accounts. An account with a key that has never been verified is verified now; one that cannot be
   * verified (offline) reports "missing", i.e. not known to be connected.
   */
  async list(): Promise<ProviderAccount[]> {
    const out: ProviderAccount[] = [];
    for (const provider of this.supportedProviders()) {
      const id = accountIdFor(provider);
      if (this.cache.get(id) === undefined) {
        // Offline at startup must not be remembered: leave it unknown (reported as "missing") so the next list() asks again.
        try { await this.test(id); } catch { /* not reachable right now */ }
      }
      out.push(this.describe(provider));
    }
    return out;
  }

  /** Models of connected accounts only, filtered to those eligible for the role (Swarms never serves the agent). */
  models(role?: ModelRole): ModelInfo[] {
    return this.cache.connectedModels().filter(m => (role ? roleEligible(m, role) : true));
  }

  private describe(provider: string): ProviderAccount {
    const facts = dataUseFor(provider, { billingEnabled: this.deps.state.get<boolean>(billingStateKey) === true });
    return {
      id: accountIdFor(provider),
      provider,
      label: LABELS[provider] ?? `${provider} (API key)`,
      status: this.cache.statusOf(accountIdFor(provider)),
      dataLeavesMachine: facts.dataLeavesMachine,
      dataUse: facts.dataUse,
    };
  }
}

/** The webview-protocol handlers this feature serves (Lane 2's bridge router registers them by name). */
export function accountsBridgeHandlers(service: AccountsService) {
  return {
    "accounts.list": async (): Promise<Res<"accounts.list">> => service.list(),
    "accounts.test": async (req: Req<"accounts.test">): Promise<Res<"accounts.test">> => service.test(req.accountId),
    "models.list": async (req: Req<"models.list">): Promise<Res<"models.list">> => service.models(req.role),
  };
}
