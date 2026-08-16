import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    emptyOutDir: true,
    outDir: "desk-dist",
    rollupOptions: {
      input: resolve(import.meta.dirname, "desk.html"),
    },
  },
});
