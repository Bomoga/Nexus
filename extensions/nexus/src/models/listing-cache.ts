import type { ModelInfo, ProviderAccount } from "../contracts";

// Last model listing per account (PLAN L1-03). An account is "connected" only after a successful real listing:
// saving a key never marks it connected (CLAUDE.md §5 semantics).

export interface ListingEntry {
  status: ProviderAccount["status"];
  models: ModelInfo[];
  at: number;                       // epoch ms of the last attempt that produced this status
}

export class ListingCache {
  private readonly entries = new Map<string, ListingEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  recordSuccess(accountId: string, models: readonly ModelInfo[]): void {
    this.entries.set(accountId, { status: "connected", models: models.map(m => ({ ...m })), at: this.now() });
  }

  /** "invalid": the provider rejected the key. "missing": there is no key. Either way the old model list is dropped. */
  recordFailure(accountId: string, status: "invalid" | "missing"): void {
    this.entries.set(accountId, { status, models: [], at: this.now() });
  }

  get(accountId: string): ListingEntry | undefined {
    const e = this.entries.get(accountId);
    return e && { ...e, models: e.models.map(m => ({ ...m })) };
  }

  /** An account that has never been listed is "missing", never "connected". */
  statusOf(accountId: string): ProviderAccount["status"] {
    return this.entries.get(accountId)?.status ?? "missing";
  }

  /** Models of every connected account, in insertion order. The picker shows only these. */
  connectedModels(): ModelInfo[] {
    return [...this.entries.values()].filter(e => e.status === "connected").flatMap(e => e.models.map(m => ({ ...m })));
  }

  ageMs(accountId: string): number | undefined {
    const e = this.entries.get(accountId);
    return e && this.now() - e.at;
  }

  delete(accountId: string): void {
    this.entries.delete(accountId);
  }
}
