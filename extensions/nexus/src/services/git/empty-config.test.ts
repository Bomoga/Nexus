import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyGitConfig } from "./empty-config";
import { GitCli } from "./git-cli";

describe("emptyGitConfig", () => {
  it("is an existing empty file, reused across calls", () => {
    const p = emptyGitConfig();
    expect(statSync(p).size).toBe(0);
    if (process.platform !== "win32") expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(emptyGitConfig()).toBe(p);
  });

  it("is recreated in a fresh directory when deleted", () => {
    const p = emptyGitConfig();
    rmSync(p);
    const q = emptyGitConfig();
    expect(statSync(q).size).toBe(0);
    expect(path.dirname(q)).not.toBe(path.dirname(p));
  });

  it("makes GitCli with isolatedConfig ignore the user's global config", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "nexus-home-"));
    const repo = mkdtempSync(path.join(tmpdir(), "nexus-repo-"));
    writeFileSync(path.join(home, ".gitconfig"), "[core]\n\thooksPath = /nonexistent-hooks\n[alias]\n\tzzprobe = status\n");
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      execFileSync("git", ["init", "-q", "-b", "main", repo], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
      const git = new GitCli(repo, { isolatedConfig: true });
      // Asking for a key that is not set exits 1 with nothing on stderr; an unreadable config would warn or exit 128.
      const probe = (cli: GitCli, key: string) => (cli as unknown as { run(a: string[], o: { allowExit: number[] }): Promise<{ stdout: string; stderr: string; code: number }> }).run(["config", "--get", key], { allowExit: [1] });
      expect(await probe(new GitCli(repo), "alias.zzprobe")).toMatchObject({ code: 0, stdout: "status\n" });
      expect(await probe(git, "alias.zzprobe")).toMatchObject({ code: 1, stdout: "", stderr: "" });
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(home, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true });
    }
  });
});
