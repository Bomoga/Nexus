import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Placeholder: lane 3 (L3-01) fills in the per-webview entries. Output goes to media/.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "media",
    emptyOutDir: false,
  },
});
