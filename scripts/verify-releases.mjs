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
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const RELEASES = new URL("../src/data/releases.json", import.meta.url);
const CACHE = new URL("../survey/cache/", import.meta.url);

const FILL = process.argv.includes("--fill");

/// The shallowest manifest.json in the archive, and how deep it sits.
///
/// Separators are normalised first: a Windows-made archive stores "MOD\x5c..."
/// where the spec requires "/", real mods ship that way, and counting depth
/// without normalising silently misreads every one of them.
async function manifestIn(path) {
  const { stdout } = await run("unzip", ["-l", path], { maxBuffer: 64 * 1024 * 1024 });
  const names = stdout.split("\n")
    .map((line) => line.match(/^\s*\d+\s+\S+\s+\S+\s+(.+)$/))
    .filter(Boolean)
    .map((m) => m[1].replace(/\\/g, "/"));

  const manifests = names
    .filter((name) => name.split("/").filter(Boolean).at(-1) === "manifest.json")
    .sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length);

  if (!manifests.length) return null;
  return { path: manifests[0], depth: manifests[0].split("/").filter(Boolean).length - 1 };
}

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
