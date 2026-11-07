import { DEFAULT_OPTIMIZER, OptimizerSetting, type ModelCallReceipt, type ModelRole, type Req, type Res, type SpendSummary } from "../../contracts";
import { inScope } from "../../models/prune-adapter";
import { PRUNE_VERIFY_URL, isVerifiable, type PruneMetadata } from "../../models/prune-receipt";
import type { StorePort, Unsubscribe } from "../ports";
import type { StateStore } from "./accounts-service";

// "Optimize with Prune" (PLAN L1-21): the toggle (off by default, a visible per-user choice), the receipts every
// routed call produces, and the running spend and savings. Receipts are written to the shared store so the team sees
// everyone's spend; the status bar shows this machine's session totals (CLAUDE.md §5, §14).

export const OPTIMIZER_STATE_KEY = "nexus.optimizer";
/** Set only by a passing live tool-calling check through Prune (smoke L1-S4); until then the agent stays out of scope. */
export const PASSTHROUGH_STATE_KEY = "nexus.prune.toolPassthroughVerified";

export interface OptimizerDeps {
  state: StateStore;
  store: Pick<StorePort, "putReceipt" | "listReceipts">;
  getPruneKey(): Promise<string | undefined>;
}

export interface ReceiptLink {
  verifyUrl: string;
  /** The signed prune_metadata to paste on the verify page, when this machine still has it. */
  metadataJson?: string;
  message: string;
}

export function summarize(receipts: readonly ModelCallReceipt[], sessionId?: string): SpendSummary {
  let costUsd = 0, savedUsd = 0;
  for (const r of receipts) {
    costUsd += r.costUsd;
    if (r.baselineCostUsd !== undefined) savedUsd += Math.max(0, r.baselineCostUsd - r.costUsd);
  }
  return { ...(sessionId ? { sessionId } : {}), calls: receipts.length, costUsd, savedUsd };
}

const money = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;

export class OptimizerService {
  private readonly vault = new Map<string, PruneMetadata>();            // receipt id -> signed metadata, this session only
  private readonly listeners = new Set<(r: ModelCallReceipt) => void>();
  private readonly settingListeners = new Set<(s: OptimizerSetting) => void>();

  constructor(private readonly deps: OptimizerDeps) {}

  get(): OptimizerSetting {
    const saved = OptimizerSetting.safeParse(this.deps.state.get(OPTIMIZER_STATE_KEY));
    return saved.success ? saved.data : { ...DEFAULT_OPTIMIZER };
  }

  toolPassthroughVerified(): boolean {
    return this.deps.state.get<boolean>(PASSTHROUGH_STATE_KEY) === true;
  }

  async set(next: OptimizerSetting): Promise<OptimizerSetting> {
    const setting = OptimizerSetting.parse(next);
    if (setting.scope === "all_roles" && !this.toolPassthroughVerified()) {
      throw new Error("Routing the coding agent through Prune needs the live tool-calling check first (smoke L1-S4); it stays on text roles until then.");
    }
    if (setting.enabled && !(await this.deps.getPruneKey())) {
      throw new Error("Connect a Prune key first (Nexus: Connect provider, then Prune).");
    }
    await this.deps.state.update(OPTIMIZER_STATE_KEY, setting);
    for (const cb of this.settingListeners) cb(setting);
    return setting;
  }

  async toggle(): Promise<OptimizerSetting> {
    const cur = this.get();
    return this.set({ ...cur, enabled: !cur.enabled });
  }

  onSettingChange(cb: (s: OptimizerSetting) => void): Unsubscribe {
    this.settingListeners.add(cb);
    return () => { this.settingListeners.delete(cb); };
  }

  /** What the agent process may do with Prune on its next call: used for `credentials.get`'s `prune` field. */
  async pruneFor(role: ModelRole): Promise<{ enabled: boolean; apiKey?: string }> {
    const s = this.get();
    if (!s.enabled || !inScope(s.scope, role)) return { enabled: false };
    const apiKey = await this.deps.getPruneKey();
    return apiKey ? { enabled: true, apiKey } : { enabled: false };
  }

  /** Records one receipt (from the agent or a text-role call): shared store, local vault, subscribers. */
  async record(receipt: ModelCallReceipt, metadata?: PruneMetadata): Promise<void> {
    await this.deps.store.putReceipt(receipt);
    if (metadata && isVerifiable(metadata)) this.vault.set(receipt.pruneReceiptId, metadata);
    for (const cb of this.listeners) cb(receipt);
  }

  async list(sessionId?: string, limit = 100): Promise<{ receipts: ModelCallReceipt[]; summary: SpendSummary }> {
    const all = await this.deps.store.listReceipts(sessionId);
    return { receipts: all.slice(-limit), summary: summarize(all, sessionId) };
  }

  subscribe(cb: (r: ModelCallReceipt) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** Status bar text: "PRUNE $0.0123 · saved $0.0210", or undefined while Prune is off and nothing was spent. */
  async statusText(sessionId?: string): Promise<string | undefined> {
    const { summary } = await this.list(sessionId);
    if (!this.get().enabled && summary.calls === 0) return undefined;
    return `PRUNE ${money(summary.costUsd)} · saved ${money(summary.savedUsd)}`;
  }

  /** `nexus.openReceipt`: where to verify a receipt, and what to paste there. */
  async openReceipt(receiptId: string, sessionId?: string): Promise<ReceiptLink> {
    const known = (await this.deps.store.listReceipts(sessionId)).find(r => r.pruneReceiptId === receiptId);
    if (!known) throw new Error("No such receipt.");
    if (receiptId.startsWith("unsigned:")) {
      return { verifyUrl: PRUNE_VERIFY_URL, message: "This call has no signed receipt (Prune did not sign it), so there is nothing to verify." };
    }
    const md = this.vault.get(receiptId);
    return md
      ? { verifyUrl: PRUNE_VERIFY_URL, metadataJson: JSON.stringify(md), message: "The signed receipt is on your clipboard: paste it on Prune's verify page." }
      : { verifyUrl: PRUNE_VERIFY_URL, message: "Open Prune's verify page and paste the receipt from your Prune dashboard (this window no longer has the signed copy)." };
  }
}

/** The webview-protocol handlers this service serves; Lane 2's bridge router registers them by name. */
export function optimizerBridgeHandlers(s: OptimizerService) {
  return {
    "optimizer.get": async (): Promise<Res<"optimizer.get">> => s.get(),
    "optimizer.set": async (r: Req<"optimizer.set">): Promise<Res<"optimizer.set">> => s.set(r),
    "receipts.list": async (r: Req<"receipts.list">): Promise<Res<"receipts.list">> => s.list(r.sessionId, r.limit),
  };
}

export function receiptSubscriptions(s: OptimizerService) {
  return {
    "receipts.subscribe": (r: { sessionId?: string }, emit: (e: ModelCallReceipt) => void): Unsubscribe => s.subscribe(rc => { if (!r.sessionId || rc.sessionId === r.sessionId) emit(rc); }),
  };
}
