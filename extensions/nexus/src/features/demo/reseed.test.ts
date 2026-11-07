import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { reseedDemoRepo, type ReseedDeps } from "./reseed";

const deps = (over: Partial<ReseedDeps> = {}): ReseedDeps => ({
  seedScript: "/repo/demo/seed.mjs",
  homeDir: "/home/u",
  now: () => "2026-11-08T12:00:00Z",
  exists: () => true,
  run: vi.fn(async () => ({ code: 0, output: "seeded /tmp/d: 38 commits\n" })),
  ...over,
});

describe("reseedDemoRepo", () => {
  it("runs the seed script with --out <dir> --force and reports its last line", async () => {
    const d = deps();
    const res = await reseedDemoRepo("  /tmp/d ", d);
    expect(d.run).toHaveBeenCalledWith("/repo/demo/seed.mjs", ["--out", resolve("/tmp/d"), "--force", "--t0", "2026-11-08T12:00:00Z"]);
    expect(res).toEqual({ ok: true, message: "seeded /tmp/d: 38 commits" });
  });

  it("explains itself when there is no seed script (packaged build)", async () => {
    const d = deps({ exists: () => false });
    const res = await reseedDemoRepo("/tmp/d", d);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/source checkout/);
    expect(d.run).not.toHaveBeenCalled();
  });

  it("surfaces the failure line from the script", async () => {
    const res = await reseedDemoRepo("/tmp/d", deps({ run: async () => ({ code: 2, output: "demo/seed: /tmp/d was not created by this script\n" }) }));
    expect(res).toEqual({ ok: false, message: "Re-seed failed: demo/seed: /tmp/d was not created by this script" });
  });

  it("resolves a relative folder against the home directory", async () => {
    const d = deps();
    await reseedDemoRepo("demos/cart", d);
    expect(d.run).toHaveBeenCalledWith(expect.anything(), ["--out", resolve("/home/u", "demos/cart"), "--force", "--t0", expect.any(String)]);
  });

  it("rejects an empty folder without running anything", async () => {
    const d = deps();
    expect((await reseedDemoRepo("   ", d)).ok).toBe(false);
    expect(d.run).not.toHaveBeenCalled();
  });
});
