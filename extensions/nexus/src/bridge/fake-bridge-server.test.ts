import { describe, expect, it } from "vitest";
import { fx } from "../contracts/fixtures";
import type { AgentEvent, ChatMessage } from "../contracts";
import { FakeBridgeServer } from "./fake-bridge-server";
import { BridgeError } from "./types";

const status = { type: "status" as const, status: fx.slackStatus };
const msg = (channelId: string): ChatMessage => ({ ...fx.thread.messages[0], channelId });
const agentEvt = (sessionId: string, seq: number): AgentEvent => ({ sessionId, seq, at: fx.task.createdAt, type: "message", text: `m${seq}` });
const tick = () => new Promise<void>(r => setTimeout(r, 0));

describe("FakeBridgeServer subscriptions", () => {
  it("scopes delivery by req (agent, slack, receipts, swarm review)", async () => {
    const b = new FakeBridgeServer();
    const a1: unknown[] = [], a2: unknown[] = [], sl: unknown[] = [], slEmpty: unknown[] = [], rc: unknown[] = [], rcAll: unknown[] = [], rv: unknown[] = [];
    await b.subscribe("agent.subscribe", { sessionId: "s1" }, e => a1.push(e));
    await b.subscribe("agent.subscribe", { sessionId: "s2" }, e => a2.push(e));
    await b.subscribe("slack.subscribe", { channelIds: ["C1"] }, e => sl.push(e));
    await b.subscribe("slack.subscribe", { channelIds: [] }, e => slEmpty.push(e));
    await b.subscribe("receipts.subscribe", { sessionId: "s1" }, e => rc.push(e));
    await b.subscribe("receipts.subscribe", {}, e => rcAll.push(e));
    await b.subscribe("swarms.review.subscribe", { approvalId: "ap_other" }, e => rv.push(e));
    b.publish("agent.subscribe", agentEvt("s1", 0));
    b.publish("slack.subscribe", { type: "message", message: msg("C1") });
    b.publish("slack.subscribe", { type: "message", message: msg("C2") });
    b.publish("slack.subscribe", status);
    b.publish("receipts.subscribe", { ...fx.receipt, sessionId: "s2" });
    b.publish("swarms.review.subscribe", { ...fx.review, approvalId: "ap_x" });
    expect([a1.length, a2.length]).toEqual([1, 0]);
    expect(sl).toHaveLength(2);                       // C1 message + status
    expect(slEmpty).toEqual([status]);                // empty channelIds: status only
    expect([rc.length, rcAll.length, rv.length]).toEqual([0, 1, 0]);
  });

  it("holds live events during replay, then delivers them without duplicate seqs", async () => {
    const b = new FakeBridgeServer();
    b.onSubscribe("agent.subscribe", async (_req, emit) => {
      emit(agentEvt("s1", 0)); emit(agentEvt("s1", 1));
      b.publish("agent.subscribe", agentEvt("s1", 1));   // live, already replayed
      b.publish("agent.subscribe", agentEvt("s1", 2));   // live, new
      await tick();
    });
    const seqs: number[] = [];
    await b.subscribe("agent.subscribe", { sessionId: "s1" }, e => seqs.push(e.seq));
    expect(seqs).toEqual([0, 1, 2]);
    b.publish("agent.subscribe", agentEvt("s1", 3));
    expect(seqs).toEqual([0, 1, 2, 3]);
  });

  it("removes the subscription and surfaces a BridgeError when onSubscribe throws", async () => {
    const b = new FakeBridgeServer();
    b.onSubscribe("events.subscribe", () => { throw new Error("boom"); });
    const got: unknown[] = [];
    await expect(b.subscribe("events.subscribe", {}, e => got.push(e))).rejects.toMatchObject({ code: "internal" });
    b.publish("events.subscribe", fx.event);
    expect(got).toEqual([]);
    b.onSubscribe("tasks.subscribe", () => { throw new BridgeError("unauthorized", "no"); });
    await expect(b.subscribe("tasks.subscribe", {}, () => {})).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("delivers nothing after unsubscribe during replay and disposes a late cleanup", async () => {
    const b = new FakeBridgeServer();
    let disposed = 0;
    let handle: { dispose(): void } | undefined;
    b.onSubscribe("agent.subscribe", async (_req, emit) => {
      emit(agentEvt("s1", 0));
      handle?.dispose();                                  // unsubscribe mid-replay
      emit(agentEvt("s1", 1));                            // must be swallowed
      await tick();
      return { dispose: () => { disposed++; } };          // late cleanup
    });
    const seqs: number[] = [];
    await b.subscribe("agent.subscribe", { sessionId: "s1" }, e => seqs.push(e.seq), h => { handle = h; });
    b.publish("agent.subscribe", agentEvt("s1", 2));
    expect(seqs).toEqual([0]);
    expect(disposed).toBe(1);
  });
});
