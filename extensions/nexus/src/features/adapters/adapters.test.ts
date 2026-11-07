import { describe, expect, it } from "vitest";
import { fx } from "../../contracts/fixtures";
import { FakeEventStore } from "../../services/events/fake-store";
import type { EventStore } from "../../services/events/store";
import type { Gate } from "../../services/gate/types";
import { FakeSlack } from "../../services/slack/fake-slack";
import type { SlackService } from "../../services/slack/types";
import type { GatePort, SlackPort, StorePort } from "../ports";
import { approvalsHookFor } from "./approvals-hook";

// Compile-time proof that Lane 2's interfaces satisfy Lane 1's ports (a mismatch fails `npm run typecheck`).
type Assignable<From, To> = [From] extends [To] ? true : never;
const storeFits: Assignable<EventStore, StorePort> = true;
const slackFits: Assignable<SlackService, SlackPort> = true;
const gateFits: Assignable<Gate, GatePort> = true;

describe("Lane 2 interfaces fit Lane 1 ports", () => {
  it("holds at compile time", () => {
    expect([storeFits, slackFits, gateFits]).toEqual([true, true, true]);
  });

  it("the fake store and fake Slack work through the ports", async () => {
    const store: StorePort = new FakeEventStore();
    expect(Array.isArray(await store.listTasks())).toBe(true);
    const slack: SlackPort = new FakeSlack();
    expect(typeof slack.getThread).toBe("function");
  });
});

describe("approvalsHookFor", () => {
  const session = fx.session;
  it("passes the session id, action, reason and diff preview through and returns the id and decision", async () => {
    const seen: unknown[] = [];
    const hook = approvalsHookFor({ request: async input => { seen.push(input); return { approval: { ...fx.approval, id: "ap_9" }, decision: "approved" }; } });
    const action = { kind: "commit" as const, message: "fix total" };
    const out = await hook.create({ session, action, reason: "tests pass", diffPreview: "diff" });
    expect(out).toEqual({ approvalId: "ap_9", decision: "approved" });
    expect(seen).toEqual([{ sessionId: session.id, action, reason: "tests pass", diffPreview: "diff" }]);
  });

  it("omits diffPreview when the gate sent none, and propagates rejections of the wait", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const hook = approvalsHookFor({ request: async input => { seen.push(input); throw new Error("session ended"); } });
    await expect(hook.create({ session, action: { kind: "other", description: "x" }, reason: "r" })).rejects.toThrow("session ended");
    expect("diffPreview" in seen[0]).toBe(false);
  });
});
