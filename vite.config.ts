import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, "index.html"),
        library: resolve(import.meta.dirname, "library.html"),
        logo: resolve(import.meta.dirname, "logo.html"),
      },
    },
  },
});
