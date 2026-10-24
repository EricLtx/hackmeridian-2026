import { resolve } from "node:path";
import { defineConfig } from "vite";

// Relative base: the built folder works from any path or static host.
// Three pages: the interface (index.html), the history page (history.html),
// which reads the indexer's export, public/history.json, and the guided tour
// (tour.html).
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        history: resolve(import.meta.dirname, "history.html"),
        tour: resolve(import.meta.dirname, "tour.html"),
      },
    },
  },
});
