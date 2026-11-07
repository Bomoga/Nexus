// Path confinement and file access for the gate. Paths are untrusted model output; every check works on real paths.
import { constants as fsc } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export const MAX_READ_BYTES = 200_000;
export const MAX_LIST_ENTRIES = 2000;

/** True when `target` is `root` or inside it. Both must already be real, absolute paths. */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The real path of `p` even if it does not exist yet: the deepest existing ancestor is realpath'd (following symlinks) and the rest appended. */
export async function realish(p: string): Promise<string> {
  const parts: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try { return path.join(await realpath(cur), ...parts); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" && (err as NodeJS.ErrnoException).code !== "ENOTDIR") throw err;
      const parent = path.dirname(cur);
      if (parent === cur) throw err;
      parts.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

export interface Resolved { root: string; target: string; inside: boolean }

/** Resolves `p` (relative to the worktree) to a real path and says whether it stays inside the real worktree. */
export async function resolveIn(worktree: string, p: string): Promise<Resolved> {
  if (p.includes("\0")) throw new Error("path contains a NUL byte");
  const root = await realpath(worktree);
  const target = await realish(path.resolve(root, p));
  return { root, target, inside: isInside(root, target) };
}

export async function readCapped(file: string): Promise<{ content: string; truncated: boolean }> {
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(MAX_READ_BYTES + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const truncated = bytesRead > MAX_READ_BYTES;
    return { content: buf.subarray(0, Math.min(bytesRead, MAX_READ_BYTES)).toString("utf8"), truncated };
  } finally { await handle.close(); }
}

/** Lists entries under `dir` to `depth` levels, relative to `root`, directories with a trailing "/". Symlinks are listed, never followed; .git is skipped. */
export async function listTree(root: string, dir: string, depth: number): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, left: number): Promise<void> => {
    const entries = (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_LIST_ENTRIES) return;
      if (e.name === ".git") continue;
      const full = path.join(d, e.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      out.push(e.isDirectory() ? `${rel}/` : rel);
      if (e.isDirectory() && left > 1) await walk(full, left - 1);
    }
  };
  await walk(dir, depth);
  return out;
}

/** Writes a file at an already-resolved real path, creating parent directories. The final component is never a symlink. */
export async function writeFileAt(target: string, content: string): Promise<number> {
  await mkdir(path.dirname(target), { recursive: true });
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error("refusing to write through a symlink");
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  const handle = await open(target, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC | fsc.O_NOFOLLOW, 0o644);
  try {
    const data = Buffer.from(content, "utf8");
    await handle.write(data, 0, data.length, 0);
    return data.length;
  } finally { await handle.close(); }
}
