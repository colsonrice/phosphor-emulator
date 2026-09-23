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
//   - the survey found NOTHING BLOCKING: the archive was fetched and opened,
//     sits inside the app's ceilings, keeps its manifest where the installer
//     looks, does not write to the love table, and accepts the engine we ship
//   - it is not on the functional exclusion list (scripts/lib/excluded.mjs)
//   - the archive contains NO base-game ROM
//   - kind is a mod, never a rom-hack (a hack that is not a patch is a cartridge)
//   - it has fileUrl, sha256, fileSizeBytes, modId and modVersion
//
//
// NOT the survey's `verdict`. That folds the licence in ("installable" means
// clean AND permissively licensed), which is tier 1's bar. Tier 2 exists for
// the mods with no licence at all, so keying on it promoted nothing: a dry run
// on Sep 19 2026 refused 108 surveyed rows as `verdict=link-out` or `skip`,
// every one of them for having no licence. `blocking` is what the survey
// measured; `verdict` is what somebody once decided to do about it.
//
// Reads the standing report and, when present, the hand-fed one for repos the
// discovery sweep cannot see (survey-mods.mjs --repos ... --report ...).
//
// Usage: node scripts/promote-direct-source.mjs [--write]

import { readFile, writeFile } from "node:fs/promises";

import { fileURLToPath } from "node:url";

import { ENGINE_VERSIONS } from "./engine-family.mjs";
import { usesNetwork } from "./enrich-catalog.mjs";
import { EXCLUDED } from "./lib/excluded.mjs";
import { repoOf } from "./lib/repo-url.mjs";
import { satisfies } from "./lib/semver.mjs";

const CACHE = new URL("../survey/cache/", import.meta.url);

/// Whether a surveyed mod actually reaches for the network, read out of the
/// archive the survey hashed. The sandbox denies sockets unconditionally, so
/// such a mod installs and does nothing; it stays a link-out, which says the
/// true thing (it exists, and it is not for here). A declaration alone is not
/// enough to hold one back: Pokewalker declares `network` and never loads a
/// network module. Unreadable counts as "uses it", because the mistake to
/// avoid is the install button.
async function needsNetwork(s) {
  if (!(s.contents?.manifest?.permissions ?? []).includes("network")) return false;
  const name = `${s.repo.replace("/", "__")}__${s.release.fileName}`;
  try {
    return await usesNetwork(fileURLToPath(new URL(encodeURIComponent(name), CACHE)));
  } catch {
    return true;
  }
}

const REPORT = new URL("../survey/report.json", import.meta.url);
const HAND_FED = new URL("../survey/report-linkouts.json", import.meta.url);
const PROJECTS = new URL("../src/data/projects.json", import.meta.url);
const write = process.argv.includes("--write");


/// The standing report is gitignored, so a fresh checkout does not have one
/// until somebody runs the full sweep. Missing means nothing was surveyed,
/// which every row below already handles ("never surveyed", and no demotion,
/// because absence of evidence never takes a working listing down). It must
/// not mean a crash that blocks a hand-fed channel from being promoted at all.
const report = await readFile(REPORT, "utf8").then(JSON.parse, () => []);
const handFed = await readFile(HAND_FED, "utf8").then(JSON.parse, () => []);
/// A second hand-fed report, named on the command line. `report-linkouts.json`
/// is one fixed name, and a sweep of a channel the discovery terms cannot see
/// writes its own report so it cannot disturb the standing one; without this
/// that report could be applied but never promoted.
const extraPath = process.argv.includes("--report")
  ? process.argv[process.argv.indexOf("--report") + 1] : null;
const extra = extraPath
  ? await readFile(new URL(extraPath, import.meta.url), "utf8").then(JSON.parse, () => [])
  : [];

/// The surveyed archive behind a listing.
///
/// Keyed on the repository AND the mod inside it. A plain repository key holds
/// one result per repository, so a suite published from one repository — 23
/// Gen 3 mods at FAFF0x/gen3recomp — collapsed to whichever was surveyed last,
/// and every one of those listings would have been given that one mod's URL,
/// hash and version. Same shelf, same repository, 23 rows pointing at one
/// archive, and nothing to make it look wrong.
const key = (repo, modId) => `${String(repo).toLowerCase()}#${String(modId ?? "").toLowerCase()}`;
// The standing report wins a tie: it is the one the rest of the pipeline reads.
const surveyed = [...extra, ...handFed, ...report].filter((r) => r.repo);
const byRepo = new Map(surveyed.map((r) => [r.repo.toLowerCase(), r]));
const byMod = new Map(surveyed.filter((r) => r.contents?.modId)
  .map((r) => [key(r.repo, r.contents.modId), r]));

/// The row's own mod id where it has one, so a suite's listings do not all
/// resolve to the same archive; the repository alone where it does not, which
/// is every listing written before a repository could publish more than one.
const surveyFor = (p) => {
  const modId = p.modId ?? p.directSource?.modId;
  return (modId && byMod.get(key(repoOf(p.homepageUrl), modId))) || byRepo.get(repoOf(p.homepageUrl));
};
const excluded = new Map(Object.entries(EXCLUDED).map(([k, v]) => [k.toLowerCase(), v]));
const projects = JSON.parse(await readFile(PROJECTS, "utf8"));
const rows = Array.isArray(projects) ? projects : projects.projects;

const refused = [];
const demoted = [];
let promoted = 0;

/// A row that ALREADY carries an install and no longer qualifies loses it, but
/// only on a positive finding. "Never surveyed" and "could not be fetched" are
/// the absence of evidence, and taking a working listing down over a network
/// blip is the failure `unevaluated` exists to prevent.
///
/// And only when the finding is about THE BYTES THE ROW PINS. The survey reads
/// the latest release; a row may pin an older one that works. Battle Art Voxel
/// is the case: 1.9.6 is clean, 1.11.0 assigns `love.update`, which the
/// shipping sandbox refuses. Following that update breaks the mod for every
/// player who takes it, and dropping the listing loses them a working one, so
/// the row is HELD at the release that works and says so.
const held = [];
function refuse(p, reason, { finding = false, surveyed = null, always = false } = {}) {
  refused.push([p.id, reason]);
  if (!finding || !p.directSource) return;
  const sameBytes = surveyed?.release?.sha256 === p.directSource.sha256;
  if (always || sameBytes) {
    demoted.push([p.id, reason]);
    delete p.directSource;
  } else {
    held.push([p.id, `stays at ${p.directSource.version}; ${surveyed?.release?.tag ?? "the latest release"} ${reason}`]);
  }
}

for (const p of rows) {
  const s = surveyFor(p);
  if (!s) { refused.push([p.id, "never surveyed"]); continue; }
  if (s.verdict === "unevaluated") { refused.push([p.id, "archive could not be fetched, so nothing was judged"]); continue; }
  if ((s.blocking ?? []).length) {
    // Only a finding about the PINNED bytes takes an install away. "No .zip in
    // the latest release" is about a newer release: the asset this row pins is
    // still where it was, and still hashes.
    const reason = s.blocking[0].replace(/\s*\(.*$/s, "");
    refuse(p, reason, { finding: /love table/.test(reason), surveyed: s });
    continue;
  }
  if (excluded.has(s.repo.toLowerCase())) { refuse(p, "held out for what it does (excluded.mjs)", { finding: true, always: true }); continue; }
  if (p.kind === "rom-hack") { refused.push([p.id, "rom hack, never tier 2"]); continue; }

  const roms = s.contents?.romEntries ?? [];
  if (roms.length) { refused.push([p.id, `archive carries a ROM (${roms[0]})`]); continue; }

  if (await needsNetwork(s)) { refuse(p, "uses the network, which the sandbox denies", { finding: true, surveyed: s }); continue; }

  // The same gate the survey applies when it drafts a row, which this
  // promoter skipped: a mod whose manifest rules out the engine we ship is a
  // card that installs and never loads. Checked against the engine the row's
  // own channels name, because the two engines version independently.
  const range = s.contents?.manifest?.game_version;
  const shipped = (p.compatibility ?? []).map((channel) => ENGINE_VERSIONS[channel]).filter(Boolean);
  if (range && shipped.length && !shipped.some((version) => satisfies(version, range))) {
    refuse(p, `needs engine ${range}, and we ship ${shipped.join(" / ")}`, { finding: true, surveyed: s });
    continue;
  }

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

if (demoted.length) {
  console.log(`\nlost their install (${demoted.length}), each on a positive finding:`);
  for (const [id, reason] of demoted) console.log(`   ${id} — ${reason}`);
}

if (held.length) {
  console.log(`\nheld at a release that works (${held.length}):`);
  for (const [id, reason] of held) console.log(`   ${id} — ${reason}`);
}

if (write) {
  await writeFile(PROJECTS, JSON.stringify(projects, null, 2) + "\n");
  console.log("\nwrote src/data/projects.json");
} else {
  console.log("\n(dry run, pass --write to save)");
}
