// An empty git config file to point GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM at. The OS null device is not usable for that: on Windows it is
// `\\.\nul`, which git rejects as a config path.
import { closeSync, existsSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let cached: string | undefined;
let cleanupRegistered = false;
const dirs: string[] = [];

/** Path of an empty file, created once per process (mode 0600) in a fresh private temp dir, and recreated if something removed it. */
export function emptyGitConfig(): string {
  if (cached && existsSync(cached)) return cached;
  // Never reopen the old directory: on a shared /tmp someone else could have recreated it.
  const dir = mkdtempSync(path.join(tmpdir(), "nexus-gitcfg-"));
  dirs.push(dir);
  const file = path.join(dir, "empty.gitconfig");
  closeSync(openSync(file, "w", 0o600));
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once("exit", () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
  }
  return (cached = file);
}
