import { defineConfig } from "vitest/config";

// Unit tests: no network, no keys. *.int.test.ts never runs here (see vitest.int.config.ts).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "webviews/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/out/**", "**/*.int.test.ts"],
    // TODO(cp-0): drop once src/contracts/contracts.test.ts lands, so an empty suite fails CI.
    passWithNoTests: true,
  },
});
