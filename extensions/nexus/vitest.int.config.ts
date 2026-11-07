import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Fill process.env from extensions/nexus/.env (never overriding what the shell already set). Empty values are ignored,
// so a blank line leaves that provider's test skipped.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

// Integration tests only: real providers, need env keys. Never run in CI or the Routine.
export default defineConfig({
  test: {
    include: ["**/*.int.test.ts"],
    exclude: ["**/node_modules/**", "**/out/**"],
  },
});
