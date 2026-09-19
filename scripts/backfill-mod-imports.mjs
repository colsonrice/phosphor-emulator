// Fills `requirements.imports` and `requirements.requires` into
// src/data/enrichment.json.
//
// Why this exists: a gen1recomp mod can declare the ROMs it is built from
// (`required_imports` / `optional_imports` in its manifest.json), and the
// engine refuses it, "required import missing: <name>", until the player
// supplies that exact file. StadiumBattleFX wants a Pokemon Stadium cartridge.
// The app collects the file in its Mods pane after install; the catalog said
// nothing before it, so the first a player heard was a mod that installed and
// would not load.
//
// `enrich-catalog.mjs` publishes the field on its next full pass, but that
// pass reaches the GitHub API for three hundred repositories and rewrites
// every popularity block on the way. This fills the one field, offline, using
// the SAME rule (importsFrom) so the two cannot drift.
//
// **Read from the published bytes, or not at all.** Every installable row
// pins a SHA-256, and `survey/cache/` holds the archive that was hashed. The
// manifest is read out of that file only after it hashes to what the row
// publishes, so an import line can never describe a different release than
// the one a player downloads. A row whose bytes are missing or stale is
// COUNTED and stops the write: absence here reads as "needs nothing from
// you", and publishing that for an archive nobody opened is the one mistake
// this field must not make.
//
// Usage: node scripts/backfill-mod-imports.mjs [--write]

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { importsFrom, requiresFrom } from "./enrich-catalog.mjs";
import { readManifest } from "./lib/archive.mjs";

const RELEASES = new URL("../src/data/releases.json", import.meta.url);
const PROJECTS = new URL("../src/data/projects.json", import.meta.url);
const ENRICHMENT = new URL("../src/data/enrichment.json", import.meta.url);
const CACHE = new URL("../survey/cache/", import.meta.url);

/// Where each script leaves the bytes it hashed. A tier 1 row is cached by
/// `verify-releases.mjs` under its catalog id; a tier 2 row was never anything
/// but a survey result, so it sits under the survey's `owner__repo__asset`.
export function cacheNameFor(row) {
  if (!row.directSource) return `published__${row.id}__${row.fileName}`;
  // Anchored, and the asset is the LAST path segment: a tag may itself hold a
  // slash, and a host that merely contains "github.com" is not GitHub.
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/.+\/([^/?#]+)(?:[?#].*)?$/
    .exec(row.directSource.fileUrl ?? "");
  if (!m) return null;
  try {
    return `${m[1]}__${m[2]}__${decodeURIComponent(m[3])}`;
  } catch {
    return null;   // a malformed escape is "unread", which stops the write
  }
}

/// The manifest inside the exact archive a row publishes, or a reason.
async function publishedManifest(row) {
  const name = cacheNameFor(row);
  if (!name) return { why: "no release asset URL to find its archive by" };
  const file = new URL(encodeURIComponent(name), CACHE);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    return { why: `${name} is not cached` };
  }
  const pinned = row.directSource?.sha256 ?? row.sha256;
  if (createHash("sha256").update(bytes).digest("hex") !== pinned) {
    return { why: `${name} is cached but is not the release the catalog pins` };
  }
  // Not `file.pathname`: that is still percent-encoded, and `unzip` would be
  // handed a name with %20 in it for any asset whose author used a space.
  const manifest = await readManifest(fileURLToPath(file));
  return manifest ? { manifest } : { why: `${name} has no readable manifest.json` };
}

async function main() {
  const write = process.argv.includes("--write");
  const releases = JSON.parse(await readFile(RELEASES, "utf8"));
  const projects = JSON.parse(await readFile(PROJECTS, "utf8"));
  const enrichment = JSON.parse(await readFile(ENRICHMENT, "utf8"));

  // Everything with an install button. A link-out has no archive to open.
  const rows = [...releases, ...projects.filter((project) => project.directSource)];

  const unread = [];
  const declaring = [];
  const depending = [];
  let changed = 0;

  for (const row of rows) {
    const { manifest, why } = await publishedManifest(row);
    if (!manifest) { unread.push(`${row.id}: ${why}`); continue; }

    const imports = importsFrom(manifest);
    const entry = (enrichment[row.id] ??= {});
    const requirements = (entry.requirements ??= {});
    const before = JSON.stringify(requirements.imports ?? null);

    // Cleared as well as set: a release that stopped needing the file must
    // stop saying it does, and stale data claiming a requirement is worse
    // than none.
    if (imports) requirements.imports = imports;
    else delete requirements.imports;

    // The same treatment for hard dependencies (`requirements.requires`),
    // which came in with the same defect: the engine blocks the mod and the
    // catalog said nothing. Same bytes, same rule as enrich-catalog.
    const requires = requiresFrom(manifest);
    const beforeRequires = JSON.stringify(requirements.requires ?? null);
    if (requires) requirements.requires = requires;
    else delete requirements.requires;

    if (before !== JSON.stringify(imports) || beforeRequires !== JSON.stringify(requires)) changed += 1;
    if (imports) declaring.push({ id: row.id, imports });
    if (requires) depending.push({ id: row.id, requires });
  }

  // An empty requirements object publishes an empty block; drop it.
  for (const [id, entry] of Object.entries(enrichment)) {
    if (entry.requirements && Object.keys(entry.requirements).length === 0) delete entry.requirements;
    if (Object.keys(entry).length === 0) delete enrichment[id];
  }

  console.log(`installable rows read from their published bytes: ${rows.length - unread.length} of ${rows.length}`);
  console.log(`  declare an import : ${declaring.length}`);
  console.log(`  rows changed      : ${changed}`);
  for (const { id, imports } of declaring) {
    const list = imports.map((i) => `${i.name}${i.required ? "" : " (optional)"}`).join(", ");
    console.log(`    ${id} — ${list}`);
  }

  console.log(`  need another mod  : ${depending.length}`);
  for (const { id, requires } of depending) console.log(`    ${id} — ${requires.join(", ")}`);

  if (unread.length) {
    console.error(`\n${unread.length} row(s) could not be read, so nothing was written:\n`);
    for (const line of unread) console.error(`  - ${line}`);
    console.error("\n  run: node scripts/verify-releases.mjs   (tier 1 rows)");
    console.error("       node scripts/survey-mods.mjs       (tier 2 rows)");
    process.exit(1);
  }

  if (write) {
    await writeFile(ENRICHMENT, JSON.stringify(enrichment, null, 2) + "\n");
    console.log("\nwrote src/data/enrichment.json");
  } else {
    console.log("\n(dry run, pass --write to save)");
  }
}

// Compared as URLs: the string form breaks on any path with a space in it,
// and breaks SILENTLY, exiting 0 having done nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
