import { afterEach, describe, expect, it, vi } from "vitest";
import { fx } from "../../contracts/fixtures";
import { FakeGit, MemoryGate, MemoryStore, fakeClock } from "../testing/memory-ports";
import { SessionsController, type HostPort } from "./sessions-controller";

// Hang-path audit (S5-T4): onFinished / onProcessError / cancel must end the session and release the host and the
// approvals waiter even when every store call throws. Awaits are bounded so a hang fails the test, not the run.

const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
const boom = () => Promise.reject(new Error("store I/O failed"));
const STORE_METHODS = ["putSession", "putTask", "appendAgentEvent", "agentEvents", "getSession", "getTask", "putNexusEvent"] as const;

function bounded<T>(p: Promise<T>, ms = 1500): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("HUNG: still pending")), ms))]);
}

async function setup() {
  const store = new MemoryStore();
  await store.putTask({ ...fx.task });
  const calls: string[] = [];
  const ended: Array<[string, string]> = [];
  const host: HostPort = {
    async startSession() { return {}; },
    async cancelSession(id) { calls.push(`cancel:${id}`); return {}; },
    endSession(id) { calls.push(`end:${id}`); },
  };
  const approvals = { request: vi.fn(), sessionEnded: vi.fn(async (id: string, how: string) => { ended.push([id, how]); }) };
  const logs: string[] = [];
  const c = new SessionsController({
    store, git: new FakeGit(), gate: new MemoryGate({ files: {} }), host, clock: fakeClock(), machineId: "m_adrian",
    getKey: async () => "k", approvals: approvals as never, log: m => logs.push(m),
  });
  const session = await c.start("task_01", model);
  return { c, store, calls, ended, logs, session };
}
const breakStore = (store: MemoryStore) => { for (const m of STORE_METHODS) vi.spyOn(store, m).mockImplementation(boom); };

afterEach(() => { vi.restoreAllMocks(); });

describe("sessions: a throwing store never wedges the controller", () => {
  it("onFinished: still releases approvals, ends the host session, and frees the controller", async () => {
    const s = await setup();
    breakStore(s.store);
    await bounded(s.c.onFinished({ sessionId: s.session.id, outcome: "done", reason: "all good" } as never));
    expect(s.ended).toEqual([[s.session.id, "done"]]);
    expect(s.calls).toContain(`end:${s.session.id}`);
    expect(s.c.activeSession).toBeUndefined();
    expect(s.logs.some(l => l.includes("could not save the session"))).toBe(true);
  });

  it("onProcessError: still releases approvals as failed, ends the host session, and frees the controller", async () => {
    const s = await setup();
    breakStore(s.store);
    await bounded(s.c.onProcessError(s.session.id, "agent process crashed"));
    expect(s.ended).toEqual([[s.session.id, "failed"]]);
    expect(s.calls).toContain(`end:${s.session.id}`);
    expect(s.c.activeSession).toBeUndefined();
  });

  it("cancel: with a failing store the session still ends cancelled in memory and the host is told", async () => {
    const s = await setup();
    breakStore(s.store);
    const ended = await bounded(s.c.cancel(s.session.id));
    expect(ended.status).toBe("cancelled");
    expect(s.ended).toEqual([[s.session.id, "cancelled"]]);
    expect(s.calls).toContain(`end:${s.session.id}`);
  });

  it("a second ending racing the first resolves once the first has finished, even when the store throws", async () => {
    const s = await setup();
    breakStore(s.store);
    const [a, b] = await bounded(Promise.all([s.c.cancel(s.session.id), s.c.onProcessError(s.session.id, "crash")]));
    expect(a.status).toBe("cancelled");
    expect(b).toBeUndefined();
    expect(s.ended).toHaveLength(1);
  });

  it("emit: an append failure rejects that emit but does not block or gap the chain", async () => {
    const s = await setup();
    s.store.failAppends = 1;
    await expect(bounded(s.c.emit(s.session.id, { type: "message", text: "lost" }))).rejects.toThrow("store unavailable");
    const e = await bounded(s.c.emit(s.session.id, { type: "message", text: "kept" }));
    const all = await s.store.agentEvents(s.session.id, 0);
    expect(all.map(x => x.seq)).toEqual(all.map((_, i) => i));
    expect(all.at(-1)).toMatchObject({ seq: e.seq, text: "kept" });
  });
});
