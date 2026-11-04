// Builds the ACP web view the agents CLI serves for a Codex pane (src/acp-host.ts):
//   npm run build:web   ->  dist-web/acp-view/{index.html, assets/*}
// Asset names carry content hashes; the host serves them as immutable.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: "/",
  plugins: [react()],
  build: {
    outDir: resolve(here, "../../dist-web/acp-view"),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
});
