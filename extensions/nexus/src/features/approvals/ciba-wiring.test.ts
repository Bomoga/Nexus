import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../../contracts";
import { makeConfiguredCibaHook, type CibaWiringDeps } from "./ciba-wiring";

const approval = { id: "ap_1", sessionId: "s1", action: { kind: "commit", message: "m" }, reason: "r", requestedAt: "2026-01-01T00:00:00Z" } as ApprovalRequest;

function setup(over: { url?: string; signedIn?: boolean; outcome?: unknown } = {}) {
  const resolve = vi.fn(async (..._a: unknown[]) => ({}) as never);
  const listeners: Array<(a: ApprovalRequest) => void> = [];
  let aborted = false;
  const requestApproval = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise(res => {
    if (over.outcome) { res(over.outcome); return; }
    signal.addEventListener("abort", () => { aborted = true; res({ status: "no_answer", reason: "cancelled" }); });
  }));
  const makeClient = vi.fn((_o: unknown) => ({ requestApproval })) as unknown as NonNullable<CibaWiringDeps["makeClient"]>;
  const hook = makeConfiguredCibaHook({
    serviceUrl: () => over.url ?? "https://auth.example.test",
    auth: { status: () => ({ signedIn: over.signedIn ?? true, auth0UserId: "auth0|u1", slackViaTokenVault: false }), accessToken: async () => "tok" },
    getController: () => ({ resolve, get: async () => undefined, subscribe: cb => { listeners.push(cb); return () => {}; } }),
    makeClient,
  });
  return { hook, makeClient, requestApproval, resolve, listeners, wasAborted: () => aborted };
}

describe("makeConfiguredCibaHook", () => {
  it("is inert when the service URL is empty", async () => {
    const t = setup({ url: "  " });
    await t.hook.onCreated(approval);
    expect(t.makeClient).not.toHaveBeenCalled();
  });
  it("is inert when not signed in", async () => {
    const t = setup({ signedIn: false });
    await t.hook.onCreated(approval);
    expect(t.makeClient).not.toHaveBeenCalled();
  });
  it("builds the client with the base URL and resolves with the phone decision", async () => {
    const decidedBy = { via: "auth0_push", userId: "auth0|u1", auth0UserId: "auth0|u1" };
    const t = setup({ outcome: { status: "approved", decidedBy } });
    await t.hook.onCreated(approval);
    expect((t.makeClient as unknown as { mock: { calls: Array<[{ baseUrl: string }]> } }).mock.calls[0]![0].baseUrl).toBe("https://auth.example.test");
    expect(t.resolve).toHaveBeenCalledWith("ap_1", "approved", decidedBy);
  });
  it("cancels the push when the approval is decided elsewhere", async () => {
    const t = setup();
    const pending = t.hook.onCreated(approval);
    await new Promise(r => setTimeout(r, 0));
    expect(t.listeners).toHaveLength(1);
    t.listeners[0]!({ ...approval });                       // an update without a decision does nothing
    expect(t.wasAborted()).toBe(false);
    t.listeners[0]!({ ...approval, decision: "approved" });
    await pending;
    expect(t.wasAborted()).toBe(true);
    expect(t.resolve).not.toHaveBeenCalled();
  });
});
