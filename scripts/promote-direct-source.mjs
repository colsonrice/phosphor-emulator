// Attaches tier-2 "direct from source" install data to pending projects.
//
// CATALOG_POLICY tier 2: the creator has granted nothing, so Phosphor hosts
// nothing. The catalog carries their OWN release asset URL plus the SHA-256 of
// the bytes the survey actually downloaded and inspected, and the app verifies
// that hash before it unpacks anything. A swapped asset installs nothing.
//
// Reads survey/report.json (which writes nothing itself, by design) and adds a
// `directSource` block to matching rows in src/data/projects.json. Deliberately
// a separate, re-runnable script rather than a hand edit: the numbers below are
// the whole safety argument and they must come from a file somebody can re-derive.
//
// A row qualifies only when ALL of these hold:
//   - the survey's verdict is "installable" (archive within the app's ceilings)
//   - the archive contains NO base-game ROM
//   - kind is a mod, never a rom-hack (a hack that is not a patch is a cartridge)
//   - it has fileUrl, sha256, fileSizeBytes, modId and modVersion
//
// Usage: node scripts/promote-direct-source.mjs [--write]

import { readFile, writeFile } from "node:fs/promises";

const REPORT = new URL("../survey/report.json", import.meta.url);
const PROJECTS = new URL("../src/data/projects.json", import.meta.url);
const write = process.argv.includes("--write");

const repoOf = (url) =>
  (url ?? "").match(/^https:\/\/github\.com\/([^/#?]+\/[^/#?]+)/)?.[1]?.toLowerCase()
    .replace(/\.git$/, "") ?? null;

const report = JSON.parse(await readFile(REPORT, "utf8"));
const byRepo = new Map(report.filter((r) => r.repo).map((r) => [r.repo.toLowerCase(), r]));
const projects = JSON.parse(await readFile(PROJECTS, "utf8"));
const rows = Array.isArray(projects) ? projects : projects.projects;

const refused = [];
let promoted = 0;

for (const p of rows) {
  const s = byRepo.get(repoOf(p.homepageUrl));
  if (!s) { refused.push([p.id, "never surveyed"]); continue; }
  if (s.verdict !== "installable") { refused.push([p.id, `verdict=${s.verdict}`]); continue; }
  if (p.kind === "rom-hack") { refused.push([p.id, "rom hack, never tier 2"]); continue; }

  const roms = s.contents?.romEntries ?? [];
  if (roms.length) { refused.push([p.id, `archive carries a ROM (${roms[0]})`]); continue; }

  const r = s.release ?? {}, c = s.contents ?? {};
  const need = { fileUrl: r.fileUrl, sha256: r.sha256, fileSizeBytes: r.fileSizeBytes,
                 modId: c.modId, modVersion: c.modVersion };
  const gap = Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
  if (gap.length) { refused.push([p.id, `missing ${gap.join(", ")}`]); continue; }

  p.directSource = {
    // CATALOG_POLICY tier 2: their hosting, their file, our pinned hash.
    permission: "none-direct-source",
    fileUrl: r.fileUrl,
    sha256: r.sha256,
    fileSizeBytes: r.fileSizeBytes,
    version: c.modVersion,
    releasedAt: r.publishedAt,
    manifestPath: c.manifestPath ?? "manifest.json",
    modId: c.modId,
    gameVersion: c.manifest?.game_version ?? null,
    surveyedRelease: r.tag,
  };
  promoted += 1;
}

console.log(`promoted to tier 2: ${promoted}`);
console.log(`left as link-outs:  ${refused.length}`);
const why = {};
for (const [, reason] of refused) {
  const k = reason.replace(/\(.*\)/, "").trim();
  why[k] = (why[k] ?? 0) + 1;
}
for (const [k, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(n).padStart(4)}  ${k}`);
}

if (write) {
  await writeFile(PROJECTS, JSON.stringify(projects, null, 2) + "\n");
  console.log("\nwrote src/data/projects.json");
} else {
  console.log("\n(dry run, pass --write to save)");
}
