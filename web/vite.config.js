import { defineConfig } from "vite";

// Relative base: the built folder works from any path or static host.
export default defineConfig({
  base: "./",
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
