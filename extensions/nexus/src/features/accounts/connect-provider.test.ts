import { describe, expect, it, vi } from "vitest";
import { FakeProvider } from "../../models/fake-provider";
import { ProviderAuthError } from "../../models/provider";
import { AccountsService, type SecretStore, type StateStore } from "./accounts-service";
import { connectProvider, type ConnectUi } from "./connect-provider";

function build(opts: { provider?: string; key?: string | undefined; billing?: boolean | undefined; reject?: boolean; withAux?: boolean } = {}) {
  const map = new Map<string, string>();
  const secrets: SecretStore = { get: async k => map.get(k), store: async (k, v) => { map.set(k, v); }, delete: async k => { map.delete(k); } };
  const st = new Map<string, unknown>();
  const state: StateStore = { get: <T>(k: string) => st.get(k) as T | undefined, update: async (k, v) => { st.set(k, v); } };
  const accounts = new AccountsService({
    secrets, state, env: {},
    providers: { anthropic: new FakeProvider({ id: "anthropic", ...(opts.reject ? { listError: new ProviderAuthError() } : {}) }), google: new FakeProvider({ id: "google" }) },
  });
  const messages: string[] = [];
  const picked: Array<Array<{ id: string; label: string }>> = [];
  const asked: string[] = [];
  const ui: ConnectUi = {
    pickProvider: async items => { picked.push(items); return "provider" in opts ? opts.provider : "anthropic"; },
    promptKey: async () => ("key" in opts ? opts.key : "sk-key"),
    askYesNo: async q => { asked.push(q); return "billing" in opts ? opts.billing : true; },
    info: m => messages.push(`info: ${m}`),
    error: m => messages.push(`error: ${m}`),
  };
  const aux = opts.withAux ? { saveAuxKey: vi.fn(async () => {}) } : undefined;
  return { accounts, ui, aux, messages, picked, asked, map, st };
}

describe("connectProvider", () => {
  it("offers the connectable providers, stores the key and reports the model count", async () => {
    const b = build();
    await connectProvider({ accounts: b.accounts, ui: b.ui });
    expect(b.picked[0]).toEqual([{ id: "anthropic", label: "Anthropic (API key)" }, { id: "google", label: "Google Gemini (API key)" }]);
    expect(b.map.get("nexus.key.anthropic")).toBe("sk-key");
    expect(b.messages).toEqual(["info: Anthropic (API key) connected: 1 model available."]);
  });

  it("asks the billing question for Gemini only, and records the answer", async () => {
    const g = build({ provider: "google", billing: false });
    await connectProvider({ accounts: g.accounts, ui: g.ui });
    expect(g.asked).toHaveLength(1);
    expect((await g.accounts.list()).find(a => a.provider === "google")!.dataUse).toBe("may_be_used_for_training");
    const a = build();
    await connectProvider({ accounts: a.accounts, ui: a.ui });
    expect(a.asked).toEqual([]);
  });

  it("stops quietly when the user cancels at any step", async () => {
    for (const opts of [{ provider: undefined }, { key: undefined }, { provider: "google", billing: undefined }]) {
      const b = build(opts as Parameters<typeof build>[0]);
      await connectProvider({ accounts: b.accounts, ui: b.ui });
      expect(b.messages).toEqual([]);
      expect(b.map.size).toBe(0);
    }
  });

  it("refuses an empty key without saving anything", async () => {
    const b = build({ key: "   " });
    await connectProvider({ accounts: b.accounts, ui: b.ui });
    expect(b.messages).toEqual(["error: The API key was empty; nothing was saved."]);
    expect(b.map.size).toBe(0);
  });

  it("says so when the provider rejects the key, and keeps nothing", async () => {
    const b = build({ reject: true });
    await connectProvider({ accounts: b.accounts, ui: b.ui });
    expect(b.messages).toEqual(["error: Anthropic (API key): the provider rejected this key. Nothing was saved."]);
    expect(b.map.size).toBe(0);
  });

  it("offers Prune only when an aux key store exists, and saves its key without listing models", async () => {
    const without = build({ provider: "prune" });
    await connectProvider({ accounts: without.accounts, ui: without.ui });
    expect(without.picked[0].map(i => i.id)).not.toContain("prune");

    const b = build({ provider: "prune", withAux: true });
    await connectProvider({ accounts: b.accounts, ui: b.ui, aux: b.aux });
    expect(b.picked[0].map(i => i.id)).toContain("prune");
    expect(b.aux!.saveAuxKey).toHaveBeenCalledWith("prune", "sk-key");
    expect(b.messages[0]).toMatch(/^info: Prune \(API key\) saved/);
  });

  it("surfaces an unreachable provider as an error, not a crash", async () => {
    const b = build();
    const kept = new Map<string, string>();
    const broken = new AccountsService({ secrets: { get: async k => kept.get(k), store: async (k, v) => { kept.set(k, v); }, delete: async k => { kept.delete(k); } }, state: { get: () => undefined, update: async () => {} }, env: {}, providers: { anthropic: new FakeProvider({ id: "anthropic", listError: new Error("offline") }) } });
    await connectProvider({ accounts: broken, ui: b.ui });
    expect(b.messages[0]).toMatch(/^error: Could not reach Anthropic/);
  });
});
