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
import { engineFacet, ENGINE_VERSIONS, GEN1 } from "./engine-family.mjs";
import { CARTRIDGES } from "./enrich-catalog.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { categorize } from "./lib/categorize.mjs";
import { ONLINE_UNAVAILABLE } from "./lib/excluded.mjs";
import { satisfies } from "./lib/semver.mjs";

const RELEASES = new URL("../src/data/releases.json", import.meta.url);
const PROJECTS = new URL("../src/data/projects.json", import.meta.url);
const ENRICHMENT = new URL("../src/data/enrichment.json", import.meta.url);
const OUTPUT = new URL("../public/v1/manifest.json", import.meta.url);

/// The site and the app spell an engine differently. Getting this wrong
/// produces entries that no installed engine claims, which reads in the app as
/// a mod that simply refuses to install with no explanation.
const ENGINE_IDS = { gen1recomp: "gen1recomp" };

/// Engines Phosphor used to ship and does not any more.
///
/// A listing for one of these is not a listing. No installed engine can claim
/// it, so INSTALL fails on the player's phone with nothing on screen to
/// explain it, and a link-out is worse still: it sends somebody to a mod that
/// cannot run here at all. That is a dead end dressed as a discovery.
///
/// This is the failure that actually happened. The catalog generated on
/// 17 Aug 2026 carried 14 installable rows and 4 link-outs for `gen2recomp`;
/// the engine came out of the app on 20 Aug because its licence is dual and
/// the Part B files forbid redistribution and modified builds, which is what
/// Phosphor was doing. The site had no way to know, so the rows stayed live.
/// Keyed separately from "no supported engine" so the message says which of
/// the two mistakes this is.
///
/// **Do not clear an error from this table by putting the id back into
/// ENGINE_IDS.** The engine has to exist in the app first; the app repo is the
/// authority and this table follows it. Gold and Silver run on gen1recomp now.
const RETIRED_ENGINES = {
  gen2recomp:
    "Gen2Recomped, removed from Phosphor in 3.8 over its licence. Gold and Silver run on gen1recomp now, " +
    "so a dual-engine mod belongs here as gen1recomp alone; a Gen 2-only mod does not belong here at all",
};

/// The retired engines a row names, if any.
function retiredEngines(channels) {
  return channels.filter((channel) => RETIRED_ENGINES[channel]);
}

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
/// of an install button.
///
/// This was off while the catalog was small, for a good reason: the creator's
/// page for a decomp mod is a source repository whose most obvious download
/// button gives you an assembly tree, so an unqualified link is a trap more
/// often than a discovery. What answers that is `releasesUrl` — an indexed row
/// now links to the release page where the download actually is, and only the
/// handful with no release at all fall back to the repository root.
///
/// The other half of the argument was that these are mods nobody can install.
/// True, and still the wrong reason to hide them: the ecosystem is mostly
/// unlicensed, so hiding it leaves the catalog looking like the twenty mods
/// that happen to carry a LICENSE file rather than the field it is indexing.
const PUBLISH_INDEXED = true;

const TOPICS = ["GAMEPLAY", "QOL", "UI", "ART", "CONTENT", "AUDIO", "TRANSLATION"];

/// The voxel family, which gets a shelf of its own because it is the one part
/// of this catalog a player goes looking for BY NAME.
///
/// The six PROVIDERS are derived, not guessed: each one's archive calls
/// `mod.content.render_pipelines:register("voxel", ...)`, found by grepping
/// every cached release. That is the engine's own definition of a mod that
/// renders the world in voxels (src/mods/Schemas.lua documents the call).
///
/// The CONTENT mods cannot be derived and are named here on purpose. The
/// dependency graph does not separate them: authors use
/// `optional_dependencies` both for "this is voxel content" and for "this
/// coexists with voxel mods", so deriving from it swept in a cheat menu and a
/// running-shoes patch. A short hand list that somebody can read is the honest
/// answer, and it lives beside the derivation so the difference is visible.
const VOXEL_PROVIDERS = [
  "BATTLE_ART_VOXEL_FORK", "DRAMALESS_SHAPE", "DRAMATIC_SHAPE",
  "VOXEL_ASCENDANT", "potato_voxel", "voxel_run_bridge",
];
const VOXEL_CONTENT = [
  "voxel_characters", "red_3d_player", "VOXEL_DEX", "TERRARIUM",
  "DRAMATIC_SHAPE_GRASS_OBJ_REPLACER_V3",
];
const VOXEL_MODS = new Set([...VOXEL_PROVIDERS, ...VOXEL_CONTENT]);

/// A listing's shelves. Every mod keeps the topic it earned; a voxel mod is
/// ALSO on the voxel shelf, because "show me the voxel stuff" and "show me the
/// art mods" are different questions and the app filters on `contains`.
function categoriesFor(topic, modId) {
  return modId && VOXEL_MODS.has(modId) ? [topic, "VOXEL"] : [topic];
}

const CATEGORIES = [
  // Voxel leads the row. It is the one shelf players come looking for by
  // name, and burying it behind five taxonomy chips made the thing this
  // catalog is best known for the hardest thing in it to find.
  { id: "VOXEL", title: "Voxel", subtitle: "The world rendered in 3D", order: 0 },
  { id: "GAMEPLAY", title: "Gameplay", subtitle: "New systems and rules", order: 1 },
  { id: "QOL", title: "Quality of Life", subtitle: "Small frictions, removed", order: 2 },
  { id: "UI", title: "Interface", subtitle: "Menus, HUD and readouts", order: 3 },
  { id: "ART", title: "Art & Effects", subtitle: "How the game looks", order: 4 },
  { id: "CONTENT", title: "New Content", subtitle: "Places, events and challenges", order: 5 },
  { id: "AUDIO", title: "Sound", subtitle: "Music and what you hear", order: 6 },
  // Everything indexed lands here. Assigning invented topics to listings
  // nobody can install yet would be curation of things that are not on offer;
  // an entry moves to a real shelf the moment it has a topic and a file.
  // Named for where the download is, not for what Phosphor has not finished.
  // The id stays PENDING because entries reference it; only the words a player
  // reads have changed.
  { id: "TRANSLATION", title: "Translations", subtitle: "The game in another language", order: 7 },
  { id: "PENDING", title: "From their creators", subtitle: "Download straight from the source", order: 8 },
].filter((category) => category.id !== "PENDING" || PUBLISH_INDEXED);

const ALL_SECTIONS = [
  // Not "Reviewed community mods" any more: most of this tab is now
  // link-outs to mods whose creators have agreed to nothing, and calling
  // those reviewed claims a relationship that does not exist.
  { id: "luaMods", title: "Mods", subtitle: "Made by the community", kind: "luaMod", order: 0 },
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
  const retired = retiredEngines(channels);
  if (retired.length) {
    errors.push(`${label}: compatibility names ${retired.join(", ")} — ${RETIRED_ENGINES[retired[0]]}.`);
    return [];
  }
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
    // The engine family the app filters by, derived rather than typed. It is
    // scoped to THIS entry's engine and not to the release's compatibility:
    // a dual-engine mod is published once per engine, and each half installs
    // into one of them. See engineFacet.
    let facet = null;
    try {
      facet = engineFacet({ target: release.target, channels, installsInto: engineId, label });
    } catch (error) {
      errors.push(error.message);
    }
    return {
      id: engines.length > 1 ? `${release.id}@${engineId}` : release.id,
      kind: "luaMod",
      name: release.title,
      tagline: release.summary,
      // The prose the detail screen renders under the name. Without it every
      // detail page is a single line of tagline and nothing else, which is
      // most of why the catalog read as thin.
      description: release.description || release.summary,
      author: { name: release.creator, url: release.homepageUrl },
      version: release.version,
      releasedAt: release.releaseDate,
      license: release.licenseText
        ? { spdx: release.license, text: release.licenseText }
        : { spdx: release.license },
      // What the creator actually granted, which is a different question from
      // what the archive contains. See `grant` below on the tier-2 path: the
      // app has carried a Grant enum and a paragraph of copy for each case
      // since it shipped, and NOTHING HAS EVER SET IT -- 507 of 507 entries
      // published `grant: undefined`, so the branch that explains an
      // unlicensed mod to a player has never once rendered.
      permission: grantFor(release.permission),
      categories: categoriesFor(release.topic, release.modId),
      target: release.target,
      screenshots: [],
      download: {
        url: release.fileUrl,
        sizeBytes: release.fileSizeBytes,
        sha256: release.sha256,
        // Where the mod's manifest sits inside the archive. Published so the
        // app can assert against the catalog itself that nothing offered is
        // deeper than its own installer will look, rather than comparing a
        // constant here against a constant there across two repositories.
        manifestPath: release.manifestPath,
      },
      // `id` is the engine this archive installs into, and it is what the
      // installer acts on. `family` and `games` are what the Workshop's engine
      // filter reads, and they are structured precisely because `target` above
      // is not.
      engine: { id: engineId, ...(facet ?? {}) },
      modID: release.modId,
    };
  });
}

/// A pending listing: catalogued, linked, and installable only as CATALOG_POLICY
/// tier 2 ("direct from source").
///
/// Tier 2 is not a mirror and not an approval. The creator has granted nothing
/// and has not been asked, so Phosphor hosts nothing: the entry carries THEIR
/// release asset URL and the SHA-256 of the bytes the survey actually
/// downloaded and inspected, and the app refuses to unpack anything whose hash
/// does not match. That is the same integrity guarantee tier 1 has always had —
/// every install in this catalog has always pointed at somebody else's hosting.
///
/// What tier 2 must keep, and this function enforces:
///   - `project` stays, so the creator's own page is always one tap away
///   - `categories: ["PENDING"]`, so these sit on "From their creators" and
///     never on a curated shelf that would imply review
///   - `license` is absent, because there is no licence to name
///   - a rom-hack is never promoted: a hack that is not a patch is a cartridge
/// This repository's `permission` vocabulary, in the app's.
///
/// **Published under the key `permission`, which is what the app reads**, even
/// though the Swift property is called `grant`: `DiscoverCatalog.CodingKeys`
/// says "the manifest's word for `grant`, named for the question the site asks
/// (what permits this?) rather than for the answer". Emitting `grant` instead
/// publishes a field nothing decodes, which is the same dead branch this was
/// written to fix.
///
/// The vocabularies overlap but are not identical -- this repo's
/// `none-direct-source` is the app's `no-objection` -- so the mapping is
/// explicit. An unknown permission publishes nothing rather than guessing:
/// the app's paragraphs are specific, and a wrong one is worse than none.
function grantFor(permission) {
  switch (permission) {
    case "open-license": return "open-license";
    case "license-permits": return "license-permits";
    case "author-approved": return "author-approved";
    case "none-direct-source": return "no-objection";
    default: return undefined;
  }
}

function entryForProject(project, errors) {
  const label = project.id;
  const direct = project.directSource ?? null;

  if (project.fileUrl) {
    errors.push(`${label}: put an install under "directSource" (tier 2) or move the row to releases.json once permission is verified — a bare fileUrl says which of those it is`);
    return null;
  }
  if (direct && project.kind === "rom-hack") {
    errors.push(`${label}: a rom-hack cannot be tier 2 — a hack that is not a patch is a cartridge`);
    return null;
  }
  if (direct && (!direct.sha256 || !direct.fileUrl || !(direct.fileSizeBytes > 0)
                 || !direct.version || !direct.modId)) {
    errors.push(`${label}: tier 2 needs fileUrl, sha256, a positive fileSizeBytes, version and modId — an unverifiable install is the one thing pointing at a third-party URL must never allow`);
    return null;
  }
  if (!/^https:\/\//.test(project.homepageUrl ?? "")) {
    errors.push(`${label}: homepageUrl must use HTTPS — it is the only thing an indexed listing can offer`);
    return null;
  }

  const retired = retiredEngines(project.compatibility ?? []);
  if (retired.length) {
    errors.push(`${label}: compatibility names ${retired.join(", ")} — ${RETIRED_ENGINES[retired[0]]}.`);
    return null;
  }

  // An indexed listing carries no `engine.id`, because there is nothing to
  // install into one. It still names an engine in its `target`, on every one
  // of them, so the Workshop's engine filter works over the link-outs too.
  let facet = null;
  try {
    facet = engineFacet({ target: project.target, channels: project.compatibility ?? [], label });
  } catch (error) {
    errors.push(error.message);
    return null;
  }

  return {
    id: project.id,
    kind: project.kind === "rom-hack" ? "romPatch" : "luaMod",
    name: project.title,
    tagline: project.summary,
    // The author credit points at the project; the card's own link points at
    // the download. They are different questions and usually different pages.
    author: { name: project.creator, url: project.homepageUrl },
    // PENDING first and always, then the kind of mod it actually is.
    //
    // **Additive rather than a replacement, deliberately.** PENDING is this
    // listing's provenance — nobody has cleared it — and the app already
    // recognises it and keeps it out of the taxonomy chip row, so leaving it
    // in place means the paperwork stays recorded and stays invisible. What
    // changes is that the row is no longer filed under NOTHING ELSE: until
    // 22 Sep 2026 these carried PENDING alone, so all 214 installable tier-2
    // mods vanished the moment a player tapped any chip, and the row of chips
    // advertised 43 / 30 / 44 over a catalog of 379.
    //
    // Additive also means already-shipped copies of the app get the fix
    // without an App Store release: a build that has never heard of this
    // change reads the same PENDING it always did, and finds a real category
    // beside it.
    // Tier 2 is exactly the enum's `no-objection`: "no licence, and no refusal
    // either". This is what lights up the detail screen's paragraph saying the
    // author published no licence, that Phosphor lists it because nothing in
    // it says not to, and that it comes down if they ask.
    permission: grantFor(direct?.permission ?? "none-direct-source"),
    categories: [...new Set([
      "PENDING",
      ...(direct?.modId && VOXEL_MODS.has(direct.modId) ? ["VOXEL"] : []),
      ...categorize({ title: project.title, tagline: project.summary,
                      modId: direct?.modId ?? "" }),
    ])],
    target: project.target,
    // Tier 2 needs `engine.id` for the app to install into one; a link-out
    // still names the family so the Workshop's engine filter works over it.
    ...(facet ? { engine: direct ? { id: engineIdFor(project, facet), ...facet } : facet } : {}),
    screenshots: [],
    ...(direct ? {
      version: direct.version,
      releasedAt: direct.releasedAt,
      modID: direct.modId,
      download: {
        url: direct.fileUrl,
        sizeBytes: direct.fileSizeBytes,
        sha256: direct.sha256,
        manifestPath: direct.manifestPath,
      },
    } : {}),
    // Kept in BOTH tiers. For tier 2 it is load-bearing rather than a
    // fallback: it is the only route to the person whose work this is.
    project: { url: project.releasesUrl ?? project.homepageUrl, status: project.reviewStatus },
  };
}

/// Which engine a tier-2 archive installs into, as a STRING.
///
/// Not `project.engine`: that field is a facet OBJECT on some rows, and
/// assigning it to `id` emitted `{"id": {"family": ...}}`, which the app's
/// decoder refuses because it reads `id` as a String. Six listings decoded as
/// unreadable and were silently dropped -- the app counted them, which is the
/// only reason it was visible at all. The family is the string, and every
/// promoted row declares `compatibility: ["gen1recomp"]` anyway.
function engineIdFor(project, facet) {
  const declared = typeof project.engine === "string" ? project.engine : null;
  const family = typeof facet?.family === "string" ? facet.family : null;
  // "both" is a FAMILY spanning two engines, never an engine to install into.
  const id = declared ?? (family === "both" ? GEN1 : family) ?? GEN1;
  return id;
}

/// What `scripts/enrich-catalog.mjs` last read out of the archives and the
/// GitHub API, keyed by release or project id.
///
/// Read from a committed file rather than fetched here, because this script
/// runs on every push and in CI and has to stay deterministic and offline.
/// An absent file is not an error: the catalog is complete without enrichment
/// and every field it adds is optional in the app.
async function enrichment() {
  try {
    return JSON.parse(await readFile(ENRICHMENT, "utf8"));
  } catch {
    return {};
  }
}

/// Copies the enriched blocks onto an entry.
///
/// Keyed by the id BEFORE the fan-out suffix: one release published for two
/// engines becomes `id@engine` twice, and both halves are the same archive and
/// the same repository, so both carry the same requirements and the same
/// download count.
/// Marks a listing whose network half cannot work here but which plays
/// without it. See `ONLINE_UNAVAILABLE`.
///
/// Merged into `requirements` rather than published beside it, because the app
/// already reads exactly one block for "things to tell the player before they
/// install", and a second one would be a second place to forget.
function onlineUnavailableFor(entry, enriched) {
  const repo = /github\.com\/([^/#?]+\/[^/#?]+)/.exec(entry.author?.url ?? "")?.[1];
  const wanted = (repo ?? "").toLowerCase().replace(/\.git$/, "");
  const known = Object.keys(ONLINE_UNAVAILABLE).some((name) => name.toLowerCase() === wanted);
  if (!known) return {};
  return { requirements: { ...(enriched.requirements ?? {}), onlineUnavailable: true } };
}

/// Takes the install off a row the catalogued engine has moved past.
///
/// A mod's `game_version` is a claim about which engines it runs on, and the
/// engine under it moves on its own schedule. When a bump carries the catalog
/// past a row's upper bound, that row's install button becomes a button that
/// installs something which cannot load. The app already refuses it -- it
/// computes the same fit itself and says NEEDS 3D ENGINE -- so the button is
/// not dangerous, it is just a lie the catalog is telling.
///
/// DERIVED, NOT WRITTEN DOWN, for the same reason ENGINE_VERSIONS is. The
/// alternative is a human noticing and hand-demoting the row, which is how
/// three rows were handled on 22 Sep 2026, and it fails in both directions:
/// nobody demotes the fourth, and nobody remembers to PROMOTE any of them
/// when the creator ships support for the new engine. Derived, the row comes
/// back by itself the moment its range covers the engine again, and no
/// listing has to be edited to say something its manifest already says.
///
/// This is not a judgement about the mod. The row keeps its creator, its
/// licence, its summary and its link, and it keeps being a listing somebody
/// can find and go install from the source. What it loses is the claim that
/// Phosphor can hand it to you, which is the one part that stopped being
/// true. `requirements` goes with the download because requirements describe
/// the bytes a row pins, which is the rule enrich() already follows.
///
/// Announced by the caller rather than swallowed: a row dropping off the
/// installable shelf is worth a line in the build output, and usually worth
/// telling the creator that the engine has moved.
export function demoteRowsTheEngineMovedPast(entries, engines, errors) {
  const gate = Object.fromEntries(engines.map((e) => [e.id, e.catalogedAgainst]));
  const demoted = [];
  const kept = entries.map((entry) => {
    const range = entry.requirements?.engineRange;
    if (!entry.download || !range) return entry;
    const against = gate[entry.engine?.id];
    // No gate for this engine means nothing to compare against, which is not
    // the same as a row that fails the comparison. Leave it alone.
    if (!against || satisfies(against, range)) return entry;

    // A card with neither an install nor a link does nothing when tapped. A
    // tier-2 row already carries `project`, because the link to the person
    // whose work it is was always the point. A tier-1 row never needed one --
    // it was always installable -- so demoting it has to supply the link, and
    // `author.url` is the same homepage its listing was written from.
    const url = entry.project?.url ?? entry.author?.url;
    if (!/^https:\/\//.test(url ?? "")) {
      errors.push(`${entry.id}: the catalogued engine has moved past ${range},`
        + " so this row cannot be offered as an install, and it has no HTTPS"
        + " link to fall back to. Give it a homepageUrl before publishing.");
      return entry;
    }

    demoted.push(`${entry.id} needs ${range}, catalogued against ${against}`);
    // Everything that describes THE BYTES goes with the download: the
    // version, when they were cut, the mod id inside them, and the
    // requirements for installing them. Stating a version for a file this
    // catalog no longer offers is the same pretending the link-out rule
    // already forbids. What stays is what describes the WORK -- its name,
    // author, summary, categories and its licence, which is a fact about
    // permission and does not expire because an engine moved.
    const rest = { ...entry };
    for (const key of ["download", "requirements", "version", "releasedAt", "modID"]) {
      delete rest[key];
    }
    return {
      ...rest,
      // `engine-moved-on` is not a stage of the permission queue, and says so.
      // Safe on builds that predate it: DiscoverCatalog carries `status` as a
      // plain string for diagnostics and prints "Available from the creator"
      // for every value, which DiscoverIndexedListingTests pins with a status
      // no build has heard of. A player sees the same card either way.
      project: entry.project ?? { url, status: "engine-moved-on" },
    };
  });
  return { entries: kept, demoted };
}

function enrich(entry, table) {
  const enriched = table[entry.id] ?? table[entry.id.split("@")[0]];
  if (!enriched) return entry;
  return {
    ...entry,
    // Requirements describe the bytes a row pins, so only a row with a
    // download carries them: a listing demoted to index-only keeps its
    // enrichment on disk, and publishing its imports or its engine range
    // would describe a file nobody can install from here.
    ...(enriched.requirements && entry.download ? { requirements: enriched.requirements } : {}),
    ...(entry.download ? onlineUnavailableFor(entry, enriched) : {}),
    ...(enriched.popularity ? { popularity: enriched.popularity } : {}),
    // The mod's own logo, where its author has adopted the Logo.PNG
    // convention. `screenshots` stays whatever the row declared: a logo is not
    // a screenshot, and feeding one to the detail screen's gallery would
    // stretch a wordmark across a viewport sized for gameplay.
    ...(enriched.icon ? { icon: enriched.icon } : {}),
    // Only when the row declared none of its own: a hand-picked screenshot in
    // src/data beats one scraped out of a README, and the scrape must never
    // quietly replace an editor's choice.
    ...(enriched.screenshots && !entry.screenshots?.length
        ? { screenshots: enriched.screenshots } : {}),
  };
}

/// `onDemote` is how the caller hears about rows the engine has moved past.
/// A callback rather than a field on the manifest: the manifest is committed
/// and diffed byte for byte by --check, so anything added to it is published,
/// and this is a note for whoever ran the build, not for the app.
export async function buildManifest({ onDemote } = {}) {
  const releases = JSON.parse(await readFile(RELEASES, "utf8"));
  const projects = JSON.parse(await readFile(PROJECTS, "utf8"));
  const enriched = await enrichment();
  const errors = [];

  const publishedKinds = new Set(SECTIONS.map((section) => section.kind));

  const entries = [
    ...releases.flatMap((release) => entriesForRelease(release, errors)),
    ...(PUBLISH_INDEXED
      ? projects.map((project) => entryForProject(project, errors)).filter(Boolean)
      : []),
  // An entry whose kind has no section would be fetched and then never shown.
  ].filter((entry) => publishedKinds.has(entry.kind))
    .map((entry) => enrich(entry, enriched));

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

  // The engine versions every `game_version` range above was evaluated
  // against, keyed by the APP's engine id the way `entry.engine.id` is,
  // because the app is who reads this.
  //
  // Published because the constant behind it went stale three times and
  // nothing could notice: it is unreadable from the app repo and
  // unenforceable from this one, and it is wrong in both directions when it
  // drifts — withholding mods the shipped engine can run, publishing mods it
  // cannot. The app compares this against the ENGINE_VERSION sidecar in its
  // own payload and fails its suite when they disagree, which puts the alarm
  // on the side that knows which engine is actually running.
  //
  // No schemaVersion bump: this is an added field, and a build that has never
  // heard of it ignores it and behaves exactly as before.
  const engines = Object.entries(ENGINE_VERSIONS)
    .filter(([channel]) => ENGINE_IDS[channel])
    .map(([channel, version]) => ({ id: ENGINE_IDS[channel], catalogedAgainst: version }));

  // After `engines`, because the gate it compares against is built there, and
  // after enrich(), because `requirements.engineRange` arrives with it.
  const demotionErrors = [];
  const { entries: offered, demoted } =
    demoteRowsTheEngineMovedPast(entries, engines, demotionErrors);
  if (demotionErrors.length) fail(demotionErrors);
  if (demoted.length && onDemote) onDemote(demoted);

  // The vocabulary every `requirements.games` line is written against. A row
  // with no games line covers every one of THESE, and the app reads it that
  // way rather than as "every game the app runs": without it, the day the app
  // learned FireRed every silent row in a six-cartridge catalog would have
  // claimed it. No schemaVersion bump, for the same reason as `engines`.
  return { schemaVersion: 1, generated, engines, games: CARTRIDGES, sections: SECTIONS,
           categories: CATEGORIES, entries: offered };
}

const serialise = (manifest) => JSON.stringify(manifest, null, 2) + "\n";

async function main() {
  const demotions = [];
  const manifest = await buildManifest({ onDemote: (rows) => demotions.push(...rows) });
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
  if (demotions.length) {
    console.log(`\nindexed rather than installable, the engine has moved past them (${demotions.length}):`);
    for (const row of demotions) console.log(`   ${row}`);
    console.log("   each comes back on its own when its range covers the catalogued engine.");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
