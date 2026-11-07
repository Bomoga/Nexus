// Builds every webviews/<name>/index.html entry into media/<name>/ with Vite (lane 3 owns this script).
// Stub: exits 0 when there are no entries yet.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEBVIEWS = join(ROOT, "webviews");

const entries = existsSync(WEBVIEWS)
  ? readdirSync(WEBVIEWS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "shared" && existsSync(join(WEBVIEWS, d.name, "index.html")))
      .map((d) => d.name)
  : [];

if (entries.length === 0) {
  console.log("build-webviews: no webview entries yet, nothing to build");
  process.exit(0);
}

const { build } = await import("vite");
for (const name of entries) {
  await build({
    configFile: join(ROOT, "vite.config.ts"),
    root: join(WEBVIEWS, name),
    base: "./",
    build: { outDir: join(ROOT, "media", name), emptyOutDir: true },
  });
}
console.log(`build-webviews: built ${entries.join(", ")}`);
