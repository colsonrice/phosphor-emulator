// Builds the manifest the Phosphor app fetches.
//
// The app reads ONE document from ONE host. This translates the two files a
// human edits — `releases.json` (things with a cleared, hashed file) and
// `projects.json` (things indexed while permission is pending) — into the
// shape `DiscoverCatalog` decodes.
//
// The output is committed. That is deliberate: the diff on a content change is
// then a reviewable record of exactly what players will be served, and CI runs
// `--check` so the checked-in file can never drift from its sources.
//
// Usage:
//   node scripts/build-manifest.mjs           write public/v1/manifest.json
//   node scripts/build-manifest.mjs --check   fail if the committed file is stale

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASES = new URL("../src/data/releases.json", import.meta.url);
const PROJECTS = new URL("../src/data/projects.json", import.meta.url);
const OUTPUT = new URL("../public/v1/manifest.json", import.meta.url);

/// The site and the app spell the second engine differently. Getting this
/// wrong produces entries that no installed engine claims, which reads in the
/// app as a mod that simply refuses to install with no explanation.
const ENGINE_IDS = { gen1recomp: "gen1recomp", gen2recomp: "gen2recomped" };

/// ROM hacks are not published yet.
///
/// The pieces the app needs are all there, but a hack needs the SHA-1 identity
/// of an exact base cartridge and a patch in a format ROMPatcher implements,
/// and almost nothing in the wild is distributed that way: the hacks surveyed
/// for this catalog ship either a complete ROM or nothing at all. Flip this to
/// true, add the patch metadata, and the section reappears — the app hides a
/// single-section tab bar on its own, so nothing there needs changing.
const PUBLISH_ROM_HACKS = false;

/// Listings with no downloadable file, shown with a link to the creator instead
/// of an install button. Off while the catalog is small: the creator's page for
/// a decomp mod is a source repository whose most obvious download button gives
/// you an assembly tree, so an indexed listing is a trap more often than a
/// discovery. The app supports them either way.
const PUBLISH_INDEXED = false;

const TOPICS = ["GAMEPLAY", "QOL", "UI", "ART", "CONTENT"];

const CATEGORIES = [
  { id: "GAMEPLAY", title: "Gameplay", subtitle: "New systems and rules", order: 0 },
  { id: "QOL", title: "Quality of Life", subtitle: "Small frictions, removed", order: 1 },
  { id: "UI", title: "Interface", subtitle: "Menus, HUD and readouts", order: 2 },
  { id: "ART", title: "Art & Effects", subtitle: "How the game looks", order: 3 },
  { id: "CONTENT", title: "New Content", subtitle: "Places, events and challenges", order: 4 },
  // Everything indexed lands here. Assigning invented topics to listings
  // nobody can install yet would be curation of things that are not on offer;
  // an entry moves to a real shelf the moment it has a topic and a file.
  { id: "PENDING", title: "Permission pending", subtitle: "Indexed while redistribution is cleared", order: 5 },
].filter((category) => category.id !== "PENDING" || PUBLISH_INDEXED);

const ALL_SECTIONS = [
  { id: "luaMods", title: "Mods", subtitle: "Reviewed community mods", kind: "luaMod", order: 0 },
  { id: "romHacks", title: "ROM Hacks", subtitle: "Patches applied to a game you already own", kind: "romPatch", order: 1 },
];

const SECTIONS = PUBLISH_ROM_HACKS
  ? ALL_SECTIONS
  : ALL_SECTIONS.filter((section) => section.kind !== "romPatch");

function fail(errors) {
  console.error("Refusing to build the manifest:\n");
  for (const error of errors) console.error(`  - ${error}`);
  console.error("");
  process.exit(1);
}

/// One release becomes one entry PER engine it supports.
///
/// A mod built for both engines is two different archives' worth of behaviour
/// under one name, and the app installs into one engine at a time, so it has
/// to be able to offer them separately. `id@engine` is the convention the
/// app's own catalog already used for exactly this.
function entriesForRelease(release, errors) {
  const label = release.id;

  if (release.containsRom !== false) {
    errors.push(`${label}: containsRom must be false to be published`);
    return [];
  }
  if (typeof release.topic !== "string" || !release.topic.trim()) {
    errors.push(`${label}: topic is required to build the app manifest`);
  }
  if (!Number.isInteger(release.fileSizeBytes) || release.fileSizeBytes <= 0) {
    errors.push(`${label}: fileSizeBytes must be a positive integer (the app uses it as a download cap)`);
  }
  if (release.topic && !TOPICS.includes(release.topic)) {
    errors.push(`${label}: topic must be one of ${TOPICS.join(", ")}`);
  }

  const channels = release.compatibility ?? [];
  const engines = channels.filter((channel) => ENGINE_IDS[channel]);

  // A cleared ROM hack needs patch metadata the site does not carry yet: the
  // patch format, and the SHA-1 identity of the exact base cartridge. Failing
  // here is the point — the first hack to clear permission should stop the
  // build with a message naming what to add, rather than publishing an entry
  // the app silently discards and leaving an empty tab nobody can explain.
  if (channels.includes("rom-hack")) {
    errors.push(
      `${label}: a downloadable ROM hack needs "patchFormat" (ips/ups/bps/xdelta/vcdiff) ` +
      `and "baseGame": { "sha1": "<sha1 of the exact base ROM>", "displayName": "..." }. ` +
      `Patches are offset-sensitive, so the app treats the base ROM hash as an identity, not a hint.`,
    );
    return [];
  }
  if (engines.length === 0) {
    errors.push(`${label}: no supported engine in compatibility (${channels.join(", ") || "none"})`);
    return [];
  }

  if (typeof release.modId !== "string" || !release.modId.trim()) {
    errors.push(`${label}: modId is required for an engine mod`);
    return [];
  }

  return engines.map((channel) => {
    const engineId = ENGINE_IDS[channel];
    return {
      id: engines.length > 1 ? `${release.id}@${engineId}` : release.id,
      kind: "luaMod",
      name: release.title,
      tagline: release.summary,
      author: { name: release.creator, url: release.homepageUrl },
      version: release.version,
      releasedAt: release.releaseDate,
      license: release.licenseText
        ? { spdx: release.license, text: release.licenseText }
        : { spdx: release.license },
      categories: [release.topic],
      target: release.target,
      screenshots: [],
      download: {
        url: release.fileUrl,
        sizeBytes: release.fileSizeBytes,
        sha256: release.sha256,
      },
      engine: { id: engineId },
      modID: release.modId,
    };
  });
}

/// An indexed listing: catalogued, linked, and deliberately not installable.
///
/// CATALOG_POLICY is explicit that a pending project is indexed and points at
/// the creator's own page, and that nothing is mirrored until redistribution
/// is verified. So this emits no download at all — not an empty one.
function entryForProject(project, errors) {
  const label = project.id;

  if (project.fileUrl) {
    errors.push(`${label}: a project pending review must not carry a fileUrl (move it to releases.json once permission is verified)`);
    return null;
  }
  if (!/^https:\/\//.test(project.homepageUrl ?? "")) {
    errors.push(`${label}: homepageUrl must use HTTPS — it is the only thing an indexed listing can offer`);
    return null;
  }

  return {
    id: project.id,
    kind: project.kind === "rom-hack" ? "romPatch" : "luaMod",
    name: project.title,
    tagline: project.summary,
    author: { name: project.creator, url: project.homepageUrl },
    categories: ["PENDING"],
    target: project.target,
    screenshots: [],
    project: { url: project.homepageUrl, status: project.reviewStatus },
  };
}

export async function buildManifest() {
  const releases = JSON.parse(await readFile(RELEASES, "utf8"));
  const projects = JSON.parse(await readFile(PROJECTS, "utf8"));
  const errors = [];

  const publishedKinds = new Set(SECTIONS.map((section) => section.kind));

  const entries = [
    ...releases.flatMap((release) => entriesForRelease(release, errors)),
    ...(PUBLISH_INDEXED
      ? projects.map((project) => entryForProject(project, errors)).filter(Boolean)
      : []),
  // An entry whose kind has no section would be fetched and then never shown.
  ].filter((entry) => publishedKinds.has(entry.kind));

  const ids = entries.map((entry) => entry.id);
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) {
    errors.push(`${id}: duplicate entry id in the built manifest`);
  }
  if (errors.length) fail(errors);

  // NOT a wall-clock timestamp. The output is committed and CI diffs it, so a
  // build-time clock would make every build dirty and --check meaningless.
  // The newest release date is stable, reproducible, and the thing a reader
  // actually wants to know about the catalog's age.
  const generated = releases
    .map((release) => release.releaseDate)
    .filter(Boolean)
    .sort()
    .at(-1) ?? "";

  return { schemaVersion: 1, generated, sections: SECTIONS, categories: CATEGORIES, entries };
}

const serialise = (manifest) => JSON.stringify(manifest, null, 2) + "\n";

async function main() {
  const manifest = await buildManifest();
  const body = serialise(manifest);
  const check = process.argv.includes("--check");

  if (check) {
    let existing = null;
    try {
      existing = await readFile(OUTPUT, "utf8");
    } catch {
      fail(["public/v1/manifest.json is missing — run: node scripts/build-manifest.mjs"]);
    }
    if (existing !== body) {
      fail(["public/v1/manifest.json is stale — run: node scripts/build-manifest.mjs"]);
    }
    console.log(`manifest is up to date (${manifest.entries.length} entries)`);
    return;
  }

  await mkdir(dirname(fileURLToPath(OUTPUT)), { recursive: true });
  await writeFile(OUTPUT, body);

  const installable = manifest.entries.filter((entry) => entry.download).length;
  const byKind = (kind) => manifest.entries.filter((entry) => entry.kind === kind).length;
  console.log(
    `wrote public/v1/manifest.json — ${manifest.entries.length} entries ` +
    `(${installable} installable, ${manifest.entries.length - installable} indexed); ` +
    `mods ${byKind("luaMod")}, rom hacks ${byKind("romPatch")}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
