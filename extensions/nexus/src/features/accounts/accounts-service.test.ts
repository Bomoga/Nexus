import { describe, expect, it } from "vitest";
import { Requests } from "../../contracts";
import { FakeProvider } from "../../models/fake-provider";
import { ProviderAuthError, type Provider } from "../../models/provider";
import { AccountsService, accountIdFor, accountsBridgeHandlers, secretKeyFor, type SecretStore, type StateStore } from "./accounts-service";

const KEY = "sk-ant-api03-SECRETSECRETSECRET1234567890";

function memSecrets(initial: Record<string, string> = {}): SecretStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return { map, get: async k => map.get(k), store: async (k, v) => { map.set(k, v); }, delete: async k => { map.delete(k); } };
}
function memState(): StateStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return { map, get: <T>(k: string) => map.get(k) as T | undefined, update: async (k, v) => { map.set(k, v); } };
}

function setup(over: { providers?: Record<string, Provider>; secrets?: Record<string, string>; env?: NodeJS.ProcessEnv } = {}) {
  const anthropic = new FakeProvider({ id: "anthropic" });
  const google = new FakeProvider({ id: "google" });
  const swarms = new FakeProvider({ id: "swarms" });
  const secrets = memSecrets(over.secrets);
  const state = memState();
  const service = new AccountsService({ secrets, state, providers: over.providers ?? { anthropic, google, swarms }, env: over.env ?? {} });
  return { service, secrets, state, anthropic, google, swarms };
}

describe("AccountsService.connect", () => {
  it("stores the key in SecretStorage, verifies it with a real listing, and exposes no key", async () => {
    const s = setup();
    const account = await s.service.connect("anthropic", `  ${KEY} `);
    expect(account).toEqual({ id: "acc_anthropic", provider: "anthropic", label: "Anthropic (API key)", status: "connected", dataLeavesMachine: true, dataUse: "not_used_for_training" });
    expect(s.secrets.map.get("nexus.key.anthropic")).toBe(KEY);
    expect(s.anthropic.keyFingerprints).toHaveLength(1);                    // exactly one real listing
    expect(JSON.stringify(account)).not.toContain("SECRETSECRET");
    expect(JSON.stringify(await s.service.list())).not.toContain("SECRETSECRET");
  });

  it("marks a rejected key invalid and does not keep it", async () => {
    const s = setup({ providers: { anthropic: new FakeProvider({ id: "anthropic", listError: new ProviderAuthError() }) } });
    const account = await s.service.connect("anthropic", KEY);
    expect(account.status).toBe("invalid");
    expect(s.secrets.map.has("nexus.key.anthropic")).toBe(false);
    expect(s.service.models()).toEqual([]);
  });

  it("is not connected just because a key was saved: an unreachable provider throws and nothing is connected", async () => {
    const s = setup({ providers: { anthropic: new FakeProvider({ id: "anthropic", listError: new Error(`ECONNRESET ${KEY}`) }) } });
    const err = await s.service.connect("anthropic", KEY).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Could not reach Anthropic/);
    expect((err as Error).message).not.toContain("SECRETSECRET");
    expect(s.service.models()).toEqual([]);
    expect((await s.service.list())[0].status).toBe("missing");
  });

  it("records the Gemini billing answer and derives the data-use label from it", async () => {
    const paid = setup();
    expect((await paid.service.connect("google", "g-key", { billingEnabled: true })).dataUse).toBe("not_used_for_training");
    const unpaid = setup();
    expect((await unpaid.service.connect("google", "g-key", { billingEnabled: false })).dataUse).toBe("may_be_used_for_training");
    const unanswered = setup();
    expect((await unanswered.service.connect("google", "g-key")).dataUse).toBe("may_be_used_for_training");
  });

  it("rejects an empty key and a provider that cannot be connected", async () => {
    const s = setup({ providers: { anthropic: new FakeProvider({ id: "anthropic" }) } });
    await expect(s.service.connect("anthropic", "   ")).rejects.toThrow("empty");
    await expect(s.service.connect("swarms", "k")).rejects.toThrow("cannot be connected yet");
    expect(s.secrets.map.size).toBe(0);
  });
});

describe("AccountsService keys", () => {
  it("prefers SecretStorage and uses NEXUS_<PROVIDER>_KEY only when SecretStorage is empty", async () => {
    const env = { NEXUS_ANTHROPIC_KEY: "from-env", NEXUS_GOOGLE_KEY: "g-env" };
    const s = setup({ env, secrets: { [secretKeyFor("anthropic")]: "from-secrets" } });
    expect(await s.service.getKey("anthropic")).toBe("from-secrets");
    expect(await s.service.getKey("google")).toBe("g-env");
    expect(await s.service.getKey("swarms")).toBeUndefined();
  });

  it("disconnect removes the key and the account reads as missing", async () => {
    const s = setup();
    await s.service.connect("anthropic", KEY);
    await s.service.disconnect("anthropic");
    expect(await s.service.getKey("anthropic")).toBeUndefined();
    expect((await s.service.list()).find(a => a.provider === "anthropic")!.status).toBe("missing");
  });
});

describe("AccountsService.list / test / models", () => {
  it("lists every supported provider in picker order; accounts without a key are missing and cost no network call", async () => {
    const s = setup();
    const list = await s.service.list();
    expect(list.map(a => [a.provider, a.status])).toEqual([["anthropic", "missing"], ["google", "missing"], ["swarms", "missing"]]);
    expect([s.anthropic, s.google, s.swarms].every(p => p.keyFingerprints.length === 0)).toBe(true);
  });

  it("verifies an account that has a key but was never listed, once", async () => {
    const s = setup({ secrets: { [secretKeyFor("anthropic")]: KEY } });
    expect((await s.service.list())[0].status).toBe("connected");
    await s.service.list();
    expect(s.anthropic.keyFingerprints).toHaveLength(1);
  });

  it("test() re-runs the listing and can flip connected to invalid", async () => {
    let reject = false;
    const flaky: Provider = { id: "anthropic", turn: new FakeProvider().turn.bind(new FakeProvider()), listModels: async () => { if (reject) throw new ProviderAuthError(); return [{ provider: "anthropic", modelId: "m", displayName: "M", supportsTools: true }]; } };
    const s = setup({ providers: { anthropic: flaky }, secrets: { [secretKeyFor("anthropic")]: KEY } });
    expect((await s.service.test(accountIdFor("anthropic"))).status).toBe("connected");
    reject = true;
    expect((await s.service.test(accountIdFor("anthropic"))).status).toBe("invalid");
    expect(s.service.models()).toEqual([]);
  });

  it("test() on an unknown account throws", async () => {
    await expect(setup().service.test("acc_nope")).rejects.toThrow("Unknown account");
  });

  it("models() returns only connected accounts' models and never offers Swarms for the agent role", async () => {
    const s = setup();
    await s.service.connect("anthropic", KEY);
    await s.service.connect("google", "g", { billingEnabled: true });
    await s.service.connect("swarms", "s");
    expect(s.service.models().map(m => m.provider).sort()).toEqual(["anthropic", "google", "swarms"]);
    expect(s.service.models("agent").map(m => m.provider).sort()).toEqual(["anthropic", "google"]);
    expect(s.service.models("brief").some(m => m.provider === "swarms")).toBe(true);
  });
});

describe("accountsBridgeHandlers", () => {
  it("serve accounts.list, accounts.test and models.list with responses that satisfy the contract", async () => {
    const s = setup();
    await s.service.connect("anthropic", KEY);
    const h = accountsBridgeHandlers(s.service);
    Requests["accounts.list"].res.parse(await h["accounts.list"]());
    Requests["accounts.test"].res.parse(await h["accounts.test"]({ accountId: "acc_anthropic" }));
    Requests["models.list"].res.parse(await h["models.list"]({ role: "agent" }));
    expect((await h["models.list"]({})).length).toBeGreaterThan(0);
  });
});
