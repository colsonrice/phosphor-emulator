// Backfills `requirements.games` into src/data/enrichment.json.
//
// Why this exists: `enrich-catalog.mjs` knew about three cartridges while the
// engine grew to six, so it stopped publishing a games line for Gen 1-only
// mods — which is every mod that is not marked `gen2compat`, i.e. 211 of 219.
// A player installing one for Crystal, Gold or Silver was told nothing, and
// the engine then skipped it at boot as `wrong_generation`.
//
// Re-running the real enrichment means re-downloading every archive. This
// reads the manifests the survey already captured and fills the one field,
// using the SAME rule (cartridgesFor) so the two cannot drift.
//
// Usage: node scripts/backfill-mod-games.mjs [--write]

import { readFile, writeFile } from "node:fs/promises";
import { cartridgesFor, CARTRIDGES, GEN3_CARTRIDGES, CACHE, cacheNameFor } from "./enrich-catalog.mjs";
import { readManifest } from "./lib/archive.mjs";

const write = process.argv.includes("--write");
const repoOf = (url) =>
  (url ?? "").match(/^https:\/\/github\.com\/([^/#?]+\/[^/#?]+)/)?.[1]?.toLowerCase()
    .replace(/\.git$/, "") ?? null;

const report = JSON.parse(await readFile(new URL("../survey/report.json", import.meta.url), "utf8"));
const enrichment = JSON.parse(await readFile(new URL("../src/data/enrichment.json", import.meta.url), "utf8"));
const releases = JSON.parse(await readFile(new URL("../src/data/releases.json", import.meta.url), "utf8"));
const projects = JSON.parse(await readFile(new URL("../src/data/projects.json", import.meta.url), "utf8"));

const byRepo = new Map(report.filter((r) => r.repo).map((r) => [r.repo.toLowerCase(), r]));
const rows = [...(Array.isArray(releases) ? releases : releases.releases),
              ...(Array.isArray(projects) ? projects : projects.projects)];

let filled = 0, already = 0, unknown = 0, translated = 0;
const counts = {};

for (const row of rows) {
  const survey = byRepo.get(repoOf(row.homepageUrl));
  let manifest = survey?.contents?.manifest;
  // A release the survey never captured still has its archive in the
  // verify-releases cache, and its manifest is the same bytes enrich reads.
  // Without this, a row enriched under a shorter cartridge list keeps a
  // silence that meant "all six" and now reads as "all eight".
  if ((!manifest || typeof manifest !== "object") && row.fileName) {
    manifest = await readManifest(new URL(cacheNameFor(row), CACHE).pathname).catch(() => null);
  }
  // A tier-2 row's archive is cached under the survey's own name for it
  // (promote-direct-source.mjs `needsNetwork` spells it the same way).
  if ((!manifest || typeof manifest !== "object") && survey?.repo && survey?.release?.fileName) {
    const name = `${survey.repo.replace("/", "__")}__${survey.release.fileName}`;
    manifest = await readManifest(new URL(encodeURIComponent(name), CACHE).pathname).catch(() => null);
  }
  if (!manifest || typeof manifest !== "object") {
    unknown += 1;
    // An installable row nothing here can read keeps whatever enrich wrote,
    // and enrich wrote it against the six-cartridge list: a SILENT games line
    // there meant "all six". Left silent it would now mean "all eight", which
    // is a FireRed claim nobody read. Say the six, which is what its silence
    // said; a mod that really declares "all" comes right on the next enrich.
    const installable = Boolean(row.fileUrl || row.fileName || row.directSource?.fileUrl);
    const req = enrichment[row.id]?.requirements;
    if (installable && !(req?.games)) {
      const entry = (enrichment[row.id] ??= {});
      (entry.requirements ??= {}).games = CARTRIDGES.filter((c) => !GEN3_CARTRIDGES.includes(c));
      translated += 1;
    }
    continue;
  }

  const covers = cartridgesFor(manifest);
  const entry = (enrichment[row.id] ??= {});
  const req = (entry.requirements ??= {});

  if (covers.length === CARTRIDGES.length) {
    // Covers everything: a games line here would be noise, and stale data
    // claiming a restriction that no longer exists is worse than none. The
    // length is the vocabulary's, not a number: "six" was written in here
    // while the engine ran six, and when it reached eight every gen2compat
    // mod would have kept passing as "everything", FireRed included.
    if (req.games) { delete req.games; filled += 1; }
    counts[`all ${CARTRIDGES.length}`] = (counts[`all ${CARTRIDGES.length}`] ?? 0) + 1;
    continue;
  }
  const key = covers.join("/");
  counts[key] = (counts[key] ?? 0) + 1;
  if (JSON.stringify(req.games) === JSON.stringify(covers)) { already += 1; continue; }
  req.games = covers;
  filled += 1;
}

// An empty requirements object publishes an empty block; drop it.
for (const [id, entry] of Object.entries(enrichment)) {
  if (entry.requirements && Object.keys(entry.requirements).length === 0) delete entry.requirements;
  if (Object.keys(entry).length === 0) delete enrichment[id];
}

console.log(`rows with a readable manifest: ${rows.length - unknown} of ${rows.length}`);
console.log(`  games line written : ${filled}`);
console.log(`  already correct    : ${already}`);
console.log(`  no manifest        : ${unknown}`);
console.log(`  silence -> six     : ${translated}   (installable, unreadable here, was silent under the six-list)`);
console.log("\ncoverage:");
for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${k}`);
}

if (write) {
  await writeFile(new URL("../src/data/enrichment.json", import.meta.url),
                  JSON.stringify(enrichment, null, 2) + "\n");
  console.log("\nwrote src/data/enrichment.json");
} else {
  console.log("\n(dry run, pass --write to save)");
}
