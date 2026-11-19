// Re-checks every installable row against the bytes it points at.
//
// A catalog row is a claim about a file on somebody else's server: this size,
// this digest, a mod manifest at this path inside it. All three can stop being
// true without anything here changing, because an author can re-cut a release
// under the same URL. The app fails closed when that happens (the hash check
// refuses the install), so the failure lands on a player as a mod that will not
// install rather than as anything visible from this side.
//
// **Both tiers.** This read releases.json alone until Nov 19 2026, so the 300
// tier 2 installs in projects.json -- three fifths of the catalog -- were never
// re-checked after the survey first hashed them, and a dead one was found by
// hand or not at all. It also left their bytes out of `survey/cache/`, which
// is where backfill-mod-imports reads every installable row's manifest from.
//
// It also fills in `manifestPath`, which the manifest publishes so the app can
// assert that everything offered sits within the depth its installer will
// search. Rows added by hand never had it.
//
// Usage:
//   node scripts/verify-releases.mjs           check every row, report drift
//   node scripts/verify-releases.mjs --fill    also write manifestPath back

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { cacheNameFor } from "./backfill-mod-imports.mjs";
import { manifestIn, readManifest } from "./lib/archive.mjs";
import { nameForNewBytes, readPinned, sha256Of } from "./lib/cache.mjs";

const RELEASES = new URL("../src/data/releases.json", import.meta.url);
const PROJECTS = new URL("../src/data/projects.json", import.meta.url);
const CACHE = new URL("../survey/cache/", import.meta.url);

const FILL = process.argv.includes("--fill");

/// Mirrors RecompModLibrary. An archive that outgrew either ceiling installs
/// nowhere, and the catalog would be offering it anyway. 300_000 since the
/// app's e48729d49 (Sep 17 2026); see the survey's copy for why stricter here
/// is not safer.
const MAX_ENTRY_COUNT = 300_000;
const MAX_TOTAL_UNCOMPRESSED = 512 * 1024 * 1024;

/// What a row pins, read the same way out of either tier. Tier 1 keeps it on
/// the row; tier 2 under `directSource`.
function pinOf(row) {
  const from = row.directSource ?? row;
  return {
    id: row.id,
    tier: row.directSource ? 2 : 1,
    fileUrl: from.fileUrl,
    sha256: from.sha256,
    fileSizeBytes: from.fileSizeBytes,
    modId: from.modId,
    manifestPath: from.manifestPath,
    // Where each script leaves the bytes it hashed: the one function the
    // imports backfill reads them back with.
    cacheName: cacheNameFor(row),
    holder: from,
  };
}

async function main() {
  const releases = JSON.parse(await readFile(RELEASES, "utf8"));
  const projects = JSON.parse(await readFile(PROJECTS, "utf8"));
  await mkdir(CACHE, { recursive: true });

  const pins = [...releases, ...projects.filter((p) => p.directSource)].map(pinOf);
  const problems = [];
  let filled = 0;

  const dir = fileURLToPath(CACHE);
  for (const pin of pins) {
    if (!pin.cacheName) {
      problems.push(`${pin.id}: ${pin.fileUrl} is not a URL this repo knows how to cache`);
      continue;
    }
    // A cached copy counts only when it hashes to the pin. The name carries no
    // tag, so a row the survey moved to a newer release of the same filename
    // finds the OLD bytes here, and this used to report that as "the file no
    // longer hashes": the right alarm for the wrong reason, on every
    // refreshed row. Anything else is fetched.
    const cached = await readPinned(dir, pin.cacheName, pin.sha256);
    let bytes = cached?.bytes ?? null;
    let path = cached?.path ?? null;
    // A cached copy proves what the file WAS. Whether a player can still get
    // it is a question for the server, asked every run: this used to skip it
    // for anything cached, so on Nov 19 2026 a run reported every pin
    // matching while sixteen of them answered 404 (their repositories had
    // been deleted). A HEAD request costs no download.
    if (bytes) {
      const head = await fetch(pin.fileUrl, { method: "HEAD", redirect: "follow" })
        .catch((error) => ({ ok: false, status: error.message }));
      if (!head.ok) {
        problems.push(`${pin.id} (tier ${pin.tier}): ${pin.fileUrl} answered ${head.status}`);
        continue;
      }
    }
    if (!bytes) {
      const response = await fetch(pin.fileUrl, { redirect: "follow" }).catch((error) => ({ ok: false, status: error.message }));
      if (!response.ok) {
        problems.push(`${pin.id} (tier ${pin.tier}): ${pin.fileUrl} answered ${response.status}`);
        continue;
      }
      bytes = Buffer.from(await response.arrayBuffer());
      const digest = sha256Of(bytes);
      if (digest !== pin.sha256) {
        // Not cached: these bytes are not anything the catalog publishes.
        problems.push(`${pin.id} (tier ${pin.tier}): the file no longer hashes to what the catalog publishes\n`
          + `      published ${pin.sha256}\n      served    ${digest}`);
        continue;
      }
      // Never over a different file at that name, which a row pinned to
      // another release may still want: parked beside it instead.
      path = join(dir, await nameForNewBytes(dir, pin.cacheName, bytes));
      await writeFile(path, bytes);
    }

    if (bytes.length !== pin.fileSizeBytes) {
      problems.push(`${pin.id} (tier ${pin.tier}): ${bytes.length} bytes, catalog says ${pin.fileSizeBytes}`);
    }

    const manifest = await manifestIn(path);
    if (!manifest) {
      problems.push(`${pin.id} (tier ${pin.tier}): no manifest.json in the published archive`);
      continue;
    }
    if (pin.manifestPath && pin.manifestPath !== manifest.path) {
      problems.push(`${pin.id} (tier ${pin.tier}): manifest moved to ${manifest.path} (catalog says ${pin.manifestPath})`);
    }
    if (FILL && !pin.manifestPath) {
      pin.holder.manifestPath = manifest.path;
      filled += 1;
    }

    if (manifest.entryCount > MAX_ENTRY_COUNT) {
      problems.push(`${pin.id} (tier ${pin.tier}): ${manifest.entryCount} entries, over the installer's ${MAX_ENTRY_COUNT}`);
    }
    if (manifest.totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
      problems.push(`${pin.id} (tier ${pin.tier}): expands to ${(manifest.totalUncompressed / 1024 / 1024).toFixed(0)} MB, over the installer's ceiling`);
    }

    // Engine mods only: a ROM patch has no manifest and no id.
    if (pin.modId) {
      const declared = (await readManifest(path))?.id ?? null;
      if (declared !== pin.modId) {
        problems.push(`${pin.id} (tier ${pin.tier}): the catalog says modId ${pin.modId}, the archive declares ${declared ?? "nothing"} — install(expectingID:) would refuse the update`);
      }
    }
  }

  if (FILL && filled) {
    await writeFile(RELEASES, JSON.stringify(releases, null, 2) + "\n");
    await writeFile(PROJECTS, JSON.stringify(projects, null, 2) + "\n");
    console.log(`filled manifestPath on ${filled} row(s)`);
  }

  const tier2 = pins.filter((p) => p.tier === 2).length;
  if (problems.length) {
    console.error(`\n${problems.length} of ${pins.length} row(s) no longer match what they point at:\n`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`${pins.length} installable rows (${pins.length - tier2} tier 1, ${tier2} tier 2) still match their bytes.`);
}

await main();
