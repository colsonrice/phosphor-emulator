import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

/// The catalog totals the marketing page quotes, counted the SAME WAY the
/// library page counts them (src/App.tsx): releases whose category is
/// "rom-hack" are patches, every other release and every discovery project is
/// a mod.
///
/// Done here rather than in the page because src/data/{releases,projects}.json
/// are 339 kB together and the home bundle is 12 kB — importing them to count
/// two numbers would have cost thirty times the page. Done at all because the
/// numbers were literals and had drifted to "30 RECOMP MODS" against a real
/// 289, understating the library tenfold on the page that sells it.
function catalogCounts() {
  const read = (file: string) =>
    JSON.parse(readFileSync(resolve(import.meta.dirname, file), "utf8")) as
      { category?: string; kind?: string }[];
  const kinds = [
    ...read("src/data/releases.json")
      .map((release) => (release.category === "rom-hack" ? "rom-hack" : "mod")),
    ...read("src/data/projects.json").map((project) => project.kind),
  ];
  const romHacks = kinds.filter((kind) => kind === "rom-hack").length;
  const mods = kinds.filter((kind) => kind === "mod").length;
  return { romHacks, mods, projects: romHacks + mods };
}

const counts = catalogCounts();

export default defineConfig({
  base: "./",
  plugins: [react()],
  define: {
    __ROM_HACK_COUNT__: counts.romHacks,
    __MOD_COUNT__: counts.mods,
    __PROJECT_COUNT__: counts.projects,
  },
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
