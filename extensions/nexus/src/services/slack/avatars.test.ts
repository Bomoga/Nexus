import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SlackUser } from "../../contracts";
import { createAvatarResolver, dropAvatars, type AvatarFetch } from "./avatars";

const URL_OK = "https://avatars.slack-edge.com/2024/abc_72.png";
const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

function image(over: { status?: number; type?: string | null; length?: string; body?: Uint8Array } = {}): Response {
  const headers: Record<string, string> = {};
  if (over.type !== null) headers["content-type"] = over.type ?? "image/png";
  if (over.length) headers["content-length"] = over.length;
  return new Response(over.body ?? PNG, { status: over.status ?? 200, headers });
}
function make(respond: () => Response | Promise<Response> = () => image(), extra: { now?: () => number; cacheDir?: string } = {}) {
  const fetch = vi.fn<AvatarFetch>(async () => respond());
  const logs: string[] = [];
  return { fetch, logs, r: createAvatarResolver({ fetch, log: m => logs.push(m), ...extra }) };
}
const user = (avatarUrl?: string): SlackUser => ({ id: "U1", name: "a", displayName: "A", isBot: false, ...(avatarUrl ? { avatarUrl } : {}) });

describe("avatar resolver", () => {
  it.each(["https://avatars.slack-edge.com/x.png", "https://secure.gravatar.com/avatar/x", "https://a.slack-edge.com/x.png", "https://ca.slack-edge.com/T-U-x-72"])("serves %s as a data URI the contract accepts", async url => {
    const { r, fetch } = make();
    const uri = await r.toDataUri(url);
    expect(uri).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
    expect(SlackUser.parse(user(uri)).avatarUrl).toBe(uri);
    const init = fetch.mock.calls[0]![1];
    expect(init).toMatchObject({ redirect: "error", credentials: "omit" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(init.headers)).toEqual(["accept"]);
  });

  it.each([
    "http://avatars.slack-edge.com/x.png", "https://evil.example/x.png", "https://avatars.slack-edge.com.evil.example/x.png",
    "https://user:pw@avatars.slack-edge.com/x.png", "https://avatars.slack-edge.com:8443/x.png", "https://127.0.0.1/x.png", "https://[::1]/x.png",
    "data:image/png;base64,AAAA", "file:///etc/passwd", "not a url", "",
  ])("never fetches %s", async url => {
    const { r, fetch } = make();
    expect(await r.toDataUri(url)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong content type", () => image({ type: "text/html" })],
    ["svg", () => image({ type: "image/svg+xml" })],
    ["no content type", () => image({ type: null })],
    ["non-200", () => image({ status: 404 })],
    ["oversized content-length", () => image({ length: String(64 * 1024 + 1) })],
    ["oversized body without content-length", () => image({ body: new Uint8Array(64 * 1024 + 1) })],
    ["oversized body with a lying content-length", () => image({ length: "10", body: new Uint8Array(64 * 1024 + 1) })],
    ["empty body", () => image({ body: new Uint8Array(0) })],
  ])("gives undefined for %s", async (_n, respond) => {
    const { r } = make(respond);
    expect(await r.toDataUri(URL_OK)).toBeUndefined();
  });

  it("accepts a content type with parameters and a body of exactly 64 KB", async () => {
    const { r } = make(() => image({ type: "image/JPEG; charset=binary", body: new Uint8Array(64 * 1024) }));
    expect(await r.toDataUri(URL_OK)).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("gives undefined on a redirect error, a timeout and an abort, logging the host only", async () => {
    for (const err of [new TypeError("unexpected redirect"), new DOMException("timed out", "TimeoutError"), new DOMException("aborted", "AbortError")]) {
      const { r, logs } = make(() => { throw err; });
      expect(await r.toDataUri(`${URL_OK}?token=secret`)).toBeUndefined();
      expect(logs.join("\n")).toContain("avatars.slack-edge.com");
      expect(logs.join("\n")).not.toMatch(/secret|abc_72|https?:/);
    }
  });

  it("fetches once for repeated and for concurrent calls", async () => {
    const { r, fetch } = make();
    const [a, b] = await Promise.all([r.toDataUri(URL_OK), r.toDataUri(URL_OK)]);
    expect(a).toBe(b);
    await r.toDataUri(URL_OK);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("remembers a failure for a few minutes, then tries again", async () => {
    let t = 1_000_000, good = false;
    const { r, fetch } = make(() => (good ? image() : image({ status: 500 })), { now: () => t });
    expect(await r.toDataUri(URL_OK)).toBeUndefined();
    t += 60_000;
    expect(await r.toDataUri(URL_OK)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    good = true; t += 5 * 60_000;
    expect(await r.toDataUri(URL_OK)).toMatch(/^data:image\/png/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("caps the in-memory cache", async () => {
    const { r, fetch } = make();
    for (let n = 0; n < 501; n++) await r.toDataUri(`https://avatars.slack-edge.com/${n}.png`);
    await r.toDataUri("https://avatars.slack-edge.com/0.png");
    expect(fetch).toHaveBeenCalledTimes(502);
  });

  it("keeps a disk cache named by a hash of the URL, and reads it back", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "avatars-"));
    try {
      const first = make(() => image(), { cacheDir: dir });
      const uri = await first.r.toDataUri(URL_OK);
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^[0-9a-f]{64}\.txt$/);
      const second = make(() => image({ status: 500 }), { cacheDir: dir });
      expect(await second.r.toDataUri(URL_OK)).toBe(uri);
      expect(second.fetch).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("maps users: data URI when fetched, no avatarUrl otherwise, never a remote URL", async () => {
    const { r } = make(() => image());
    const bad = make(() => image({ status: 404 }));
    const users = [user(URL_OK), user("https://evil.example/x.png"), user()];
    const out = await r.mapUsers(users);
    expect(out[0]!.avatarUrl).toMatch(/^data:image\/png;base64,/);
    expect(out[1]).not.toHaveProperty("avatarUrl");
    expect(out[2]).not.toHaveProperty("avatarUrl");
    expect((await bad.r.mapUsers(users)).some(u => "avatarUrl" in u)).toBe(false);
    out.forEach(u => SlackUser.parse(u));
  });

  it("dropAvatars removes every avatarUrl", () => {
    expect(dropAvatars([user(URL_OK)])).toEqual([user()]);
  });
});
