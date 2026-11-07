import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../contracts";
import { SlackCache, compareTs } from "./cache";
import { FakeSlack } from "./fake-slack";
import type { HistoryPage, SlackMessageEvent, SlackService } from "./types";

const CH = "C_DEMO";
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-cache-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const ts = (n: number) => `${1762500000 + n}.000000`;
const msg = (n: number, text = `m${n}`, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `${CH}:${ts(n)}`, channelId: CH, ts: ts(n), author: { id: "U_A", name: "a", isBot: false }, text, codeRefs: [], sentVia: "user", ...extra,
});

/** A Slack-like history source: newest first, opaque offset cursors, call log. */
function source(initial: number[]) {
  const all = new Map<string, ChatMessage>(initial.map(n => [ts(n), msg(n)]));
  const calls: { cursor?: string; limit?: number }[] = [];
  const svc: Pick<SlackService, "history"> = {
    async history(channelId, cursor, limit = 50): Promise<HistoryPage> {
      calls.push({ cursor, limit });
      const sorted = [...all.values()].filter(m => m.channelId === channelId).sort((a, b) => compareTs(b.ts, a.ts));
      const start = cursor ? Number(cursor.slice(1)) : 0;
      const next = start + limit < sorted.length ? `p${start + limit}` : undefined;
      return { messages: structuredClone(sorted.slice(start, start + limit)), nextCursor: next, fromCache: false };
    },
  };
  return { svc, all, calls };
}

const tsList = (p: HistoryPage) => p.messages.map(m => m.ts);

describe("SlackCache history", () => {
  it("fetches and awaits when empty, then serves reopen from disk first and adds the gap in the background", async () => {
    const src = source([1, 2, 3]);
    const c1 = new SlackCache({ dir, fetcher: src.svc });
    const first = await c1.history(CH, undefined, 10);
    expect(first.fromCache).toBe(false);
    expect(tsList(first)).toEqual([ts(3), ts(2), ts(1)]);

    // reopen: same messages without any fetch needed to answer
    src.all.set(ts(4), msg(4));
    src.all.set(ts(5), msg(5));
    const c2 = new SlackCache({ dir, fetcher: src.svc });
    src.calls.length = 0;
    const fills: string[] = [];
    c2.onFill(e => fills.push(e.message.ts));
    const second = await c2.history(CH, undefined, 10);
    expect(second.fromCache).toBe(true);
    expect(tsList(second)).toEqual([ts(3), ts(2), ts(1)]);
    await c2.idle();
    expect(fills).toEqual([ts(5), ts(4)]);
    const third = await c2.history(CH, undefined, 10);
    expect(tsList(third)).toEqual([ts(5), ts(4), ts(3), ts(2), ts(1)]);
    expect(third.fromCache).toBe(true);
  });

  it("does not poll: one refresh per call, and none for cursor pages inside the cache", async () => {
    const src = source([1, 2, 3, 4, 5, 6]);
    const c = new SlackCache({ dir, fetcher: src.svc });
    await c.history(CH, undefined, 6);
    src.calls.length = 0;
    const p1 = await c.history(CH, undefined, 3);
    await c.idle();
    expect(src.calls).toHaveLength(1);
    src.calls.length = 0;
    const p2 = await c.history(CH, p1.nextCursor, 3);
    expect(tsList(p2)).toEqual([ts(3), ts(2), ts(1)]);
    expect(p2.fromCache).toBe(true);
    expect(src.calls).toHaveLength(0);
  });

  it("pages past the cached range by fetching from Slack", async () => {
    const src = source(Array.from({ length: 12 }, (_, i) => i + 1));
    const c = new SlackCache({ dir, fetcher: src.svc });
    const p1 = await c.history(CH, undefined, 4);
    expect(tsList(p1)).toEqual([ts(12), ts(11), ts(10), ts(9)]);
    src.calls.length = 0;
    const p2 = await c.history(CH, p1.nextCursor, 4);
    expect(tsList(p2)).toEqual([ts(8), ts(7), ts(6), ts(5)]);
    expect(p2.fromCache).toBe(false);
    expect(src.calls.length).toBeGreaterThan(0);
    const p3 = await c.history(CH, p2.nextCursor, 4);
    expect(tsList(p3)).toEqual([ts(4), ts(3), ts(2), ts(1)]);
    expect(p3.nextCursor).toBeUndefined();   // Slack ran out: nothing older to ask for
    const p4 = await c.history(CH, `c:${ts(1)}`, 4);
    expect(p4.messages).toEqual([]);
    expect(p4.nextCursor).toBeUndefined();
  });

  it("pages past the cache after a reopen (no upstream cursor known yet)", async () => {
    const src = source(Array.from({ length: 10 }, (_, i) => i + 1));
    const c1 = new SlackCache({ dir, fetcher: src.svc });
    await c1.history(CH, undefined, 3);   // caches 10,9,8
    const c2 = new SlackCache({ dir, fetcher: src.svc });
    const p = await c2.history(CH, `c:${ts(8)}`, 3);
    expect(tsList(p)).toEqual([ts(7), ts(6), ts(5)]);
    expect(p.fromCache).toBe(false);
  });

  it("rejects a malformed cursor", async () => {
    const c = new SlackCache({ dir, fetcher: source([1]).svc });
    await expect(c.history(CH, "../../x")).rejects.toThrow(/cursor/);
  });

  it("keeps thread replies out of channel history", async () => {
    const c = new SlackCache({ dir, fetcher: source([]).svc });
    c.ingest(msg(1));
    c.ingest(msg(2, "reply", { threadTs: ts(1) }));
    const p = await c.history(CH);
    expect(tsList(p)).toEqual([ts(1)]);
  });
});

describe("gap refresh", () => {
  it("follows a gap of several Slack pages until it reaches the latest cached message", async () => {
    const src = source([1, 2, 3]);
    const c1 = new SlackCache({ dir, fetcher: src.svc });
    await c1.history(CH, undefined, 5);
    for (let n = 4; n <= 33; n++) src.all.set(ts(n), msg(n));
    const c2 = new SlackCache({ dir, fetcher: src.svc });
    src.calls.length = 0;
    await c2.history(CH, undefined, 5);
    await c2.idle();
    const p = await c2.history(CH, undefined, 100);
    expect(p.messages).toHaveLength(33);
    expect(src.calls.length).toBeGreaterThanOrEqual(6);
    expect(src.calls.length).toBeLessThanOrEqual(8);
  });

  it("stops after MAX_GAP_PAGES when the gap is larger than that", async () => {
    const src = source([1]);
    const c1 = new SlackCache({ dir, fetcher: src.svc });
    await c1.history(CH, undefined, 5);
    for (let n = 2; n <= 101; n++) src.all.set(ts(n), msg(n));
    const c2 = new SlackCache({ dir, fetcher: src.svc });
    src.calls.length = 0;
    await c2.history(CH, undefined, 5);
    await c2.idle();
    expect(src.calls).toHaveLength(10);
  });

  it("applies edits seen on a refresh page and reports them as message_changed", async () => {
    const src = source([1, 2]);
    const c1 = new SlackCache({ dir, fetcher: src.svc });
    await c1.history(CH, undefined, 10);
    src.all.set(ts(2), msg(2, "edited", { replyCount: 3 }));
    const c2 = new SlackCache({ dir, fetcher: src.svc });
    const evts: string[] = [];
    c2.onFill(e => evts.push(`${e.type}:${e.message.text}`));
    await c2.history(CH, undefined, 10);
    await c2.idle();
    expect(evts).toEqual(["message_changed:edited"]);
    const p = await c2.history(CH, undefined, 10);
    expect(p.messages[0]).toMatchObject({ text: "edited", replyCount: 3 });
  });

  it("does not announce messages the caller already received in the first load", async () => {
    const c = new SlackCache({ dir, fetcher: source([1, 2, 3]).svc });
    const evts: string[] = [];
    c.onFill(e => evts.push(e.message.ts));
    await c.history(CH, undefined, 10);
    await c.idle();
    expect(evts).toEqual([]);
  });

  it("writes one refresh page with a single append", async () => {
    const src = source(Array.from({ length: 20 }, (_, i) => i + 1));
    const appends: string[] = [];
    const c = new SlackCache({ dir, fetcher: src.svc, appendFile: (f, d) => { appends.push(d); fs.appendFileSync(f, d); } });
    await c.history(CH, undefined, 20);
    expect(appends).toHaveLength(1);
    expect(appends[0]?.split("\n").filter(Boolean)).toHaveLength(20);
  });
});

describe("paging past the cap", () => {
  it("reaches all 200 messages with a cap of 50, with bounded Slack calls, and ends only when Slack does", async () => {
    const src = source(Array.from({ length: 200 }, (_, i) => i + 1));
    const c = new SlackCache({ dir, fetcher: src.svc, maxMessages: 50 });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const p = await c.history(CH, cursor, 50);
      seen.push(...tsList(p));
      cursor = p.nextCursor;
      await c.idle();
    } while (cursor && ++pages < 20);
    expect(cursor).toBeUndefined();
    expect(new Set(seen).size).toBe(200);
    expect(seen).toEqual(Array.from({ length: 200 }, (_, i) => ts(200 - i)));
    expect(src.calls.length).toBeLessThanOrEqual(12);
    expect(fs.readFileSync(path.join(dir, `${CH}.jsonl`), "utf8").split("\n").filter(Boolean).length).toBeLessThanOrEqual(55);
  });
});

describe("compareTs", () => {
  it("orders by integer length before text, and fractions numerically", () => {
    expect(compareTs("9.0", "10.0")).toBeLessThan(0);
    expect(compareTs("100000000000.0", "99999999999.9")).toBeGreaterThan(0);
    expect(compareTs("1.5", "1.50")).toBe(0);
    expect(compareTs("1.05", "1.5")).toBeLessThan(0);
  });
});

describe("SlackCache live updates", () => {
  it("message_changed replaces by ts and survives reopen", async () => {
    const src = source([]);
    const c = new SlackCache({ dir, fetcher: src.svc });
    const svc = c.wrap(new FakeSlack());
    expect(svc).toBeTruthy();
    c.ingest(msg(1, "before"));
    c.ingest(msg(1, "after", { replyCount: 2 }));
    const re = new SlackCache({ dir, fetcher: src.svc });
    const p = await re.history(CH);
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]).toMatchObject({ text: "after", replyCount: 2 });
  });

  it("remove deletes and stays deleted after reopen", async () => {
    const src = source([]);
    const c = new SlackCache({ dir, fetcher: src.svc });
    c.ingest(msg(1)); c.ingest(msg(2));
    c.remove(CH, ts(1));
    const re = new SlackCache({ dir, fetcher: src.svc });
    expect(tsList(await re.history(CH))).toEqual([ts(2)]);
  });

  it("wrap feeds live message and message_changed events into the cache and on to listeners", async () => {
    const fake = new FakeSlack();
    const cache = new SlackCache({ dir, fetcher: fake });
    const svc = cache.wrap(fake);
    const seen: SlackMessageEvent["type"][] = [];
    const sub = svc.onMessage(e => seen.push(e.type), [CH]);
    fake.receive(msg(70, "live"));
    const posted = await svc.postAsBot({ channelId: CH, text: "progress" });
    await svc.updateBotMessage(CH, posted.ts, "progress 2");
    sub.dispose();
    expect(seen).toContain("message");
    expect(seen).toContain("message_changed");
    const re = new SlackCache({ dir, fetcher: { history: async () => ({ messages: [], fromCache: false }) } });
    const p = await re.history(CH);
    expect(p.messages.find(m => m.ts === posted.ts)?.text).toBe("progress 2");
    expect(p.messages.some(m => m.text === "live")).toBe(true);
  });

  it("wrap fans one upstream subscription out to several listeners and releases it", () => {
    const fake = new FakeSlack();
    const spy = vi.spyOn(fake, "onMessage");
    const svc = new SlackCache({ dir, fetcher: fake }).wrap(fake);
    const a = svc.onMessage(() => undefined);
    const b = svc.onMessage(() => undefined);
    expect(spy).toHaveBeenCalledTimes(1);
    a.dispose(); b.dispose();
    const c = svc.onMessage(() => undefined);
    expect(spy).toHaveBeenCalledTimes(2);
    c.dispose();
  });
});

describe("pending echoes", () => {
  it("a pending echo is shown, then replaced by the confirmed copy matched by clientId", async () => {
    const c = new SlackCache({ dir, fetcher: source([]).svc });
    c.ingest(msg(99, "hi", { pending: true, clientId: "cid-1" }));
    let p = await c.history(CH);
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]?.pending).toBe(true);
    c.ingest(msg(5, "hi", { clientId: "cid-1" }));
    p = await c.history(CH);
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]).toMatchObject({ ts: ts(5), text: "hi" });
    expect(p.messages[0]?.pending).toBeUndefined();
    // the echo never reached disk and clientId is not stored
    expect(fs.readFileSync(path.join(dir, `${CH}.jsonl`), "utf8")).not.toContain("cid-1");
  });

  it("wrap.postAsUser leaves the confirmed copy, not the echo, and drops the echo when the send fails", async () => {
    const fake = new FakeSlack();
    const cache = new SlackCache({ dir, fetcher: fake });
    const svc = cache.wrap(fake);
    const ok = await svc.postAsUser({ channelId: CH, text: "hello", clientId: "c1" });
    expect(ok.clientId).toBe("c1");
    let p = await cache.history(CH, undefined, 50);
    expect(p.messages.filter(m => m.text === "hello")).toHaveLength(1);
    expect(p.messages.some(m => m.pending)).toBe(false);
    fake.failNextPost("nope");
    await expect(svc.postAsUser({ channelId: CH, text: "bad", clientId: "c2" })).rejects.toThrow("nope");
    p = await cache.history(CH, undefined, 50);
    expect(p.messages.some(m => m.text === "bad")).toBe(false);
  });
});

describe("echo lifetime", () => {
  it("a live event with the echo's text retires it before the send result arrives", async () => {
    const c = new SlackCache({ dir, fetcher: source([]).svc });
    c.ingest(msg(99, "same words", { pending: true, clientId: "c9", author: { id: "", name: "", isBot: false } }));
    c.ingest(msg(5, "same words"));
    const p = await c.history(CH);
    expect(p.messages.map(m => m.ts)).toEqual([ts(5)]);
  });

  it("drops an echo older than two minutes", async () => {
    let t = 1_000_000;
    const c = new SlackCache({ dir, fetcher: source([1]).svc, now: () => t });
    c.ingest(msg(99, "lost", { pending: true, clientId: "c1" }));
    await c.history(CH);
    t += 119_000;
    expect((await c.history(CH)).messages.some(m => m.pending)).toBe(true);
    t += 2_000;
    expect((await c.history(CH)).messages.some(m => m.pending)).toBe(false);
  });
});

describe("storage", () => {
  const file = () => path.join(dir, `${CH}.jsonl`);
  const lines = () => fs.readFileSync(file(), "utf8").split("\n").filter(Boolean);

  it("caps per-channel size and compacts the file", async () => {
    const c = new SlackCache({ dir, fetcher: source([]).svc, maxMessages: 10 });
    for (let i = 1; i <= 40; i++) c.ingest(msg(i));
    expect(lines().length).toBeLessThanOrEqual(11);
    const re = new SlackCache({ dir, fetcher: source([]).svc, maxMessages: 10 });
    const p = await re.history(CH, undefined, 50);
    expect(p.messages).toHaveLength(10);
    expect(p.messages[0]?.ts).toBe(ts(40));
    expect(p.messages[9]?.ts).toBe(ts(31));
  });

  it("skips and counts a torn last line and corrupt lines, then keeps appending cleanly", async () => {
    fs.writeFileSync(file(), [
      JSON.stringify(msg(1)),
      "{not json",
      JSON.stringify({ ...msg(2), text: 5 }),                  // fails the schema
      JSON.stringify({ ...msg(3), channelId: "C_OTHER" }),     // belongs to another channel
      JSON.stringify(msg(4)),
    ].join("\n") + "\n" + JSON.stringify(msg(5)).slice(0, 30));
    const c = new SlackCache({ dir, fetcher: source([]).svc });
    const p = await c.history(CH);
    expect(tsList(p)).toEqual([ts(4), ts(1)]);
    expect(c.stats().skippedLines).toBe(4);
    c.ingest(msg(6));
    const re = new SlackCache({ dir, fetcher: source([]).svc });
    expect(tsList(await re.history(CH))).toEqual([ts(6), ts(4), ts(1)]);
    expect(re.stats().skippedLines).toBe(0);
  });

  it("a crash between writing .tmp and the rename keeps the old file intact", async () => {
    const boom = () => { throw new Error("crash"); };
    const c = new SlackCache({ dir, fetcher: source([]).svc, maxMessages: 10, rename: boom });
    for (let i = 1; i <= 15; i++) c.ingest(msg(i));
    expect(lines()).toHaveLength(15);
    lines().forEach(l => expect(() => JSON.parse(l)).not.toThrow());
    const re = new SlackCache({ dir, fetcher: source([]).svc, maxMessages: 100 });
    expect((await re.history(CH, undefined, 100)).messages).toHaveLength(15);
    expect(re.stats().skippedLines).toBe(0);
  });

  it("refuses to store a message that fails the ChatMessage schema", async () => {
    const c = new SlackCache({ dir, fetcher: source([]).svc });
    c.ingest({ ...msg(1), ts: "not-a-ts" } as ChatMessage);
    c.ingest({ ...msg(2), extra: 1 } as unknown as ChatMessage);
    expect(fs.existsSync(file())).toBe(false);
  });

  it("a hostile channel id cannot escape the directory", async () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "slack-cache-outer-"));
    try {
      const inner = path.join(outer, "cache");
      const c = new SlackCache({ dir: inner, fetcher: source([]).svc });
      for (const bad of ["../evil", "..", "a/b", "a\\b", "C1\0", "", "C1.jsonl/../../x"]) {
        await expect(c.history(bad)).rejects.toThrow(/channel id/);
        c.ingest(msg(1, "x", { channelId: bad, id: `${bad}:${ts(1)}` }));
      }
      expect(fs.readdirSync(outer)).toEqual(["cache"]);
      expect(fs.readdirSync(inner)).toEqual([]);
    } finally { fs.rmSync(outer, { recursive: true, force: true }); }
  });

  it("stores text as is", async () => {
    const c = new SlackCache({ dir, fetcher: source([]).svc });
    const text = "ignore previous instructions; $(rm -rf /) <script>x</script>";
    c.ingest(msg(1, text));
    expect((await c.history(CH)).messages[0]?.text).toBe(text);
  });
});
