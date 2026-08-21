// Enriches the catalog with two things a row cannot know about itself.
//
// `requirements` is what a mod says about itself, read out of its own
// manifest.json inside the archive `verify-releases.mjs` has already
// downloaded and hash-checked. Reading the same cached bytes we verify is the
// point: requirements can then never describe a different file than the one
// the catalog ships.
//
// `popularity` is how used a mod is, from the GitHub releases API. Every one
// of the catalog's rows resolves to a GitHub repo, so this covers the whole
// catalog rather than the third of it that a third-party index knows about.
//
// Output is `src/data/enrichment.json`, which `build-manifest.mjs` merges onto
// entries by id. A separate generated file rather than an inline step, because
// `build-manifest.mjs` runs on every push and in CI and must stay
// deterministic and offline; this pass reaches the network and runs when
// somebody asks it to.
//
// Usage:
//   GITHUB_TOKEN=$(gh auth token) node scripts/enrich-catalog.mjs

import { readFile, writeFile } from "node:fs/promises";
import { readManifest } from "./lib/archive.mjs";

/// The three cartridges this app ships an engine for.
///
/// A `games` value naming all three, or naming a generation rather than a
/// cartridge, is a constant and is not published: it would be the
/// `target: "Gen1Recomp"` mistake in a new costume. Two live mods name a real
/// subset.
const CARTRIDGES = ["blue", "red", "yellow"];

/// Declared by every mod that declares any permission at all. Not a
/// disclosure.
const UNIVERSAL_PERMISSION = "engine_internals";

/// What a mod says about itself that a player should see before installing.
///
/// `null` when it has nothing to say, so the app draws no empty block. Roughly
/// a third of the installable catalog answers null, and that is the correct
/// shape: a mod with no conflicts, no unusual permissions and no flags has
/// nothing to warn anybody about.
export function requirementsFrom(manifest) {
  const out = {};

  const permissions = (manifest.permissions ?? []).filter((p) => p !== UNIVERSAL_PERMISSION);
  if (permissions.length) out.permissions = permissions;

  if (manifest.conflicts?.length) out.conflicts = [...manifest.conflicts];

  // `dependencies` is deliberately not read: 61 manifests declare it and all
  // 61 are empty. `optional_dependencies` is the populated one, and it is
  // advice rather than a gate, so it must not reach the app as a blocker.
  if (manifest.optional_dependencies?.length) {
    out.worksWith = [...manifest.optional_dependencies];
  }

  if (manifest.affects_link === true) out.affectsLink = true;
  if (manifest.experimental === true) out.experimental = true;

  const games = (manifest.games ?? []).map((g) => String(g).toLowerCase()).sort();
  const namesCartridges = games.length > 0 && games.every((g) => CARTRIDGES.includes(g));
  if (namesCartridges && games.length < CARTRIDGES.length) out.games = games;

  return Object.keys(out).length ? out : null;
}

/// How used a mod is, from its GitHub releases.
///
/// **Absence is a fact, not a zero.** The whole block is omitted for a repo
/// that publishes no release assets, because a mod distributed another way is
/// unmeasured rather than unpopular. A repo that published a file nobody took
/// is a different thing and gets `downloads: 0`. Nothing downstream may
/// substitute one for the other: that is the same mistake as folding "could
/// not fetch" into "refused", which on a real run turns a network blip into a
/// delisting.
export function popularityFrom(repo, releases, asOf) {
  const assets = (releases ?? []).flatMap((r) => r.assets ?? []);
  if (!assets.length) return null;

  const out = { downloads: assets.reduce((sum, a) => sum + (a.download_count ?? 0), 0) };
  // Omitted rather than zeroed when the repo call itself failed or 404'd, for
  // the same reason as the block above.
  if (typeof repo?.stargazers_count === "number") out.stars = repo.stargazers_count;
  out.asOf = asOf;
  return out;
}

// MARK: - The runner

const RELEASES = new URL("../src/data/releases.json", import.meta.url);
const PROJECTS = new URL("../src/data/projects.json", import.meta.url);
const OUTPUT = new URL("../src/data/enrichment.json", import.meta.url);
const CACHE = new URL("../survey/cache/", import.meta.url);

/// The filename `verify-releases.mjs` writes into `survey/cache/`. Kept
/// identical on purpose: this pass reads the very bytes that were hashed
/// against the catalog, so requirements cannot describe a different file than
/// the one the catalog ships.
const cacheNameFor = (release) => `published__${release.id}__${release.fileName}`;

const repoFrom = (...urls) => {
  for (const url of urls) {
    const m = /github\.com\/([^/#?]+)\/([^/#?]+)/.exec(url ?? "");
    if (m) return `${m[1]}/${m[2].replace(/\.git$/, "")}`;
  }
  return null;
};

/// 281 repos is well past the 60/hour unauthenticated ceiling. Refusing to run
/// is the only safe answer: a rate-limited pass writes no popularity block for
/// most rows, and absence is MEANINGFUL in this schema, so the result would
/// publish "nobody downloads these mods" as a fact.
function requireToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is required. A partial pass publishes absence as a fact.\n"
      + "  GITHUB_TOKEN=$(gh auth token) node scripts/enrich-catalog.mjs",
    );
  }
  return token;
}

async function gh(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

/// Popularity for one repo. A repo that 404s (deleted, renamed, made private)
/// answers null all the way through rather than zero.
async function popularityForRepo(repo, token, asOf) {
  if (!repo) return null;
  const [meta, releases] = await Promise.all([
    gh(`/repos/${repo}`, token),
    gh(`/repos/${repo}/releases?per_page=100`, token).then((r) => r ?? []),
  ]);
  return popularityFrom(meta, releases, asOf);
}

async function main() {
  const token = requireToken();
  const releases = JSON.parse(await readFile(RELEASES, "utf8"));
  const projects = JSON.parse(await readFile(PROJECTS, "utf8"));
  const asOf = new Date().toISOString().slice(0, 10);

  const out = {};
  let manifestsRead = 0;
  const unreadable = [];

  for (const release of releases) {
    const entry = {};

    const archive = new URL(cacheNameFor(release), CACHE).pathname;
    const manifest = await readManifest(archive);
    if (manifest) {
      manifestsRead += 1;
      const requirements = requirementsFrom(manifest);
      if (requirements) entry.requirements = requirements;
    } else {
      unreadable.push(release.id);
    }

    const popularity = await popularityForRepo(
      repoFrom(release.homepageUrl, release.fileUrl), token, asOf,
    );
    if (popularity) entry.popularity = popularity;

    if (Object.keys(entry).length) out[release.id] = entry;
  }

  // Link-outs have no archive to read, so they get the popularity half only.
  // They are two thirds of the catalog and they sort in the same list, so
  // skipping them would make the new sort a filter.
  for (const project of projects) {
    const popularity = await popularityForRepo(repoFrom(project.homepageUrl), token, asOf);
    if (popularity) out[project.id] = { popularity };
  }

  // A silent 80-of-90 is the exact failure this feature was born from: a
  // reader that quietly loses ten Windows-made archives publishes a catalog
  // that looks complete. The count is asserted, not logged.
  if (manifestsRead !== releases.length) {
    throw new Error(
      `read ${manifestsRead} manifests of ${releases.length} published releases.\n`
      + `  unreadable: ${unreadable.join(", ")}\n`
      + "  run: node scripts/verify-releases.mjs   (it populates survey/cache/)",
    );
  }

  await writeFile(OUTPUT, JSON.stringify(out, null, 2) + "\n");

  const withRequirements = Object.values(out).filter((e) => e.requirements).length;
  const withPopularity = Object.values(out).filter((e) => e.popularity).length;
  console.log(
    `wrote src/data/enrichment.json — ${Object.keys(out).length} entries `
    + `(${withRequirements} with requirements, ${withPopularity} with popularity); `
    + `${manifestsRead}/${releases.length} manifests read`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
