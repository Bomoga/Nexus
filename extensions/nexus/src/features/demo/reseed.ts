// "Nexus (dev): Re-seed demo repo" (PLAN L1-26). Dev-only: the seed script lives in the repo's demo/ folder,
// which exists in a source checkout but not in a packaged build.
import { resolve } from "node:path";

export interface RunResult {
  code: number | null;
  output: string;
}

export interface ReseedDeps {
  seedScript: string;
  /** Relative folders resolve against this (the extension host's working directory is unpredictable). */
  homeDir: string;
  /** ISO time used as --t0: the 36 hours of history end "now", so the globe's default window is full on demo day. */
  now(): string;
  exists(path: string): boolean;
  /** Runs the seed script with the extension host's Node (ELECTRON_RUN_AS_NODE is set by the caller's runner). */
  run(scriptPath: string, args: string[]): Promise<RunResult>;
}

export interface ReseedResult {
  ok: boolean;
  message: string;
}

export async function reseedDemoRepo(outDir: string, deps: ReseedDeps): Promise<ReseedResult> {
  const typed = outDir.trim();
  if (typed.length === 0) return { ok: false, message: "No folder given." };
  const dir = resolve(deps.homeDir, typed);
  if (!deps.exists(deps.seedScript)) {
    return { ok: false, message: `demo/seed.mjs not found at ${deps.seedScript}. This command only works from a source checkout.` };
  }
  const res = await deps.run(deps.seedScript, ["--out", dir, "--force", "--t0", deps.now()]);
  const last = res.output.trim().split("\n").filter(Boolean).at(-1) ?? "";
  if (res.code !== 0) return { ok: false, message: `Re-seed failed: ${last || `exit code ${res.code}`}` };
  return { ok: true, message: last || `Demo repo seeded in ${dir}.` };
}
