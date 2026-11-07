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

  it("is recreated when deleted", () => {
    const p = emptyGitConfig();
    rmSync(p);
    const q = emptyGitConfig();
    expect(statSync(q).size).toBe(0);
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
      const probe = (cli: GitCli) => (cli as unknown as { run(a: string[]): Promise<{ stdout: string }> }).run(["config", "--get-regexp", "^alias\\."]).then(r => r.stdout, () => "");
      expect(await probe(new GitCli(repo))).toContain("zzprobe");
      expect(await probe(git)).not.toContain("zzprobe");
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(home, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true });
    }
  });
});
