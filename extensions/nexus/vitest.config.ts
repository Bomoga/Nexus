import { defineConfig } from "vitest/config";

// Unit tests: no network, no keys. *.int.test.ts never runs here (see vitest.int.config.ts).
export default defineConfig({
  test: {
    css: true,   // otherwise every .css import (including ?raw) is an empty string and style tests run against nothing
    include: ["src/**/*.test.ts", "webviews/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/out/**", "**/*.int.test.ts"],
  },
});
