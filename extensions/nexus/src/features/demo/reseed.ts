// "Nexus (dev): Re-seed demo repo" (PLAN L1-26). Dev-only: the seed script lives in the repo's demo/ folder,
// which exists in a source checkout but not in a packaged build.

export interface RunResult {
  code: number | null;
  output: string;
}

export interface ReseedDeps {
  seedScript: string;
  exists(path: string): boolean;
  /** Runs the seed script with the extension host's Node (ELECTRON_RUN_AS_NODE is set by the caller's runner). */
  run(scriptPath: string, args: string[]): Promise<RunResult>;
}

export interface ReseedResult {
  ok: boolean;
  message: string;
}

export async function reseedDemoRepo(outDir: string, deps: ReseedDeps): Promise<ReseedResult> {
  const dir = outDir.trim();
  if (dir.length === 0) return { ok: false, message: "No folder given." };
  if (!deps.exists(deps.seedScript)) {
    return { ok: false, message: `demo/seed.mjs not found at ${deps.seedScript}. This command only works from a source checkout.` };
  }
  const res = await deps.run(deps.seedScript, ["--out", dir, "--force"]);
  const last = res.output.trim().split("\n").filter(Boolean).at(-1) ?? "";
  if (res.code !== 0) return { ok: false, message: `Re-seed failed: ${last || `exit code ${res.code}`}` };
  return { ok: true, message: last || `Demo repo seeded in ${dir}.` };
}
