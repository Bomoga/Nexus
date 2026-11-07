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
    expect(b.subscriptionCount()).toBe(0);
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

  it("matches scoped subscriptions, not just excludes them", async () => {
    const b = new FakeBridgeServer();
    const rc: unknown[] = [], rcAll: unknown[] = [], rv: unknown[] = [], rvAll: unknown[] = [], sl: unknown[] = [];
    await b.subscribe("receipts.subscribe", { sessionId: "s1" }, e => rc.push(e));
    await b.subscribe("receipts.subscribe", {}, e => rcAll.push(e));
    await b.subscribe("swarms.review.subscribe", { approvalId: "ap_x" }, e => rv.push(e));
    await b.subscribe("swarms.review.subscribe", {}, e => rvAll.push(e));
    await b.subscribe("slack.subscribe", { channelIds: ["C1"] }, e => sl.push(e));
    b.publish("receipts.subscribe", { ...fx.receipt, sessionId: "s1" });
    const noSession = structuredClone(fx.receipt);
    delete noSession.sessionId;
    b.publish("receipts.subscribe", noSession);       // no sessionId: unscoped subscribers only
    b.publish("swarms.review.subscribe", { ...fx.review, approvalId: "ap_x" });
    b.publish("swarms.review.subscribe", { ...fx.review, approvalId: "ap_y" });
    b.publish("slack.subscribe", { type: "message_changed", message: msg("C1") });
    b.publish("slack.subscribe", { type: "message_changed", message: msg("C2") });
    expect([rc.length, rcAll.length, rv.length, rvAll.length, sl.length]).toEqual([1, 2, 1, 2, 1]);
  });

  it("honours fromSeq on empty replay, held and live paths", async () => {
    const b = new FakeBridgeServer();
    b.onSubscribe("agent.subscribe", async () => {
      b.publish("agent.subscribe", agentEvt("s1", 3));   // held, below fromSeq
      b.publish("agent.subscribe", agentEvt("s1", 5));   // held
      await tick();
    });
    const seqs: number[] = [];
    await b.subscribe("agent.subscribe", { sessionId: "s1", fromSeq: 5 }, e => seqs.push(e.seq));
    b.publish("agent.subscribe", agentEvt("s1", 4));     // live, below fromSeq
    b.publish("agent.subscribe", agentEvt("s1", 5));     // live, duplicate
    b.publish("agent.subscribe", agentEvt("s1", 6));
    expect(seqs).toEqual([5, 6]);
  });

  it("drops a live repeat of a replayed seq with no handler delay", async () => {
    const b = new FakeBridgeServer();
    b.onSubscribe("agent.subscribe", (_req, emit) => { emit(agentEvt("s1", 0)); emit(agentEvt("s1", 1)); });
    const seqs: number[] = [];
    await b.subscribe("agent.subscribe", { sessionId: "s1" }, e => seqs.push(e.seq));
    b.publish("agent.subscribe", agentEvt("s1", 1));
    expect(seqs).toEqual([0, 1]);
  });

  it("keeps order when a subscriber publishes during the drain", async () => {
    const b = new FakeBridgeServer();
    b.onSubscribe("agent.subscribe", async () => {
      for (const seq of [0, 1, 2]) b.publish("agent.subscribe", agentEvt("s1", seq));
      await tick();
    });
    const seqs: number[] = [];
    await b.subscribe("agent.subscribe", { sessionId: "s1" }, e => {
      seqs.push(e.seq);
      if (e.seq === 0) b.publish("agent.subscribe", agentEvt("s1", 3));
    });
    expect(seqs).toEqual([0, 1, 2, 3]);

    b.onSubscribe("tasks.subscribe", async () => {
      b.publish("tasks.subscribe", fx.task);
      b.publish("tasks.subscribe", { ...fx.task, id: "b" });
      await tick();
    });
    const ids: string[] = [];
    await b.subscribe("tasks.subscribe", {}, t => {
      ids.push(t.id);
      if (t.id === fx.task.id) b.publish("tasks.subscribe", { ...fx.task, id: "c" });
    });
    expect(ids).toEqual([fx.task.id, "b", "c"]);
  });

  it("makes emit inert once the handler has settled", async () => {
    const b = new FakeBridgeServer();
    let stored: ((e: AgentEvent) => void) | undefined;
    b.onSubscribe("agent.subscribe", (_req, emit) => { stored = emit; });
    const seqs: number[] = [];
    await b.subscribe("agent.subscribe", { sessionId: "s1" }, e => seqs.push(e.seq));
    stored?.(agentEvt("s1", 7));
    expect(seqs).toEqual([]);
  });

  it("cleans up when a subscriber throws during the drain", async () => {
    const b = new FakeBridgeServer();
    let disposed = 0;
    b.onSubscribe("agent.subscribe", async () => {
      b.publish("agent.subscribe", agentEvt("s1", 0));
      await tick();
      return { dispose: () => { disposed++; } };
    });
    await expect(b.subscribe("agent.subscribe", { sessionId: "s1" }, () => { throw new Error("boom"); })).rejects.toMatchObject({ code: "internal" });
    expect([b.subscriptionCount(), disposed]).toEqual([0, 1]);
  });

  it("disposes cleanup on unsubscribe, including during the drain", async () => {
    const b = new FakeBridgeServer();
    let disposed = 0;
    b.onSubscribe("tasks.subscribe", () => ({ dispose: () => { disposed++; } }));
    const h = await b.subscribe("tasks.subscribe", {}, () => {});
    h.dispose(); h.dispose();
    expect([b.subscriptionCount(), disposed]).toEqual([0, 1]);

    let handle: { dispose(): void } | undefined;
    disposed = 0;
    b.onSubscribe("agent.subscribe", async () => {
      for (const seq of [0, 1]) b.publish("agent.subscribe", agentEvt("s1", seq));
      await tick();
      return { dispose: () => { disposed++; } };
    });
    const seqs: number[] = [];
    await b.subscribe("agent.subscribe", { sessionId: "s1" }, e => { seqs.push(e.seq); handle?.dispose(); }, h2 => { handle = h2; });
    expect([seqs, b.subscriptionCount(), disposed]).toEqual([[0], 0, 1]);
  });

  it("drops events published while a handler rejects", async () => {
    const b = new FakeBridgeServer();
    b.onSubscribe("agent.subscribe", async () => {
      b.publish("agent.subscribe", agentEvt("s1", 0));
      await tick();
      throw new BridgeError("offline", "no store");
    });
    const seqs: number[] = [];
    await expect(b.subscribe("agent.subscribe", { sessionId: "s1" }, e => seqs.push(e.seq))).rejects.toMatchObject({ code: "offline" });
    expect(seqs).toEqual([]);
  });
});
