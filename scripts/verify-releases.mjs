// Re-checks every published row against the bytes it points at.
//
// A catalog row is a claim about a file on somebody else's server: this size,
// this digest, a mod manifest at this path inside it. All three can stop being
// true without anything here changing, because an author can re-cut a release
// under the same URL. The app fails closed when that happens (the hash check
// refuses the install), so the failure lands on a player as a mod that will not
// install rather than as anything visible from this side.
//
// It also fills in `manifestPath`, which the manifest publishes so the app can
// assert that everything offered sits within the depth its installer will
// search. Rows added by hand never had it.
//
// Usage:
//   node scripts/verify-releases.mjs           check every row, report drift
//   node scripts/verify-releases.mjs --fill    also write manifestPath back

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { manifestIn, readManifest } from "./lib/archive.mjs";

const RELEASES = new URL("../src/data/releases.json", import.meta.url);
const CACHE = new URL("../survey/cache/", import.meta.url);

const FILL = process.argv.includes("--fill");

/// Mirrors RecompModLibrary. An archive that outgrew either ceiling installs
/// nowhere, and the catalog would be offering it anyway.
const MAX_ENTRY_COUNT = 50_000;
const MAX_TOTAL_UNCOMPRESSED = 512 * 1024 * 1024;

async function main() {
  const releases = JSON.parse(await readFile(RELEASES, "utf8"));
  await mkdir(CACHE, { recursive: true });

  const problems = [];
  let filled = 0;

  for (const release of releases) {
    const file = new URL(`published__${release.id}__${release.fileName}`, CACHE);
    let bytes;
    try {
      bytes = await readFile(file);
    } catch {
      const response = await fetch(release.fileUrl, { redirect: "follow" });
      if (!response.ok) {
        problems.push(`${release.id}: ${release.fileUrl} answered ${response.status}`);
        continue;
      }
      bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(file, bytes);
    }

    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== release.sha256) {
      problems.push(`${release.id}: the file no longer hashes to what the catalog publishes\n`
        + `      published ${release.sha256}\n      served    ${digest}`);
      continue;
    }
    if (bytes.length !== release.fileSizeBytes) {
      problems.push(`${release.id}: ${bytes.length} bytes, catalog says ${release.fileSizeBytes}`);
    }

    const manifest = await manifestIn(file.pathname);
    if (!manifest) {
      problems.push(`${release.id}: no manifest.json in the published archive`);
      continue;
    }
    if (release.manifestPath && release.manifestPath !== manifest.path) {
      problems.push(`${release.id}: manifest moved to ${manifest.path} (catalog says ${release.manifestPath})`);
    }
    if (FILL && !release.manifestPath) {
      release.manifestPath = manifest.path;
      filled += 1;
    }

    if (manifest.entryCount > MAX_ENTRY_COUNT) {
      problems.push(`${release.id}: ${manifest.entryCount} entries, over the installer's ${MAX_ENTRY_COUNT}`);
    }
    if (manifest.totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
      problems.push(`${release.id}: expands to ${(manifest.totalUncompressed / 1024 / 1024).toFixed(0)} MB, over the installer's ceiling`);
    }

    // Engine mods only: a ROM patch has no manifest and no id.
    if (release.modId) {
      const declared = (await readManifest(file.pathname))?.id ?? null;
      if (declared !== release.modId) {
        problems.push(`${release.id}: the catalog says modId ${release.modId}, the archive declares ${declared ?? "nothing"} — install(expectingID:) would refuse the update`);
      }
    }
  }

  if (FILL && filled) {
    await writeFile(RELEASES, JSON.stringify(releases, null, 2) + "\n");
    console.log(`filled manifestPath on ${filled} row(s)`);
  }

  if (problems.length) {
    console.error(`\n${problems.length} row(s) no longer match what they point at:\n`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`${releases.length} published rows still match their bytes.`);
}

await main();
