import { describe, expect, it } from "vitest";
import { FakeBridgeServer } from "../../bridge/fake-bridge-server";
import type { NexusEvent } from "../../contracts";
import { ACTIVITY_SQL, createActivity, registerActivity } from "./activity";
import type { ActivityQueryClient } from "./activity";
import { FakeEventStore } from "./fake-store";

const WS = async () => "ws_here";
const ev = (id: string, at: string, orbit = "main"): NexusEvent => ({
  id, kind: "commit", at, orbit, title: id, workspaceId: "w", machineId: "m", actor: { name: "a", kind: "human" }, target: { type: "commit", sha: "a".repeat(40) },
});
const localFrom = (events: NexusEvent[]) => {
  const s = new FakeEventStore({ seed: false });
  const ready = Promise.all(events.map(e => s.putNexusEvent(e)));
  return async (w: { from: string; to: string; limit: number }) => { await ready; return s.queryEvents({ from: w.from, to: w.to, limit: w.limit }); };
};
const EVENTS = [
  ev("1", "2026-11-07T10:00:00.000Z"),            // exactly on a boundary: belongs to 10:00
  ev("2", "2026-11-07T10:14:59.999Z"),            // still 10:00
  ev("3", "2026-11-07T10:15:00.000Z"),            // 10:15
  ev("4", "2026-11-07T10:20:00.000Z", "lane-1"),
  ev("5", "2026-11-07T10:20:30.000Z", "lane-1"),
  ev("6", "2026-11-07T10:44:00.000Z"),            // 10:30
  ev("7", "2026-11-07T10:45:00.000Z"),            // bucket 10:45 starts at `to`: excluded
  ev("8", "2026-11-07T09:59:59.000Z"),            // before the first bucket
];

describe("activity", () => {
  it("sends parameterised SQL and parses bigint strings", async () => {
    const calls: { text: string; params: unknown[] }[] = [];
    const query: ActivityQueryClient = { async query(text, params) { calls.push({ text, params }); return { rows: [
      { bucket: new Date("2026-11-07T10:00:00Z"), orbit: "main", count: "12" },
      { bucket: "2026-11-07T10:15:00+00:00", orbit: "lane-1", count: 3 },
    ] }; } };
    const activity = createActivity({ query, workspaceId: WS, localEvents: async () => { throw new Error("not used"); } });
    expect(await activity("2026-11-07T10:07:00Z", "2026-11-07T11:00:00+00:00")).toEqual([
      { bucketStart: "2026-11-07T10:00:00.000Z", orbit: "main", count: 12 },
      { bucketStart: "2026-11-07T10:15:00.000Z", orbit: "lane-1", count: 3 },
    ]);
    expect(calls).toEqual([{ text: ACTIVITY_SQL, params: ["2026-11-07T10:07:00.000Z", "2026-11-07T11:00:00.000Z", "ws_here"] }]);
    expect(ACTIVITY_SQL).toMatchInlineSnapshot(`"SELECT bucket, orbit, count FROM events_ws_15m WHERE workspace_id = $3 AND bucket >= time_bucket('15 minutes', $1::timestamptz) AND bucket < $2::timestamptz ORDER BY bucket, orbit"`);
  });

  it("reads the per-workspace aggregate, and uses the local copy without calling the client while the workspace is unknown", async () => {
    expect(ACTIVITY_SQL).toContain("FROM events_ws_15m WHERE workspace_id = $3 AND bucket >= ");
    const expected = await createActivity({ localEvents: localFrom(EVENTS) })("2026-11-07T10:00:00Z", "2026-11-07T10:45:00Z");
    for (const workspaceId of [undefined, async () => undefined, async (): Promise<string> => { throw new Error("not a repo"); }]) {
      let calls = 0;
      const query: ActivityQueryClient = { query: async () => { calls++; return { rows: [] }; } };
      const activity = createActivity({ query, ...(workspaceId ? { workspaceId } : {}), localEvents: localFrom(EVENTS) });
      expect(await activity("2026-11-07T10:00:00Z", "2026-11-07T10:45:00Z")).toEqual(expected);
      expect(calls).toBe(0);
    }
  });

  it("falls back to local when the remote fails, returns junk, or hangs past the budget", async () => {
    const expected = await createActivity({ localEvents: localFrom(EVENTS) })("2026-11-07T10:00:00Z", "2026-11-07T10:45:00Z");
    expect(expected.length).toBe(4);
    const bad: ActivityQueryClient[] = [
      { query: async () => { throw new Error("connection refused postgres://u:p@h/db"); } },
      { query: async () => ({ rows: [{ bucket: "2026-11-07T10:00:00Z", orbit: "main", count: "-1" }] }) },
      { query: () => new Promise(() => {}) },
    ];
    for (const query of bad) {
      const activity = createActivity({ query, workspaceId: WS, remoteBudgetMs: 20, localEvents: localFrom(EVENTS) });
      expect(await activity("2026-11-07T10:00:00Z", "2026-11-07T10:45:00Z")).toEqual(expected);
    }
  });

  it("computes epoch-aligned buckets locally, boundary events in their bucket, `to` exclusive", async () => {
    const activity = createActivity({ localEvents: localFrom(EVENTS) });
    expect(await activity("2026-11-07T10:07:00Z", "2026-11-07T10:45:00Z")).toEqual([
      { bucketStart: "2026-11-07T10:00:00.000Z", orbit: "main", count: 2 },
      { bucketStart: "2026-11-07T10:15:00.000Z", orbit: "lane-1", count: 2 },
      { bucketStart: "2026-11-07T10:15:00.000Z", orbit: "main", count: 1 },
      { bucketStart: "2026-11-07T10:30:00.000Z", orbit: "main", count: 1 },
    ]);
  });

  it("refuses bad windows without querying", async () => {
    let queries = 0, locals = 0;
    const activity = createActivity({ query: { query: async () => { queries++; return { rows: [] }; } }, workspaceId: WS, localEvents: async () => { locals++; return []; } });
    for (const [from, to] of [["x", "2026-11-07T10:00:00Z"], ["2026-11-07T10:00:00Z", "'; DROP TABLE events; --"], ["2026-11-07T10:00:00Z", "2026-11-07T10:00:00Z"],
      ["2026-11-07T11:00:00Z", "2026-11-07T10:00:00Z"], ["2026-10-01T00:00:00Z", "2026-11-07T00:00:00Z"]]) {
      await expect(activity(from, to)).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(await activity("2026-10-07T00:00:00Z", "2026-11-07T00:00:00Z")).toEqual([]); // exactly 31 days is allowed
    expect([queries, locals]).toEqual([1, 0]);
  });

  it("pages local reads when a window holds more than one page", async () => {
    const many: NexusEvent[] = Array.from({ length: 5200 }, (_, i) => ev(`e${i}`, new Date(Date.UTC(2026, 10, 7, 0, 0, 0) + i * 1000).toISOString()));
    const activity = createActivity({ localEvents: localFrom(many) });
    const total = (await activity("2026-11-07T00:00:00Z", "2026-11-07T03:00:00Z")).reduce((n, b) => n + b.count, 0);
    expect(total).toBe(5200);
  });

  it("orders remote rows like the local path, whatever the database collation returned", async () => {
    // an en_US collation can return "feature/x" before "feature-y" and "Main" after "lane-1"
    const rows = [
      { bucket: "2026-11-07T10:00:00Z", orbit: "lane-1", count: "1" },
      { bucket: "2026-11-07T10:00:00Z", orbit: "Main", count: "1" },
      { bucket: "2026-11-07T10:00:00Z", orbit: "feature/x", count: "1" },
      { bucket: "2026-11-07T10:00:00Z", orbit: "feature-y", count: "1" },
    ];
    const activity = createActivity({ query: { query: async () => ({ rows }) }, workspaceId: WS, localEvents: async () => [] });
    const orbits = (await activity("2026-11-07T10:00:00Z", "2026-11-07T11:00:00Z")).map(b => b.orbit);
    expect(orbits).toEqual(["Main", "feature-y", "feature/x", "lane-1"]);
  });

  it("serves events.activity through the bridge", async () => {
    const b = new FakeBridgeServer();
    registerActivity(b, createActivity({ localEvents: localFrom(EVENTS) }));
    expect(await b.call("events.activity", { from: "2026-11-07T10:00:00Z", to: "2026-11-07T10:15:00Z" })).toEqual([
      { bucketStart: "2026-11-07T10:00:00.000Z", orbit: "main", count: 2 },
    ]);
    await expect(b.call("events.activity", { from: "nope", to: "2026-11-07T10:15:00Z" })).rejects.toMatchObject({ code: "invalid_request" });
  });
});
