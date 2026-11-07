import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npx vite` serves webviews/<name>/index.html at http://localhost:5173/<name>/?fake=1 (fake bridge).
// scripts/build-webviews.mjs overrides root and outDir to build each entry into media/<name>/.
export default defineConfig({
  root: fileURLToPath(new URL("./webviews", import.meta.url)),
  plugins: [react()],
  server: { port: 5173 },
  build: {
    outDir: fileURLToPath(new URL("./media", import.meta.url)),
    emptyOutDir: false,
    target: "es2022",
    sourcemap: false,
  },
});
