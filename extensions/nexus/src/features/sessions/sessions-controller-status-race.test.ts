import { afterEach, describe, expect, it, vi } from "vitest";
import { fx } from "../../contracts/fixtures";
import { FakeGit, MemoryGate, MemoryStore, fakeClock } from "../testing/memory-ports";
import { SessionsController, type HostPort } from "./sessions-controller";

// A setStatus write that is still in flight when the session ends must not leave a non-terminal status behind,
// and the terminal status event must stay the last one with a gap-free seq.

const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(r => { release = r; });
  return { promise, release };
}

async function setup() {
  const store = new MemoryStore();
  await store.putTask({ ...fx.task });
  const host: HostPort = { async startSession() { return {}; }, async cancelSession() { return {}; }, endSession() {} };
  const logs: string[] = [];
  const c = new SessionsController({
    store, git: new FakeGit(), gate: new MemoryGate({ files: {} }), host, clock: fakeClock(), machineId: "m_adrian",
    getKey: async () => "k", log: m => logs.push(m),
  });
  const session = await c.start("task_01", model);
  return { c, store, logs, session };
}

/** Make the first write of the non-terminal status wait on `gate`, then apply it (so it lands late). */
function hold(store: MemoryStore, which: "putSession" | "putTask" | "appendAgentEvent", gate: Promise<void>) {
  const orig = store[which].bind(store) as (x: never) => Promise<void>;
  let held = false;
  vi.spyOn(store, which).mockImplementation((async (x: { status?: string }) => {
    if (!held && x.status === "awaiting_approval") { held = true; await gate; }
    return orig(x as never);
  }) as never);
}

const ENDINGS = {
  "onProcessError": (c: SessionsController, id: string) => c.onProcessError(id, "crash").then(() => "failed"),
  "cancel": (c: SessionsController, id: string) => c.cancel(id).then(() => "cancelled"),
} as const;

afterEach(() => { vi.restoreAllMocks(); });

describe("sessions: setStatus racing the end of the session", () => {
  for (const held of ["putSession", "putTask", "appendAgentEvent"] as const) {
    for (const [name, end] of Object.entries(ENDINGS)) {
      it(`held ${held}, ended by ${name}: stored state is terminal and the final event is last`, async () => {
        const s = await setup();
        const d = deferred();
        hold(s.store, held, d.promise);
        const pending = s.c.setStatus(s.session.id, "awaiting_approval");
        await Promise.resolve();
        const ending = end(s.c, s.session.id);
        // Release once the ending has written its terminal status (a held event blocks it, so the final event is
        // not waited on); deterministic, no timers.
        await vi.waitFor(() => expect(s.store.sessions.get(s.session.id)?.status).toBe(name === "cancel" ? "cancelled" : "failed"));
        d.release();
        const terminal = await ending;
        await pending;
        expect((await s.store.getSession(s.session.id))?.status).toBe(terminal);
        expect((await s.store.getTask("task_01"))?.status).toBe(terminal);
        const events = await s.store.agentEvents(s.session.id, 0);
        expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i));
        expect(events.at(-1)).toMatchObject({ type: "status", status: terminal });
      });
    }
  }

  it("normal path: one status event, seq gap-free, session and task stored with the new status", async () => {
    const s = await setup();
    await s.c.setStatus(s.session.id, "awaiting_approval");
    const events = await s.store.agentEvents(s.session.id, 0);
    expect(events.filter(e => e.type === "status" && e.status === "awaiting_approval")).toHaveLength(1);
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i));
    expect((await s.store.getSession(s.session.id))?.status).toBe("awaiting_approval");
    expect((await s.store.getTask("task_01"))?.status).toBe("awaiting_approval");
  });

  it("a store failure while restoring the terminal state is logged, not thrown", async () => {
    const s = await setup();
    const d = deferred();
    hold(s.store, "putSession", d.promise);
    const pending = s.c.setStatus(s.session.id, "awaiting_approval");
    await Promise.resolve();
    await s.c.onProcessError(s.session.id, "crash");
    vi.spyOn(s.store, "putSession").mockRejectedValue(new Error("store down"));
    vi.spyOn(s.store, "putTask").mockRejectedValue(new Error("store down"));
    d.release();
    await expect(pending).resolves.toBeUndefined();
    expect(s.logs.some(l => l.includes("could not restore the session"))).toBe(true);
  });
});
