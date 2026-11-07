// An empty git config file to point GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM at. the OS null device is not usable for that: on Windows it is
// `\\.\nul`, which git rejects as a config path.
import { closeSync, existsSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let cached: string | undefined;

/** Path of an empty file, created once per process (mode 0600) and recreated if something removed it. */
export function emptyGitConfig(): string {
  if (cached && existsSync(cached)) return cached;
  const dir = cached ? path.dirname(cached) : mkdtempSync(path.join(tmpdir(), "nexus-gitcfg-"));
  const file = path.join(dir, "empty.gitconfig");
  try { closeSync(openSync(file, "w", 0o600)); } catch {
    cached = undefined;
    const fresh = path.join(mkdtempSync(path.join(tmpdir(), "nexus-gitcfg-")), "empty.gitconfig");
    closeSync(openSync(fresh, "w", 0o600));
    return (cached = fresh);
  }
  return (cached = file);
}
