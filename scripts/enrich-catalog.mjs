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
