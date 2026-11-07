import { defineConfig } from "vitest/config";

// Integration tests only: real providers, need env keys. Never run in CI or the Routine.
export default defineConfig({
  test: {
    include: ["**/*.int.test.ts"],
    exclude: ["**/node_modules/**", "**/out/**"],
  },
});
