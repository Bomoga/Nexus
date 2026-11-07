import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as C from "./index";
import { fx } from "./fixtures";
import { scriptedAgentEvents, scriptedNexusEvents, scriptedReceipts } from "./fixtures/stream";
import { demoScenario } from "./fixtures/scenario";

const one: [string, z.ZodType, unknown][] = [
  ["optimizer", C.OptimizerSetting, fx.optimizer],
  ["receipt", C.ModelCallReceipt, fx.receipt],
  ["codeRef", C.CodeRef, fx.codeRef],
  ["thread", C.Thread, fx.thread],
  ["task", C.Task, fx.task],
  ["session", C.AgentSession, fx.session],
  ["approval", C.ApprovalRequest, fx.approval],
  ["approvalDecided", C.ApprovalRequest, fx.approvalDecided],
  ["review", C.SwarmReview, fx.review],
  ["plan", C.TaskPlan, fx.plan],
  ["event", C.NexusEvent, fx.event],
  ["slackStatus", C.SlackStatus, fx.slackStatus],
];
const many: [string, z.ZodType, unknown[]][] = [
  ["providerAccounts", C.ProviderAccount, fx.providerAccounts],
  ["models", C.ModelInfo, fx.models],
  ["slackUsers", C.SlackUser, fx.slackUsers],
  ["channels", C.Channel, fx.channels],
  ["activity", C.ActivityBucket, fx.activity],
  ["scriptedAgentEvents", C.AgentEvent, scriptedAgentEvents],
  ["scriptedReceipts", C.ModelCallReceipt, scriptedReceipts],
  ["scriptedNexusEvents", C.NexusEvent, scriptedNexusEvents()],
];

describe("fixtures parse under their schemas", () => {
  it.each(one)("%s", (_name, schema, value) => {
    expect(schema.parse(value)).toEqual(value);
  });
  it.each(many)("%s", (_name, schema, values) => {
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(schema.parse(v)).toEqual(v);
  });
  it("covers every key of fx", () => {
    const covered = new Set([...one.map(([n]) => n), ...many.map(([n]) => n)]);
    for (const key of Object.keys(fx)) expect(covered.has(key), key).toBe(true);
  });
});

describe("scriptedAgentEvents", () => {
  it("has contiguous seq from 0 for one session", () => {
    scriptedAgentEvents.forEach((e, i) => {
      expect(e.seq).toBe(i);
      expect(e.sessionId).toBe(fx.session.id);
    });
  });
  it("starts running and ends done", () => {
    expect(scriptedAgentEvents[0]).toMatchObject({ type: "status", status: "running" });
    expect(scriptedAgentEvents.at(-1)).toMatchObject({ type: "status", status: "done" });
  });
  it("has 4 receipts, two with cache_hit", () => {
    expect(scriptedReceipts).toHaveLength(4);
    expect(scriptedReceipts.filter(r => r.optimizations.includes("cache_hit"))).toHaveLength(2);
  });
});

describe("scriptedNexusEvents", () => {
  const events = scriptedNexusEvents();
  it("is deterministic and seed-dependent", () => {
    expect(scriptedNexusEvents()).toEqual(events);
    expect(scriptedNexusEvents({ hours: 36, perHour: 4, seed: 8 })).not.toEqual(events);
  });
  it("has unique ids, sorted by time", () => {
    expect(new Set(events.map(e => e.id)).size).toBe(events.length);
    for (let i = 1; i < events.length; i++) expect(events[i - 1].at <= events[i].at).toBe(true);
  });
  it("matches the scripted shape", () => {
    const count = (k: string) => events.filter(e => e.kind === k).length;
    expect(new Set(events.map(e => e.orbit))).toEqual(new Set(["main", "lane-1", "lane-2", "feature/checkout"]));
    expect(count("branch")).toBe(4);
    expect(count("merge")).toBe(5);
    expect(events.filter(e => e.kind === "merge").every(e => e.orbit === "main" && e.fromOrbit)).toBe(true);
    expect(events.filter(e => e.kind === "tag").map(e => e.title)).toEqual(["cp-2"]);
    expect(count("agent_session")).toBe(3);
    expect(count("slack_task")).toBe(2);
    expect(count("commit")).toBe(36 * 4);
  });
  it("uses the git id rule and ULIDs for the rest", () => {
    for (const e of events) {
      if (e.target.type === "commit") expect(e.id).toBe(`${e.workspaceId}:${e.kind}:${e.target.sha}`);
      else expect(C.Ulid.safeParse(e.id).success).toBe(true);
    }
  });
  it("scales with options", () => {
    expect(scriptedNexusEvents({ hours: 4, perHour: 10, seed: 1 }).filter(e => e.kind === "commit")).toHaveLength(40);
  });
});

describe("contract rules", () => {
  it("round-trips a CodeRef through nexus://", () => {
    const uri = C.encodeCodeRef(fx.codeRef);
    expect(uri).toBe("nexus://coderef/ws_demo/3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21/42-48/src%2Fcart.ts");
    expect(C.decodeCodeRef(uri)).toEqual(fx.codeRef);
  });
  it("rejects bad CodeRefs", () => {
    expect(C.decodeCodeRef("nexus://coderef/ws/main/1-2/a.ts")).toBeNull();
    expect(C.CodeRef.safeParse({ ...fx.codeRef, path: "../etc/passwd" }).success).toBe(false);
    expect(C.CodeRef.safeParse({ ...fx.codeRef, startLine: 9, endLine: 3 }).success).toBe(false);
  });
  it("never lets a key field into ProviderAccount", () => {
    expect(C.ProviderAccount.safeParse({ ...fx.providerAccounts[0], apiKey: "sk-ant-x" }).success).toBe(false);
  });
  it("applies orbitOf", () => {
    expect(C.orbitOf("main")).toBe("main");
    expect(C.orbitOf("lane-2/L2-07")).toBe("lane-2");
    expect(C.orbitOf("nexus/agent-ses_01")).toBe("main");
    expect(C.orbitOf("feature/x/y")).toBe("feature/x");
  });
  it("validates TaskPlan dependsOn", () => {
    expect(C.TaskPlan.safeParse({ ...fx.plan, subtasks: [{ title: "a", brief: "", dependsOn: [0] }, { title: "b", brief: "", dependsOn: [] }] }).success).toBe(false);
  });
  it("parses both res envelopes", () => {
    expect(C.Envelope.safeParse({ t: "res", id: "1", ok: true, body: {} }).success).toBe(true);
    expect(C.Envelope.safeParse({ t: "res", id: "1", ok: false, error: { code: "conflict", message: "decided" } }).success).toBe(true);
    expect(C.Envelope.safeParse({ t: "res", id: "1", ok: false, body: {} }).success).toBe(false);
  });
  it("gives every command an owner and a title", () => {
    expect(Object.keys(C.COMMAND_OWNER).sort()).toEqual(Object.keys(C.COMMANDS).sort());
  });
  it("keeps DEFAULT_OPTIMIZER off with no routing", () => {
    expect(C.DEFAULT_OPTIMIZER).toEqual({ enabled: false, scope: "text_roles", allowModelRouting: false });
  });
  it("builds the demo scenario from fixtures", () => {
    expect(demoScenario.session.id).toBe(demoScenario.agentEvents[0].sessionId);
    expect(demoScenario.approvals.map(a => a.id)).toEqual(["apr_01", "apr_02"]);
  });
});
