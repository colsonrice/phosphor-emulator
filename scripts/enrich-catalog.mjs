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
import { entryNames, readEntry, readManifest } from "./lib/archive.mjs";

/// Every cartridge this app ships an engine for, by generation.
///
/// This list was `["blue", "red", "yellow"]` and stayed that way through
/// gen1recomp declaring gold and silver (v0.2.12) and crystal (v0.2.24). The
/// cost was not cosmetic: the rule below only publishes a `games` line for a
/// STRICT SUBSET of this list, so once the engine ran six games a Gen 1-only
/// mod stopped looking like a subset of three and the line vanished for
/// exactly the mods that most needed it. Two of 266 rows carried it, and a
/// player installing a Gen 1 mod for Crystal was told nothing at all.
///
/// Keep it in step with the engine's GameVersion.ORDER.
const GEN1_CARTRIDGES = ["red", "blue", "yellow"];
const GEN2_CARTRIDGES = ["gold", "silver", "crystal"];
const CARTRIDGES = [...GEN1_CARTRIDGES, ...GEN2_CARTRIDGES];

/// Which cartridges a manifest actually covers, by the ENGINE's own rule
/// (src/mods/ModTargets.lua). An explicit `games` list wins, expanding "all"
/// and "genN"; otherwise the legacy flag decides, and `gen2compat` is what
/// upgrades a mod from Gen 1 only to every game.
///
/// This has to match the loader exactly, because the loader is what refuses
/// the mod at boot: `Loader:_skip(mod, "wrong_generation", "not marked
/// gen2compat; this is a Gen 2 game")`. A catalog that disagrees would promise
/// an install the engine then silently declines.
export function cartridgesFor(manifest) {
  const declared = manifest.games;
  if (Array.isArray(declared) && declared.length) {
    const out = new Set();
    for (const raw of declared) {
      const key = String(raw).toLowerCase().trim();
      if (key === "all") CARTRIDGES.forEach((c) => out.add(c));
      else if (key === "gen1") GEN1_CARTRIDGES.forEach((c) => out.add(c));
      else if (key === "gen2") GEN2_CARTRIDGES.forEach((c) => out.add(c));
      else if (CARTRIDGES.includes(key)) out.add(key);
    }
    if (out.size) return CARTRIDGES.filter((c) => out.has(c));
  }
  return manifest.gen2compat ? [...CARTRIDGES] : [...GEN1_CARTRIDGES];
}

/// Declared by every mod that declares any permission at all. Not a
/// disclosure.
const UNIVERSAL_PERMISSION = "engine_internals";

/// What a mod says about itself that a player should see before installing.
///
/// `null` when it has nothing to say, so the app draws no empty block. Roughly
/// a third of the installable catalog answers null, and that is the correct
/// shape: a mod with no conflicts, no unusual permissions and no flags has
/// nothing to warn anybody about.
/// `usesNetwork` is what the mod's Lua actually reaches for, which the caller
/// reads from the archive. Null means it was not checked.
export function requirementsFrom(manifest, { usesNetwork = null } = {}) {
  const out = {};

  const permissions = (manifest.permissions ?? [])
    .filter((p) => p !== UNIVERSAL_PERMISSION)
    // **Check what a mod requires, not what it declares.** The app refuses to
    // install a mod that needs the network, because the sandbox denies sockets
    // unconditionally and such a mod would install and then do nothing. But a
    // declaration is not a requirement: Pokewalker declares `network` and
    // never loads a network module, it reads `mod.steps`, a field of the mod
    // object. Publishing its declaration made the app refuse the one working
    // mod the rule applies to. Every guard in this project has refused a
    // legitimate mod before it refused a hostile one; this is that, caught on
    // a simulator instead of by a player.
    .filter((p) => !(p === "network" && usesNetwork === false));
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

  // Published whenever the mod does NOT cover every cartridge. "For Red, Blue
  // and Yellow only." is the line the app draws from this, and for a Gen 1 mod
  // being installed against Crystal it is the whole warning.
  const covers = cartridgesFor(manifest);
  if (covers.length < CARTRIDGES.length) out.games = covers;

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

/// Whether the mod's Lua actually reaches for a network module.
///
/// Only asked of a mod that declares `network`, because opening every .lua in
/// every archive to answer a question nobody asked is the slow half of this
/// pass. See the filter in `requirementsFrom` for why the declaration alone is
/// not enough.
const NETWORK_USE = [
  /require\s*\(?\s*["'](socket|enet|http|https|lua-https)[."']/,
  /\bmod\.fetch\b/,
  /\bsocket\s*\./,
  /\benet\s*\./,
];

async function usesNetwork(archive) {
  const { names } = await entryNames(archive);
  for (const name of names.keys()) {
    if (!name.endsWith(".lua")) continue;
    const source = await readEntry(archive, name, names);
    if (NETWORK_USE.some((pattern) => pattern.test(source))) return true;
  }
  return false;
}

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

/// The mod's own logo, by the convention the community started in August 2026:
/// an image called Logo.PNG at the root of the repo.
///
/// Matched case-insensitively, and that is not pedantry. The announcement says
/// "Logo.PNG" and of the first five mods to adopt it, none used that spelling —
/// they shipped `Logo.png`, `LOGO.png` and `logo.png`. A literal match would
/// have found zero of them. The name that comes back from the API is used
/// verbatim afterwards, because raw.githubusercontent IS case-sensitive.
///
/// `download_url` rather than a URL assembled here: the API already knows the
/// default branch, and guessing between `main` and `master` is a 404 for
/// whichever half of the ecosystem guessed wrong.
const LOGO_NAME = /^logo\.(png|jpe?g|webp)$/i;
/// A logo is fetched on a row that may be one of two hundred on screen. Past
/// this it is not a logo, it is somebody's uncompressed export, and the cost
/// lands on a phone.
const MAX_LOGO_BYTES = 4 * 1024 * 1024;

async function logoForRepo(repo, token) {
  if (!repo) return null;
  const root = await gh(`/repos/${repo}/contents/`, token);
  if (!Array.isArray(root)) return null;
  const file = root.find((e) => e?.type === "file" && LOGO_NAME.test(e.name ?? ""));
  if (!file?.download_url) return null;
  if (typeof file.size === "number" && file.size > MAX_LOGO_BYTES) return null;
  return { url: file.download_url };
}

/// Screenshots, from where mod authors actually put them.
///
/// The Logo.PNG convention is three weeks old and five of 281 catalogued repos
/// follow it. Sixty-two put images in their README, which is four hundred-odd
/// pictures nobody was reading. So the README is the source, and the
/// convention is the exception rather than the rule.
///
/// What survives the filter, decided by looking at the four hundred rather
/// than by guessing:
///
///   kept     paths that say what they are — screenshot, preview, promo, demo,
///            docs/, gif, showcase — plus drag-and-drop uploads to
///            github.com/user-attachments, which have no meaningful path but
///            are always a picture somebody pasted in to show the thing off
///   dropped  sprite sheets and loose art (`assets/cindrake_front.png`), which
///            are the reason this is not simply "every image in the README"
///   dropped  badges, and img.youtube thumbnails, which look like a screenshot
///            and are a link to a video the app cannot play
///
/// Relative paths resolve against the README's own location, not the repo
/// root: a README under docs/ makes `shot.png` mean `docs/shot.png`.
const SHOT_HINT = /(screen ?shot|preview|promo|demo|docs?\/|gif|showcase|example)/i;
const SHOT_EXT = /\.(png|jpe?g|webp|gif)(\?|$)/i;
const SHOT_SKIP = /img\.youtube|youtube\.com|badge|shields\.io|licensebuttons|forthebadge/i;
const SHOT_ALWAYS = /github\.com\/user-attachments|i\.imgur\.com/i;
const MAX_SHOTS = 6;

function imageURLsIn(markdown) {
  const out = [];
  const pattern = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)|<img[^>]+src=["']([^"']+)["']/gi;
  for (const match of markdown.matchAll(pattern)) {
    const url = (match[1] ?? match[2] ?? "").trim();
    if (url) out.push(url);
  }
  return out;
}

async function screenshotsForRepo(repo, token, skipURL) {
  if (!repo) return null;
  const readme = await gh(`/repos/${repo}/readme`, token);
  if (!readme?.content || !readme?.download_url) return null;

  let markdown;
  try {
    markdown = Buffer.from(readme.content, "base64").toString("utf8");
  } catch { return null; }

  const seen = new Set(skipURL ? [skipURL] : []);
  const shots = [];
  for (const raw of imageURLsIn(markdown)) {
    if (SHOT_SKIP.test(raw)) continue;
    if (!SHOT_EXT.test(raw) && !SHOT_ALWAYS.test(raw)) continue;
    if (!SHOT_HINT.test(raw) && !SHOT_ALWAYS.test(raw)) continue;

    let url;
    try {
      url = new URL(raw, readme.download_url).toString();
    } catch { continue; }
    if (!url.startsWith("https://") || seen.has(url)) continue;
    seen.add(url);
    shots.push({ url });
    if (shots.length === MAX_SHOTS) break;
  }
  return shots.length ? shots : null;
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
      const declaresNetwork = (manifest.permissions ?? []).includes("network");
      const requirements = requirementsFrom(manifest, {
        usesNetwork: declaresNetwork ? await usesNetwork(archive) : null,
      });
      if (requirements) entry.requirements = requirements;
    } else {
      unreadable.push(release.id);
    }

    const repo = repoFrom(release.homepageUrl, release.fileUrl);
    const popularity = await popularityForRepo(repo, token, asOf);
    if (popularity) entry.popularity = popularity;

    const icon = await logoForRepo(repo, token);
    if (icon) entry.icon = icon;
    const shots = await screenshotsForRepo(repo, token, icon?.url);
    if (shots) entry.screenshots = shots;

    if (Object.keys(entry).length) out[release.id] = entry;
  }

  // Link-outs have no archive to read, so they get the popularity half only.
  // They are two thirds of the catalog and they sort in the same list, so
  // skipping them would make the new sort a filter.
  for (const project of projects) {
    const repo = repoFrom(project.homepageUrl);
    const entry = {};
    const popularity = await popularityForRepo(repo, token, asOf);
    if (popularity) entry.popularity = popularity;
    // A link-out gets a logo too. It sits in the same list as everything else
    // now that the tabs are gone, so giving art only to the installable third
    // would make the list look sorted by something it is not.
    const icon = await logoForRepo(repo, token);
    if (icon) entry.icon = icon;
    const shots = await screenshotsForRepo(repo, token, icon?.url);
    if (shots) entry.screenshots = shots;
    if (Object.keys(entry).length) out[project.id] = entry;
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
