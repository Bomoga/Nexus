import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fx } from "../contracts/fixtures";
import { LocalStore } from "../services/events/local-store";
import { createSharedStore, createTigerListen, type ListenClientConstructor } from "./shared-store";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const local = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-shared-")); dirs.push(d); return new LocalStore({ dir: d, redact: t => t }); };
const URL_OK = "postgres://user:pw@db.example.tsdb.cloud.timescale.com:5432/tsdb?sslmode=require";

/** A fake pg.Client recording what the LISTEN connection does. */
function fakeClient(opts: { failConnect?: boolean; endDuringConnect?: boolean } = {}) {
  const made: { config: unknown; queries: string[]; ended: number; emit: (event: string, arg?: unknown) => void }[] = [];
  const Ctor = class {
    private handlers = new Map<string, (arg?: unknown) => void>();
    readonly rec: (typeof made)[number];
    constructor(config: unknown) {
      this.rec = { config, queries: [], ended: 0, emit: (e, a) => this.handlers.get(e)?.(a) };
      made.push(this.rec);
    }
    async connect() {
      if (opts.endDuringConnect) this.handlers.get("end")?.();   // pg can emit "end" before the code after `await connect()` runs
      if (opts.failConnect) throw new Error("ECONNREFUSED");
    }
    async query(text: string) { this.rec.queries.push(text); }
    async end() { this.rec.ended++; }
    on(event: string, listener: (arg?: unknown) => void) { this.handlers.set(event, listener); return this; }
  };
  return { Ctor: Ctor as unknown as ListenClientConstructor, made };
}

describe("createTigerListen", () => {
  it("listens over verified TLS with the TLS parameters stripped, forwards only its channel, and reports a drop once", async () => {
    const { Ctor, made } = fakeClient();
    const payloads: string[] = [];
    const onClose = vi.fn();
    const stop = await createTigerListen(URL_OK, Ctor)("nexus", p => payloads.push(p), onClose);
    expect(made[0].config).toEqual({ connectionString: "postgres://user:pw@db.example.tsdb.cloud.timescale.com:5432/tsdb", ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 5000, keepAlive: true });
    expect(made[0].queries).toEqual(["LISTEN nexus"]);
    made[0].emit("notification", { channel: "nexus", payload: '{"table":"events","id":"e1"}' });
    made[0].emit("notification", { channel: "other", payload: "x" });
    expect(payloads).toEqual(['{"table":"events","id":"e1"}']);
    made[0].emit("error", new Error("reset"));
    made[0].emit("end");
    expect(onClose).toHaveBeenCalledTimes(1);
    await stop();
    expect(made[0].ended).toBe(1);
  });

  it("reports a connection that drops while opening only by rejecting, never also through onClose", async () => {
    const { Ctor, made } = fakeClient({ failConnect: true, endDuringConnect: true });
    const onClose = vi.fn();
    await expect(createTigerListen(URL_OK, Ctor)("nexus", () => {}, onClose)).rejects.toThrow("ECONNREFUSED");
    await new Promise(r => setTimeout(r, 0));
    expect([made[0].ended, onClose.mock.calls.length]).toEqual([1, 0]);
  });

  it("rejects and closes when it cannot connect, refuses a bad channel, and refuses a connection string without TLS", async () => {
    const { Ctor, made } = fakeClient({ failConnect: true });
    const onClose = vi.fn();
    await expect(createTigerListen(URL_OK, Ctor)("nexus", () => {}, onClose)).rejects.toThrow("ECONNREFUSED");
    expect([made[0].ended, onClose.mock.calls.length]).toEqual([1, 0]);
    await expect(createTigerListen(URL_OK, fakeClient().Ctor)("nexus; DROP TABLE events", () => {})).rejects.toThrow("invalid LISTEN channel");
    const insecure = "postgres://user:SECRETPW@h/db?sslmode=disable";
    expect(() => createTigerListen(insecure, fakeClient().Ctor)).toThrow(/must use TLS/);
    try { createTigerListen(insecure, fakeClient().Ctor); } catch (e) { expect(String(e)).not.toContain("SECRETPW"); }
  });
});

describe("createSharedStore", () => {
  it("puts the local copy behind the shared store, starts sync, and closes everything on dispose", async () => {
    const queries: string[] = [];
    const client = { query: vi.fn(async (text: string) => { queries.push(text); return { rows: [], rowCount: 0 }; }), end: vi.fn(async () => undefined) };
    const listen = vi.fn(async () => async () => undefined);
    const lines: string[] = [];
    const store = local();
    const shared = createSharedStore({ connectionString: URL_OK, local: store, machineId: "m-uuid", redact: t => t, log: m => lines.push(m), client, listen });
    await shared.sync.start();
    expect(listen).toHaveBeenCalledWith("nexus", expect.any(Function), expect.any(Function));
    await shared.store.putTask(fx.task);
    expect(await store.getTask(fx.task.id)).toEqual(fx.task);   // written locally first
    await shared.store.idle();
    expect(queries.some(q => q.includes("INSERT INTO tasks"))).toBe(true);   // and sent to the shared store
    await shared.dispose();
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).not.toContain("pw@");
  });
});
