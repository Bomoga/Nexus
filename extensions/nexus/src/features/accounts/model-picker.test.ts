import { describe, expect, it, vi } from "vitest";
import { DEFAULT_OPTIMIZER, type OptimizerSetting } from "../../contracts";
import { FakeProvider } from "../../models/fake-provider";
import { AccountsService, type SecretStore, type StateStore } from "./accounts-service";
import { DATA_USE_LABELS, ModelPicker, pickerBridgeHandlers, type PickerItem, type PickerUi } from "./model-picker";

function memState(): StateStore {
  const map = new Map<string, unknown>();
  return { get: <T>(k: string) => map.get(k) as T | undefined, update: async (k, v) => { map.set(k, v); } };
}

async function setup(opts: { connect?: Array<"anthropic" | "google" | "swarms">; optimizer?: boolean; pick?: (items: PickerItem[]) => PickerItem | undefined } = {}) {
  const map = new Map<string, string>();
  const secrets: SecretStore = { get: async k => map.get(k), store: async (k, v) => { map.set(k, v); }, delete: async k => { map.delete(k); } };
  const state = memState();
  const accounts = new AccountsService({
    secrets, state, env: {},
    providers: { anthropic: new FakeProvider({ id: "anthropic" }), google: new FakeProvider({ id: "google" }), swarms: new FakeProvider({ id: "swarms" }) },
  });
  for (const p of opts.connect ?? ["anthropic", "google"]) await accounts.connect(p, "k", { billingEnabled: true });
  const shown: PickerItem[][] = [];
  const status: Array<{ text: string; tooltip: string }> = [];
  const ui: PickerUi = {
    showPick: async items => { shown.push(items); return opts.pick?.(items); },
    setStatus: (text, tooltip) => status.push({ text, tooltip }),
  };
  let setting: OptimizerSetting = { ...DEFAULT_OPTIMIZER };
  const toggle = vi.fn(async () => { setting = { ...setting, enabled: !setting.enabled }; });
  const picker = new ModelPicker({ accounts, state, ui, ...(opts.optimizer ? { optimizer: { get: () => setting, toggle } } : {}) });
  return { picker, shown, status, state, toggle, accounts };
}

const labels = (items: PickerItem[]) => items.map(i => `${i.kind}:${i.label}`);

describe("ModelPicker items", () => {
  it("groups models by provider with a data-use label, only for connected accounts", async () => {
    const s = await setup();
    const items = await s.picker.buildItems();
    expect(labels(items)).toEqual([
      "separator:Anthropic (API key)", "model:Claude Sonnet 4.5",
      "separator:Google Gemini (API key)", "model:Gemini 3 Flash (preview)",
    ]);
    const claude = items[1] as Extract<PickerItem, { kind: "model" }>;
    expect(claude.description).toBe("claude-sonnet-4-5");
    expect(claude.detail).toBe("not used for training · leaves machine");
  });

  it("shows unpaid Gemini as may be used for training", async () => {
    const s = await setup({ connect: [] });
    await s.accounts.connect("google", "k", { billingEnabled: false });
    const items = await s.picker.buildItems();
    expect((items[1] as { detail: string }).detail).toBe("may be used for training · leaves machine");
  });

  it("never lists Swarms for the agent, and lists nothing for disconnected accounts", async () => {
    const s = await setup({ connect: ["anthropic", "swarms"] });
    const items = await s.picker.buildItems();
    expect(labels(items).join("|")).not.toMatch(/Swarms|swarms/);
    const none = await setup({ connect: [] });
    expect(await none.picker.buildItems()).toEqual([]);
    expect(await none.picker.pick()).toBe("empty");
    expect(none.shown).toEqual([]);                      // no empty quick pick
  });

  it("adds the Optimize with Prune row only when an optimizer is wired, and reflects its state", async () => {
    const off = await setup();
    expect(labels(await off.picker.buildItems()).some(l => l.includes("Prune"))).toBe(false);
    const on = await setup({ optimizer: true });
    const items = await on.picker.buildItems();
    expect(labels(items).slice(-2)).toEqual(["separator:Optimization", "optimizer:Optimize with Prune: OFF"]);
    expect((items.at(-1) as { detail: string }).detail).toMatch(/data use unknown · leaves machine/);
  });
});

describe("pickerBridgeHandlers (the agent view's composer shares the status bar's choice)", () => {
  it("reports null before a pick, remembers a pick from the composer and shows it in the status bar, and refuses a model no connected account lists", async () => {
    const s = await setup({ connect: ["anthropic"] });
    const h = pickerBridgeHandlers(s.picker);
    expect(await h["models.selected"]({ role: "agent" })).toBeNull();
    const anthropic = s.accounts.models("agent").find(m => m.provider === "anthropic")!;
    expect(await h["models.select"]({ role: "agent", provider: anthropic.provider, modelId: anthropic.modelId })).toEqual({ provider: anthropic.provider, modelId: anthropic.modelId });
    expect(await h["models.selected"]({ role: "agent" })).toEqual({ provider: anthropic.provider, modelId: anthropic.modelId });
    expect(s.status.at(-1)?.text).toContain(anthropic.modelId);           // the status bar item followed the composer's pick
    expect(s.picker.selected("agent")).toEqual({ provider: anthropic.provider, modelId: anthropic.modelId });
    await expect(h["models.select"]({ role: "agent", provider: "google", modelId: "gemini-nope" })).rejects.toThrow(/not a model of a connected account/);
    expect(await h["models.selected"]({ role: "agent" })).toEqual({ provider: anthropic.provider, modelId: anthropic.modelId }); // unchanged
  });
});

describe("ModelPicker selection", () => {
  it("remembers the chosen model, shows it in the status bar, and reports the data-use label in the tooltip", async () => {
    const s = await setup({ pick: items => items.find(i => i.kind === "model") });
    expect(await s.picker.pick()).toBe("model");
    expect(s.picker.selected()).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
    expect(s.status.at(-1)).toEqual({
      text: "⬡ anthropic · claude-sonnet-4-5",
      tooltip: "Nexus agent model: anthropic claude-sonnet-4-5 (not used for training, leaves this machine). Click to change.",
    });
  });

  it("forgets a choice whose account is no longer connected, and prompts to pick again", async () => {
    const s = await setup({ pick: items => items.find(i => i.kind === "model") });
    await s.picker.pick();
    await s.accounts.disconnect("anthropic");
    expect(s.picker.selected()).toBeUndefined();
    await s.picker.refreshStatus();
    expect(s.status.at(-1)!.text).toBe("⬡ pick a model");
  });

  it("does not accept a remembered Swarms model for the agent role", async () => {
    const s = await setup({ connect: ["anthropic", "swarms"] });
    await s.picker.choose("agent", { provider: "swarms", modelId: "swarms:single-agent" });
    expect(s.picker.selected("agent")).toBeUndefined();
    await s.picker.choose("brief", { provider: "swarms", modelId: "swarms:single-agent" });
    expect(s.picker.selected("brief")).toEqual({ provider: "swarms", modelId: "swarms:single-agent" });   // text roles may use it
  });

  it("changes nothing when the quick pick is dismissed", async () => {
    const s = await setup();
    expect(await s.picker.pick()).toBe("none");
    expect(s.picker.selected()).toBeUndefined();
  });

  it("toggles the optimizer from the picker and refreshes the status", async () => {
    const s = await setup({ optimizer: true, pick: items => items.find(i => i.kind === "optimizer") });
    const before = s.status.length;
    expect(await s.picker.pick()).toBe("optimizer");
    expect(s.toggle).toHaveBeenCalledTimes(1);
    expect(s.status.length).toBe(before + 1);
  });

  it("has a label for every data-use value", () => {
    expect(Object.keys(DATA_USE_LABELS).sort()).toEqual(["may_be_used_for_training", "not_used_for_training", "unknown"]);
  });
});
