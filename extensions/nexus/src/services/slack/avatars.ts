// Slack avatars for the webviews. Webviews never load remote content (CLAUDE.md section 14), so the extension host fetches the
// public CDN image and hands over a data: URI. vscode-free; the fetch is injected.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SlackUser } from "../../contracts";

/** The only hosts an avatar is ever fetched from: Slack's avatar CDN and its default / Gravatar avatars. */
const AVATAR_HOSTS = new Set(["avatars.slack-edge.com", "secure.gravatar.com", "a.slack-edge.com", "ca.slack-edge.com"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 3000;
const FAILURE_MEMORY_MS = 5 * 60_000;
const MAX_ENTRIES = 500;
const DATA_URI = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export type AvatarFetch = (url: string, init: { signal: AbortSignal; redirect: "error"; credentials: "omit"; headers: Record<string, string> }) => Promise<Response>;

export interface AvatarResolver {
  /** A data: URI for the avatar, or undefined when it is not an allowed URL or could not be fetched. Never throws. */
  toDataUri(remoteUrl: string | undefined): Promise<string | undefined>;
  /** The users with avatarUrl replaced by a data: URI, or dropped. Never throws. */
  mapUsers(users: SlackUser[]): Promise<SlackUser[]>;
}

export interface AvatarResolverOptions {
  fetch?: AvatarFetch;
  /** Small on-disk cache; the file name is a hash of the URL. */
  cacheDir?: string;
  /** Milliseconds since the epoch (test seam). */
  now?: () => number;
  log?: (message: string) => void;
  timeoutMs?: number;
}

/** True only for https://<allowed host>/... with no userinfo and no port. */
export function isAllowedAvatarUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  return u.protocol === "https:" && !u.username && !u.password && u.port === "" && AVATAR_HOSTS.has(u.hostname);
}

/** Drops avatarUrl from every user (the safe default when no resolver is wired: no remote URL reaches a webview). */
export function dropAvatars(users: SlackUser[]): SlackUser[] {
  return users.map(({ avatarUrl: _drop, ...rest }) => rest);
}

async function readCapped(res: Response): Promise<Uint8Array | undefined> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length <= MAX_BYTES ? buf : undefined;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) { await reader.cancel().catch(() => undefined); return undefined; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function createAvatarResolver(options: AvatarResolverOptions = {}): AvatarResolver {
  const doFetch: AvatarFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => undefined);
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const ok = new Map<string, string>();
  const failed = new Map<string, number>();
  const inflight = new Map<string, Promise<string | undefined>>();

  const cap = <V>(m: Map<string, V>, key: string, value: V) => {
    m.delete(key);
    m.set(key, value);
    while (m.size > MAX_ENTRIES) m.delete(m.keys().next().value as string);
  };
  const diskFile = (url: string) => (options.cacheDir ? path.join(options.cacheDir, `${createHash("sha256").update(url).digest("hex")}.txt`) : undefined);

  async function fromDisk(url: string): Promise<string | undefined> {
    const file = diskFile(url);
    if (!file) return undefined;
    try {
      const text = await readFile(file, "utf8");
      return text.length <= MAX_BYTES * 2 && DATA_URI.test(text) ? text : undefined;
    } catch { return undefined; }
  }
  async function toDisk(url: string, dataUri: string): Promise<void> {
    const file = diskFile(url);
    if (!file || !options.cacheDir) return;
    try {
      await mkdir(options.cacheDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, dataUri, "utf8");
      await rename(tmp, file);
    } catch { /* the disk cache is best-effort */ }
  }

  async function load(url: string): Promise<string | undefined> {
    const host = new URL(url).hostname;
    const cached = await fromDisk(url);
    if (cached) return cached;
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error", credentials: "omit", headers: { accept: "image/png,image/jpeg,image/gif,image/webp" } });
      if (res.status !== 200) { log(`avatar from ${host}: status ${res.status}`); return undefined; }
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!IMAGE_TYPES.has(type)) { log(`avatar from ${host}: unsupported content type`); return undefined; }
      const declared = res.headers.get("content-length");
      if (declared !== null && Number(declared) > MAX_BYTES) { log(`avatar from ${host}: too large`); return undefined; }
      const bytes = await readCapped(res);
      if (!bytes || bytes.length === 0) { log(`avatar from ${host}: empty or too large`); return undefined; }
      const dataUri = `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
      await toDisk(url, dataUri);
      return dataUri;
    } catch (e) {
      log(`avatar from ${host}: fetch failed (${e instanceof Error ? e.name : "error"})`);
      return undefined;
    }
  }

  /**
   * Slack's avatar for someone without a photo is a Gravatar URL whose `d=` names Slack's default image; Gravatar answers that
   * with a redirect, which is refused. So when a Gravatar URL fails, its `d=` image is fetched directly, if it is itself an
   * allowed (non-Gravatar) avatar URL.
   */
  function gravatarDefault(url: string): string | undefined {
    const u = new URL(url);
    if (u.hostname !== "secure.gravatar.com") return undefined;
    const d = u.searchParams.get("d");
    return d && isAllowedAvatarUrl(d) && new URL(d).hostname !== "secure.gravatar.com" ? d : undefined;
  }
  async function loadWithDefault(url: string): Promise<string | undefined> {
    const direct = await load(url);
    if (direct) return direct;
    const fallback = gravatarDefault(url);
    return fallback ? load(fallback) : undefined;
  }

  async function toDataUri(remoteUrl: string | undefined): Promise<string | undefined> {
    if (!remoteUrl || !isAllowedAvatarUrl(remoteUrl)) return undefined;
    const hit = ok.get(remoteUrl);
    if (hit) return hit;
    const until = failed.get(remoteUrl);
    if (until !== undefined) {
      if (now() < until) return undefined;
      failed.delete(remoteUrl);
    }
    let p = inflight.get(remoteUrl);
    if (!p) {
      p = loadWithDefault(remoteUrl).then(result => {
        if (result) cap(ok, remoteUrl, result);
        else cap(failed, remoteUrl, now() + FAILURE_MEMORY_MS);
        return result;
      }, () => undefined).finally(() => { inflight.delete(remoteUrl); });
      inflight.set(remoteUrl, p);
    }
    return p;
  }

  async function mapUsers(users: SlackUser[]): Promise<SlackUser[]> {
    return Promise.all(users.map(async user => {
      const { avatarUrl, ...rest } = user;
      try {
        const dataUri = await toDataUri(avatarUrl);
        return dataUri ? { ...rest, avatarUrl: dataUri } : rest;
      } catch { return rest; }
    }));
  }

  return { toDataUri, mapUsers };
}
