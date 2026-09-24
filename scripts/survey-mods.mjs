// Surveys the mod ecosystem and reports what could be catalogued.
//
// The catalog was fed by hand, one release at a time, which is why it reads as
// sparse: there are hundreds of mods and the bottleneck was never supply. This
// walks the whole field and reports, for every mod it can find, whether it
// clears the bar for an installable listing, only for a link-out, or neither.
//
// It deliberately writes NOTHING to src/data. Approval is a human step — that
// is the moderation gate guideline 4.7.1 asks for, and it is what makes
// "approved" mean the exact bytes somebody looked at. The output is a report to
// read, and rows to paste once you agree with them.
//
// Usage:
//   node scripts/survey-mods.mjs              survey everything, write survey/report.json
//   node scripts/survey-mods.mjs --limit 20   stop after 20 repos, for a quick look
//   node scripts/survey-mods.mjs --offline    use only what is already cached
//
// Requires the `gh` CLI, authenticated. The GitHub API's unauthenticated rate
// limit is 60 requests an hour and this makes two per repo.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { auditTargets, engineFacet, ENGINE_VERSIONS } from "./engine-family.mjs";
import { importsFrom } from "./enrich-catalog.mjs";
import { EXCLUDED } from "./lib/excluded.mjs";
import { satisfies } from "./lib/semver.mjs";

const run = promisify(execFile);

const INDEX_FEED = "https://bryanthaboi.github.io/gen1recomp-mod-index/data/index.json";

/// Search terms for mods the official index has never heard of. The index is
/// gen1recomp's, so every Gen 2 mod in existence is invisible to it.
///
/// **Overlap between these is the point, not waste.** Each one is a different
/// guess at what a creator wrote in their description, and the sweep dedupes
/// by repository, so a term that returns mostly-known repositories still earns
/// its place if it returns one that no other term does.
const SEARCHES = [
  "gen1recomp", "gen1recomp mod", "gen2recomp", "gen2recomped",
  "pokemon recomp mod", "topic:gen1recomp", "topic:gen2recomp",
  // Added 22 Sep 2026. "gen1recomp++" is the name creators use for the
  // modding fork and returns 398 repositories on its own; "recomp pokemon"
  // catches descriptions that never write the engine's name as one word.
  "gen1recomp++", "recomp pokemon", "topic:gen1recomp-mod",
  "kanto recomp", "johto recomp", "love2d pokemon mod", "topic:pokemon-mod",
  // Added 23 Sep 2026, the day LeafGreen shipped. Every term above says
  // "gen1" or "gen2" or a Game Boy region, and the engine now runs Gen 3: a
  // creator writing Gen 3 mods has no reason to type any of them. FAFF0x had
  // published 23 working FireRed mods at `FAFF0x/gen3recomp` — no
  // description, no topics, so nothing but the NAME was searchable, and the
  // one word in it was the one word this list did not have.
  "gen3recomp", "gen3 recomp", "firered recomp", "leafgreen recomp",
  "firered mod gen1recomp", "topic:gen3recomp",
];

/// Terms swept a second time across FORKS.
///
/// GitHub's search API hides forks unless asked, so the sweep above cannot see
/// them at all — and a fork is how a creator who started from somebody else's
/// mod publishes theirs. About nine in ten are bare engine clones, which is
/// why this is a separate pass with its own filter rather than `fork:true` on
/// the main one: the clones would crowd out the real results inside a single
/// query's page limit.
const FORK_SEARCHES = ["gen1recomp", "gen2recomped", "pokemon recomp"];

/// Repository names that are a clone of an engine rather than a mod.
///
/// The heuristic is the NAME, because a fork that is a mod is a fork somebody
/// renamed. It is deliberately loose in the direction of letting things
/// through: everything it admits still has to survive the archive inspection
/// below, so a wrong guess here costs a download, while a wrong guess the
/// other way loses a mod silently. That is the trade every guard in this
/// pipeline has got backwards at least once.
const ENGINE_CLONE_NAMES = /^(gen1recomp|gen2recomp|gen2recomped|gen3recomp)([-_. ]?(pp|plus|\+\+))?$/i;

/// Licences under which a creator has already granted redistribution. This is
/// the same bar the catalog's existing rows use — `permission: "open-license"`
/// with the LICENSE file as the evidence. Anything else, including GitHub's
/// "NOASSERTION" for a licence it cannot identify, is a link-out at most.
const PERMISSIVE = new Set([
  "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC",
  "Unlicense", "CC0-1.0", "Zlib", "0BSD", "MPL-2.0",
]);

/// Mirrors RecompModLibrary. Kept in sync by hand and deliberately so: if the
/// app raises a ceiling, publishing something it would have refused is the
/// failure to avoid, and a survey that quietly used a stale number would hide
/// exactly that. The swiftc install harness is the authority; this is the cheap
/// filter that runs first.
const MAX_ENTRY_COUNT = 50_000;
/// Mirrors RecompModLibrary.maxManifestDepth. See the note at its use.
const MAX_MANIFEST_DEPTH = 1;
const MAX_TOTAL_UNCOMPRESSED = 512 * 1024 * 1024;

/// A ROM inside a mod archive is the one thing that can never be published,
/// whatever the licence says: an author's permission over their own mod grants
/// nothing over Nintendo's cartridge.
const ROM_EXTENSIONS = [".gb", ".gbc", ".gba", ".sgb"];

const CACHE = new URL("../survey/cache/", import.meta.url);
// REPORT is defined below, after the flags are parsed.

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const OFFLINE = flag("--offline");
const LIMIT = Number(value("--limit")) || Infinity;
/// A newline-separated list of `owner/repo` to survey instead of discovering
/// them. The two built-in sources are the official index and a GitHub search
/// sweep, and there are places mods are announced that neither can see — the
/// BOI'S CLUB GAMES #pkmn-mods forum most of all. This lets that list be fed
/// in directly rather than waiting for a repo to become findable.
const REPO_LIST = value("--repos");
/// Where to write the report. A run over a hand-fed list is not the standing
/// survey and must not overwrite it.
const REPORT_PATH = value("--report");
const REPORT = new URL(REPORT_PATH ?? "../survey/report.json", import.meta.url);
/// Drafts sit beside the report they were drafted from. They used to have one
/// fixed path each, so a hand-fed run (which correctly leaves the standing
/// report alone) still overwrote the standing DRAFTS, and with a list of repos
/// that are all already catalogued it overwrote them with `[]`: 107 drafted
/// rows gone, from a run whose whole point was not to disturb anything.
const draftPath = (kind) => new URL(
  REPORT_PATH ? REPORT_PATH.replace(/([^/]+?)(\.json)?$/, `draft-${kind}.$1.json`)
              : `../survey/draft-${kind}.json`, import.meta.url);

async function gh(path, jq) {
  const argv = ["api", "-X", "GET", path];
  if (jq) argv.push("--jq", jq);
  const { stdout } = await run("gh", argv, { maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

async function ghJSON(path, jq) {
  try {
    const out = await gh(path, jq);
    return out ? JSON.parse(out) : null;
  } catch {
    return null;
  }
}

/// GitHub's search API, read to the end rather than to the end of page one.
///
/// **This is the bug that made the catalog look complete.** The sweep asked
/// for `per_page=100` and stopped, so a term matching 491 repositories
/// contributed 100 and the other 391 were invisible — not refused, not
/// reported, just never asked about. Across the seven original terms that was
/// 514 reachable repositories seen as 215, and 276 of them had never reached
/// the catalog in any form. A player searching for one of those mods got an
/// empty list, which is the same wrong answer as a mod being refused, with
/// none of the evidence.
///
/// Two things this must never do quietly. It must not stop early on an error,
/// because a short list is indistinguishable from a small result set and that
/// is exactly how the original bug hid; and it must not exceed the search
/// API's rate limit, which is 30 requests per minute and roughly a third of
/// what a full sweep now asks for.
const SEARCH_PAGE_LIMIT = 10;          // GitHub serves at most 1000 results.
const SEARCH_REQUESTS_PER_MINUTE = 30;
const SEARCH_INTERVAL_MS = Math.ceil(60_000 / SEARCH_REQUESTS_PER_MINUTE) + 100;

let lastSearchAt = 0;
async function pacedSearch(path, jq) {
  const wait = lastSearchAt + SEARCH_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastSearchAt = Date.now();
  return gh(path, jq);
}

async function searchAllPages(query, jq) {
  const found = [];
  for (let page = 1; page <= SEARCH_PAGE_LIMIT; page += 1) {
    let text;
    try {
      text = await pacedSearch(
        `search/repositories?q=${encodeURIComponent(query)}&per_page=100&page=${page}`, jq);
    } catch (error) {
      // Loudly. A sweep that swallows this returns a short list that looks
      // exactly like a complete one.
      throw new Error(
        `search for ${JSON.stringify(query)} failed on page ${page}: ${error.message}\n` +
        "  The repository list from this run would be incomplete, and an incomplete\n" +
        "  list silently removes mods from the catalog. Re-run when it recovers.");
    }
    const names = text.split("\n").filter(Boolean);
    found.push(...names);
    if (names.length < 100) break;
  }
  return found;
}

/// Every repository worth asking about, from both directions.
async function gatherRepos() {
  const repos = new Map();

  if (REPO_LIST) {
    const listed = (await readFile(REPO_LIST, "utf8"))
      .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    for (const name of listed) repos.set(name.replace(/\/+$/, ""), { indexed: null });
    console.log(`  from ${REPO_LIST}: ${repos.size} repositories (discovery skipped)`);
    return repos;
  }

  const feed = await fetch(INDEX_FEED).then((r) => r.json());
  for (const mod of feed.mods ?? []) {
    if (!mod.github) continue;
    repos.set(mod.github.replace(/\/+$/, ""), { indexed: mod });
  }
  console.log(`  official index: ${repos.size} mods`);

  for (const q of SEARCHES) {
    const names = await searchAllPages(q, ".items[] | select(.fork == false) | .full_name");
    for (const name of names) if (!repos.has(name)) repos.set(name, { indexed: null });
  }
  console.log(`  after search sweep: ${repos.size} repositories`);

  // Forks, which the sweep above cannot see. Two filters, because a fork is
  // one of three things and only the third is worth a download.
  const renamed = [];
  for (const q of FORK_SEARCHES) {
    const names = await searchAllPages(`fork:only ${q}`, ".items[] | .full_name");
    for (const name of names) {
      // 1. A bare engine clone. Nine in ten of them.
      if (ENGINE_CLONE_NAMES.test(name.split("/")[1] ?? "")) continue;
      if (repos.has(name)) continue;
      renamed.push(name);
    }
  }

  // 2. A personal copy of a mod that is ALREADY being surveyed. Renaming is
  // not enough to tell these apart -- `katalyste/g1rec-shiny-p` is a rename
  // of `masterwebx/gen1recomp-shiny-pokemon` -- and publishing both would put
  // two listings of one mod on the shelf under different names, which is the
  // catalog telling the player something untrue about how much exists.
  //
  // The parent answers it exactly. A fork of the ENGINE is somebody starting
  // a new mod from the engine (Stone696/nuzlocke), and that is a real find; a
  // fork of a mod already in the set is a copy of a listing we already have.
  // One core-API request each, at 5000 an hour against a few hundred forks.
  let forkCandidates = 0;
  for (const name of renamed) {
    // `gh` and not `ghJSON`: the jq yields a BARE `owner/repo`, which is not
    // JSON, so ghJSON would throw, swallow it and answer null for every fork
    // — leaving this filter looking like it ran and skipping nothing.
    const parent = (await gh(`repos/${name}`, ".parent.full_name // empty")
      .catch(() => "")).trim();
    if (parent && repos.has(parent)
        && !ENGINE_CLONE_NAMES.test(parent.split("/")[1] ?? "")) continue;
    repos.set(name, { indexed: null });
    forkCandidates += 1;
  }
  console.log(`  after fork sweep: ${repos.size} repositories `
              + `(+${forkCandidates} of ${renamed.length} renamed forks; `
              + `${renamed.length - forkCandidates} were copies of a mod already surveyed)`);
  return repos;
}

function cacheName(repo, asset) {
  return `${repo.replace("/", "__")}__${asset}`;
}

async function fetchAsset(repo, asset) {
  await mkdir(CACHE, { recursive: true });
  const name = cacheName(repo, asset.name);
  const file = new URL(name, CACHE);
  try {
    return await readFile(file);
  } catch {
    if (OFFLINE) return null;
  }
  const response = await fetch(asset.url, { redirect: "follow" });
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(file, bytes);
  return bytes;
}


/// Lua that writes to the love table, by file and line.
///
/// Deliberately a text scan and deliberately noisy: it cannot tell a real
/// callback assignment from one inside a comment or a string, so every hit is
/// read by a human. A quiet miss is the expensive direction here, because what
/// it misses is a crash on somebody's phone.
async function scanForLoveAssignments(path) {
  const dir = join(tmpdir(), `survey-scan-${Math.abs(hashPath(path))}`);
  try {
    await rm(dir, { recursive: true, force: true });
    await run("unzip", ["-qq", "-o", "-d", dir, path], { maxBuffer: 64 * 1024 * 1024 });
    // `function love.x(` and `love.x =` are the same write wearing two syntaxes.
    const { stdout } = await run("grep",
      ["-rnE", "(^|[^.\\w])love\\.[A-Za-z_]+[[:space:]]*=[^=]|function[[:space:]]+love\\.[A-Za-z_]+[[:space:]]*\\(",
       "--include=*.lua", dir],
      { maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
    // A mod's tests and build tools are not loaded by the engine, and they are
    // where a fake love table legitimately gets assembled. Counting those would
    // refuse mods for the contents of a directory the sandbox never opens.
    const NOT_LOADED = /(^|\/)(tests?|spec|tools?|\.github|examples?|docs?)\//i;
    return stdout.split("\n").filter(Boolean)
      .map((line) => line.replace(dir + "/", "").trim())
      .filter((line) => !NOT_LOADED.test(line))
      .slice(0, 20);
  } catch {
    return [];
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function hashPath(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}

/// What is inside the archive, read with `unzip` rather than a dependency.
///
/// The listing is the same thing RecompModLibrary reads from the central
/// directory: how many entries, and how much they expand to. Both are checked
/// before anything is inflated, because a hostile archive should be refused
/// without being unpacked.
async function inspect(path) {
  let listing;
  try {
    ({ stdout: listing } = await run("unzip", ["-l", path], { maxBuffer: 64 * 1024 * 1024 }));
  } catch {
    return { error: "not a readable zip" };
  }

  // Two names per entry, on purpose. Windows-made archives write "\\" where
  // the spec requires "/", and real mods ship that way — the app normalises
  // them at the point of binding. So the normalised name is what the layout
  // rules are applied to, and the raw one is what `unzip` must be asked for:
  // extracting "FOLLOWERS_EX/manifest.json" from an archive that stores
  // "FOLLOWERS_EX\\manifest.json" fails, and reads as "not a mod".
  const rows = listing.split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/))
    .filter(Boolean)
    .map((m) => ({ size: Number(m[1]), raw: m[2], name: m[2].replace(/\\/g, "/") }));

  const total = rows.reduce((sum, row) => sum + row.size, 0);
  const roms = rows.filter((row) =>
    ROM_EXTENSIONS.some((ext) => row.name.toLowerCase().endsWith(ext)));

  // The shallowest manifest.json anywhere in the archive.
  //
  // This used to insist on the root or one directory down, which is stricter
  // than the installer and therefore wrong in the direction that loses mods.
  // A release built by `git archive` nests everything under
  // `<name>-<version>/`, and a repo that keeps its mod in `mods/<id>/` then
  // sits three deep; the installer strips the common prefix and skips entries
  // outside the mod root, so it finds those. Reading them as "not a recomp
  // mod" hid a whole packaging convention, and the one that surfaced it was a
  // Chinese translation.
  //
  // Shallowest rather than first, because an archive can contain more than one
  // (a device pak carries the engine's own and a bundled mod's), and the
  // outermost is the one describing the thing being installed.
  const manifestRow = rows
    .filter((row) => (row.name.split("/").filter(Boolean).at(-1)) === "manifest.json")
    .sort((a, b) => a.name.split("/").length - b.name.split("/").length
                 || a.name.length - b.name.length)[0];

  // ...but no deeper than the installer will look.
  //
  // Mirrors RecompModLibrary.maxManifestDepth. Unbounded depth is not the
  // generous choice it looks like: it reaches inside a device package and
  // finds the mod somebody else bundled there, so a player who picked a pak
  // installs a mod they have never heard of under its author's name.
  //
  // The bound is drawn from this corpus rather than chosen: of 200 archives,
  // 165 keep the manifest at the root, 25 one directory down (what `git
  // archive` produces), NONE at depth 2, and the only two deeper are the pak
  // and a source tree. An empty band at 2 is the data drawing the line.
  //
  // **Keep this equal to the app's constant.** Looser here publishes listings
  // the installer refuses; stricter loses mods that install perfectly well.
  const manifestDepth = manifestRow
    ? manifestRow.name.split("/").filter(Boolean).length - 1
    : 0;
  const buriedManifest = manifestRow && manifestDepth > MAX_MANIFEST_DEPTH;

  let manifest = null;
  if (manifestRow && !buriedManifest) {
    try {
      // `unzip` reads its argument as a match pattern, in which a backslash
      // escapes the next character — so the literal name of a Windows-made
      // entry has to be escaped to be asked for by name at all.
      const pattern = manifestRow.raw.replace(/\\/g, "\\\\");
      const { stdout } = await run("unzip", ["-p", path, pattern],
        { maxBuffer: 16 * 1024 * 1024 });
      manifest = JSON.parse(stdout);
    } catch {
      manifest = { unreadable: true };
    }
  }

  // Assignments to a love callback, which load fine in a dev checkout and fail
  // on the engine we ship.
  //
  // The shipping sandbox (src/mods/Sandbox.lua) routes every write to the love
  // table through a legacy compat shim, and where that shim is absent the
  // write raises "mods cannot assign love.<key>". Upstream's own dev tree does
  // not have the rule, so this is precisely the mod that works everywhere its
  // author tested and dies on a player's phone.
  const loveAssignments = await scanForLoveAssignments(path);

  // An open licence asks for its text to travel with the distribution. Most
  // archives carry it; the catalog has to say truthfully which do, because the
  // ones that do not need the text carried alongside instead.
  const licenseInArchive = rows.some((row) =>
    /^(license|licence|copying)(\.\w+)?$/i.test(row.name.split("/").pop() ?? ""));

  return { entryCount: rows.length, totalUncompressed: total,
           romEntries: roms.map((r) => r.name), manifest, licenseInArchive,
           loveAssignments, buriedManifest: Boolean(buriedManifest),
           manifestPath: manifestRow?.name ?? null };
}

/// Everything that would stop this being offered as a one-tap install.
function refusals({ release, asset, contents }) {
  const out = [];
  // A tree archive answers the question a release would have answered, so it
  // is not missing anything: `asset` is set and `release` is null on purpose.
  if (!release && !asset) out.push("no release, and no archive committed to the tree");
  else if (release && !asset) out.push("no .zip in the latest release");
  if (!contents) return out.length ? out : ["archive could not be fetched"];
  if (contents.error) out.push(contents.error);
  if (contents.buriedManifest) {
    out.push(`its manifest sits at ${contents.manifestPath} — a larger package with a mod inside it, not a mod`);
  } else if (!contents.manifest) out.push("no manifest.json — not an installable mod");
  else if (contents.manifest.unreadable) out.push("manifest.json is not valid JSON");
  else if (!contents.manifest.id) out.push("manifest.json declares no id");
  if (contents.romEntries?.length) out.push(`contains a ROM (${contents.romEntries[0]})`);
  if (contents.loveAssignments?.length) {
    out.push(`writes to the love table (${contents.loveAssignments[0]}) — the shipping sandbox refuses this`);
  }
  if (contents.entryCount > MAX_ENTRY_COUNT)
    out.push(`${contents.entryCount} entries, over the ${MAX_ENTRY_COUNT} ceiling`);
  if (contents.totalUncompressed > MAX_TOTAL_UNCOMPRESSED)
    out.push(`expands to ${(contents.totalUncompressed / 1024 / 1024).toFixed(0)} MB`);
  return out;
}

/// How many archives one repository may contribute. A creator who publishes a
/// suite this way is the case being served; a repository with hundreds of zips
/// in it is something else, and downloading all of them is not a survey.
const MAX_TREE_ARCHIVES = 60;

/// Archives a creator committed to their repository instead of releasing.
///
/// **Not every mod is published through GitHub Releases, and the ones that are
/// not were invisible.** `FAFF0x/gen3recomp` carries 23 FireRed mods as zips
/// at the root of its default branch: no releases, no tags, and the official
/// index does not carry Gen 3 at all. The survey asked `releases/latest`,
/// found nothing, and wrote "no release" — a true sentence about the wrong
/// question.
///
/// **Pinned to the commit, never the branch.** A `.../main/mod.zip` URL serves
/// whatever that file becomes, so the SHA-256 the catalog publishes would stop
/// matching the moment the creator updates, and every install would refuse
/// (safely, and for no reason a player could act on). The commit form is
/// immutable: the bytes behind it are the bytes somebody looked at, which is
/// the whole of what CATALOG_POLICY means by pinning a hash. Phosphor still
/// hosts nothing — this is the creator's own file on the creator's own
/// hosting, exactly as tier 2 describes.
async function treeArchives(name, branch) {
  const head = (await gh(`repos/${name}/commits/${branch ?? "HEAD"}`, ".sha").catch(() => "")).trim();
  if (!head) return [];
  const tree = await ghJSON(`repos/${name}/git/trees/${head}`,
    "[.tree[] | select(.type == \"blob\") | {path, size}]");
  return (tree ?? [])
    // Root level only. A zip deeper in a tree is far more often a test
    // fixture, a vendored dependency or an artefact than a published mod, and
    // the flat path also keeps `cacheName` a filename rather than a path.
    .filter((entry) => /^[^/]+\.zip$/i.test(entry.path))
    .slice(0, MAX_TREE_ARCHIVES)
    .map((entry) => ({
      name: entry.path,
      // Not `archive.zip` from a link: the file itself, at a commit.
      url: `https://raw.githubusercontent.com/${name}/${head}/${entry.path}`,
      size: entry.size,
      commit: head,
    }));
}

async function surveyRepo(name, hint) {
  const meta = await ghJSON(`repos/${name}`,
    "{full_name, license:(.license.spdx_id // null), pushed_at, stars:.stargazers_count, "
    + "description, homepage, html_url, default_branch}");
  if (!meta) return [];

  // The licence file as GitHub itself resolves it. Guessing "/blob/HEAD/LICENSE"
  // is wrong often enough to matter — LICENSE.md, COPYING, a licence in a
  // subdirectory — and CATALOG_POLICY asks for a URL that actually shows the
  // licence, not one that plausibly would.
  const license = await ghJSON(`repos/${name}/license`,
    "{url:.html_url, spdx:.license.spdx_id, text:.content}");

  const release = await ghJSON(`repos/${name}/releases/latest`,
    "{tag:.tag_name, published:.published_at, body:.body, assets:[.assets[]|{name:.name, url:.browser_download_url, size:.size}]}");

  // **A zip beats a tarball, whatever order GitHub lists them in.**
  //
  // This used to take the first asset matching either, and the app installs
  // zips: Voxel Ascendant publishes `VASC-3.0.36-...tar.gz` ahead of
  // `Voxel-Ascendant-3.0.36.zip`, so the survey judged the tarball, reported
  // "not a readable zip", and a working, MIT-licensed, actively released mod
  // was refused for the order of a release page. A refusal earned by asset
  // ordering is the same silent loss as page-one pagination, one mod at a
  // time.
  const assets = release?.assets ?? [];
  const released = assets.find((a) => /\.zip$/i.test(a.name))
    ?? assets.find((a) => /\.tar\.gz$/i.test(a.name))
    ?? null;

  // A creator publishes one way or the other, and a release is the one a
  // version and a date can be read from, so it wins wherever there is one.
  // The tree is only asked about when a release answered nothing.
  const candidates = released
    ? [released]
    : (await treeArchives(name, meta.default_branch).catch(() => []));

  // A repository with no archive at all is still a result: it is a link-out,
  // or a repository that is not a mod, and both are things the report says.
  const archives = candidates.length ? candidates : [null];

  const rows = [];
  for (const asset of archives) {
    let contents = null;
    let sha256 = null;
    let bytes = null;
    if (asset && asset.size <= MAX_TOTAL_UNCOMPRESSED) {
      bytes = await fetchAsset(name, asset);
      if (bytes) {
        sha256 = createHash("sha256").update(bytes).digest("hex");
        contents = await inspect(new URL(cacheName(name, asset.name), CACHE).pathname);
      }
    }
    rows.push(rowFor({ name, hint, meta, license, release, asset, contents, sha256 }));
  }
  return rows;
}

function rowFor({ name, hint, meta, license, release, asset, contents, sha256 }) {
  const blocking = refusals({ release, asset, contents });
  const licensed = PERMISSIVE.has(meta.license);

  return {
    repo: name,
    inOfficialIndex: Boolean(hint.indexed),
    indexEntry: hint.indexed ?? null,
    license: meta.license,
    licenseUrl: license?.url ?? null,
    // Carried for the archives that do not ship their own copy: an open
    // licence asks for its text to travel with the distribution, and where the
    // zip omits it the catalog is what makes up the difference.
    licenseText: license?.text
      ? Buffer.from(license.text, "base64").toString("utf8").trim()
      : null,
    stars: meta.stars,
    pushedAt: meta.pushed_at,
    description: meta.description,
    homepage: meta.html_url,
    // A repository that publishes no releases has an empty releases page, and
    // sending a player there is worse than sending them to the front page.
    releasesPage: release ? `${meta.html_url}/releases` : meta.html_url,
    release: asset
      ? { tag: release?.tag ?? null,
          // A committed archive carries no release date. The repository's own
          // last push is the nearest true thing, and it is a date somebody can
          // check rather than today's date standing in for one.
          publishedAt: release?.published ?? meta.pushed_at,
          fileName: asset.name, fileUrl: asset.url,
          fileSizeBytes: asset.size, sha256,
          // Said plainly, so the report can be read without parsing the URL to
          // learn whether these bytes are pinned to a tag or to a commit.
          source: release ? "release" : "tree",
          ...(asset.commit ? { commit: asset.commit } : {}) }
      : null,
    contents: contents && !contents.error
      ? { modId: contents.manifest?.id ?? null,
          modVersion: contents.manifest?.version ?? null,
          manifest: contents.manifest,
          // The ROMs a mod is built from and the player has to bring, in the
          // compact shape the catalog publishes as `requirements.imports`:
          // a name and whether it is required. Surfaced here so the person
          // approving a row reads it BEFORE approving, because a mod that
          // needs a Stadium cartridge is a different listing from one that
          // needs nothing, and the raw block sits two hundred lines down a
          // manifest nobody scrolls. The hashes stay in `manifest` above, in
          // this gitignored report, and go no further.
          imports: importsFrom(contents.manifest),
          licenseInArchive: contents.licenseInArchive,
          loveAssignments: contents.loveAssignments ?? [],
          // Carried so the depth bound stays checkable from the report alone.
          // It is the evidence for RecompModLibrary.maxManifestDepth, and a
          // constant justified by a measurement nobody can re-take is a
          // constant justified by a memory of one.
          manifestPath: contents.manifestPath ?? null,
          buriedManifest: contents.buriedManifest ?? false,
          entryCount: contents.entryCount,
          totalUncompressed: contents.totalUncompressed }
      : null,
    blocking,
    // "unevaluated" is not "refused".
    //
    // An archive that could not be fetched has been judged on nothing, and
    // folding that into "skip" reads as a verdict about the mod. It bit here:
    // a re-run with --offline met a release cut that morning, could not fetch
    // the new asset, and quietly dropped a mod that had done nothing wrong.
    // On a real run the same shape is a network blip removing listings.
    verdict: blocking.includes("archive could not be fetched") ? "unevaluated"
      : blocking.length === 0 && licensed ? "installable"
      : hint.indexed ? "link-out"
      : "skip",
  };
}


/// Mods deliberately kept out of the catalog, and why.
///
/// Curation, not blocking: every one of these can still be sideloaded through
/// the + button. What is refused here is Phosphor putting its name on it.


/// The engine versions Phosphor actually ships, from LoveCore/GEN1RECOMP_VERSION
/// and LoveCore/GEN2RECOMP_VERSION in the app repo.
///
/// Update these when the app takes an engine bump. A stale value here does not
/// fail loudly: it publishes mods whose own manifest rules them out, and the
/// player gets a card that installs, switches on, and never loads.

/// The app's five shelves, plus the two this survey added.
///
/// The index's own vocabulary is wider than the catalog's, and squeezing it
/// down was losing things: a music replacement filed under "Art & Effects" and
/// a translation had nowhere at all to go, which is why neither had ever been
/// published.
const TOPICS_BY_CATEGORY = {
  // The index's own vocabulary, which its schema validates.
  GAMEPLAY: "GAMEPLAY", BALANCE: "GAMEPLAY",
  QOL: "QOL", TOOL: "QOL",
  UI: "UI",
  ART: "ART",
  AUDIO: "AUDIO",
  TRANSLATION: "TRANSLATION",
  CONTENT: "CONTENT", TOTAL_CONVERSION: "CONTENT",
  // What mods write in their own manifests, which is free text and reads like
  // it: sixteen spellings for five ideas.
  GRAPHICS: "ART", VISUAL: "ART", SPRITES: "ART",
  MECHANIC: "GAMEPLAY", MECHANICS: "GAMEPLAY", ITEMS: "GAMEPLAY",
  MINIGAME: "GAMEPLAY", QUEST: "CONTENT", DIALOGUE: "CONTENT",
  TWEAK: "QOL", UTILITY: "QOL", ACCESSIBILITY: "QOL",
  LOCALIZATION: "TRANSLATION", LOCALISATION: "TRANSLATION", LANGUAGE: "TRANSLATION",
  MUSIC: "AUDIO", SOUND: "AUDIO",
  // Held back on the Aug 24 sweep for having no shelf. A sprite pack is art;
  // the rest are one author's mods that declare no category at all, and a
  // missing category is not a reason to refuse a working mod. UNCATEGORIZED
  // is the fallback `topicFor` reaches when a manifest says nothing.
  "SPRITE PACK": "ART", SPRITE_PACK: "ART", SPRITEPACK: "ART",
};

/// Where a mod with no category of its own lands.
///
/// Refusing it was the old behaviour and it cost six working mods on one
/// sweep. QOL is the honest default: it is the shelf a player browses when
/// they do not know what they are looking for, and a mod that never said what
/// it was has not earned a louder one.
const TOPIC_WHEN_UNCATEGORIZED = "QOL";

/// Shelves decided by hand, for mods whose own category says nothing useful.
const TOPIC_OVERRIDES = {
  "yedidiapery/gen1recomp-infinite-repel": "QOL",
  // Its manifest says CONTENT, but it adds no content: it surfaces numbers the
  // game already tracks, on a screen that already exists.
  "miguelcjalmeida/HiddenStats": "UI",
};

/// The shelf a mod belongs on.
///
/// The index's categories are preferred over the manifest's because they are
/// curated against a fixed vocabulary, where `category` in a manifest is
/// whatever the author typed.
function topicFor(result) {
  const override = TOPIC_OVERRIDES[result.repo];
  if (override) return override;
  for (const category of result.indexEntry?.categories ?? []) {
    const topic = TOPICS_BY_CATEGORY[String(category).toUpperCase()];
    if (topic) return topic;
  }
  const own = String(result.contents?.manifest?.category ?? "").toUpperCase();
  if (TOPICS_BY_CATEGORY[own]) return TOPICS_BY_CATEGORY[own];
  // A manifest that names no category at all still describes a working mod.
  // Refusing it was the old behaviour; see TOPIC_WHEN_UNCATEGORIZED.
  if (!own) return TOPIC_WHEN_UNCATEGORIZED;
  return null;
}

/// Which engine's save world a mod belongs to.
///
/// `games` names games, not engines, and the two do not line up: Gold under
/// gen1recomp++ is still the Gen 1 engine, so a bare "gold" says nothing about
/// Gen2Recomped. Only an explicit "gen2" moves a mod to the other channel.
function channelsFor(manifest) {
  // ONE channel, because one engine ships and it runs both generations.
  //
  // This used to route `games: ["gen2"]` to a "gen2recomp" channel, which was
  // right while a second engine existed and became wrong the moment gen1recomp
  // declared silver (v0.2.12) and crystal (v0.2.24). The cost was invisible
  // and specific: six Gen 2 mods -- the exact mods a Crystal owner wants --
  // were filtered out for naming an engine we no longer ship, and the skip
  // line blamed their engine VERSION, so the report read "needs engine
  // undefined" for a mod whose only sin was saying "gen2".
  //
  // Which GAMES a mod covers is a different question and is answered
  // elsewhere: enrich-catalog's `cartridgesFor`, published as
  // `requirements.games` and drawn as "For Red, Blue and Yellow only."
  void manifest;
  return ["gen1recomp"];
}

/// What a listing's `target` says, for the channels it supports.
///
/// Deliberately one of the three spellings in ENGINE_BY_TARGET and not a
/// fourth: the drafted string has to be one the catalog can turn back into a
/// family. A human narrowing it by hand afterwards ("Gen1Recomp · Yellow") is
/// expected and fine, as long as they use a spelling the table knows, which is
/// what auditCatalogTargets checks on the next run.
function targetFor(channels) {
  return channels.includes("gen2recomp") && channels.includes("gen1recomp")
    ? "Gen1Recomp and Gen2Recomped"
    : channels[0] === "gen2recomp" ? "Gen2Recomped" : "Gen1Recomp";
}

const humanSize = (bytes) => bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
  : `${(bytes / 1024).toFixed(1)} KB`;

/// Draft catalog rows for everything that cleared the bar.
///
/// Drafts, not entries: the taglines are placeholders and every row wants a
/// human to read it. What is mechanical here — the hash, the byte count, the
/// mod id, the licence evidence — is exactly what a human is worst at copying
/// by hand, and what CATALOG_POLICY requires to be exact.
const slug = (text) =>
  String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/// How a listing is recognised again on a later survey: the repository, and
/// the mod inside it where the archive names one.
const listingKey = (repo, modId) =>
  `${String(repo).toLowerCase()}#${String(modId).toLowerCase()}`;

/// Whether this repository contributed more than one surveyed archive.
///
/// Only then does the mod id belong in the listing's id. A repository that
/// publishes one mod keeps the id the catalog already uses for it, so a
/// re-survey does not rename every existing row and orphan its enrichment.
const oneOfMany = (row, results) =>
  results.filter((other) => other.repo === row.repo && other.contents?.modId).length > 1;

function draftRows(results) {
  const rows = [];
  const skipped = [];
  for (const r of results) {
    if (r.verdict !== "installable") continue;
    if (EXCLUDED[r.repo]) { skipped.push({ repo: r.repo, why: EXCLUDED[r.repo] }); continue; }
    const manifest = r.contents.manifest ?? {};
    const topic = topicFor(r);
    if (!topic) {
      const own = manifest.category ?? "(none)";
      skipped.push({ repo: r.repo, why: `category ${own} has no shelf — add it to TOPICS_BY_CATEGORY or TOPIC_OVERRIDES` });
      continue;
    }
    // The engines this mod is FOR. An engine Phosphor no longer ships is not
    // a shelf, so that half still filters; the half that asked whether the
    // mod accepts the version we ship does not, since 23 Sep 2026.
    //
    // It used to skip a mod whose `game_version` ruled out our engine, on the
    // reasoning that such a row is a card which installs and never loads.
    // Colson's call was to drop it: "make sure we aren't gated by anything and
    // we can try mods that are newer than the gate." For an engine shipping
    // several releases a day, that gate mostly caught authors who had moved
    // faster than this catalog's pin, and silently. The range is still
    // published on the row and the app labels the fit from it.
    const channels = channelsFor(manifest).filter((channel) => ENGINE_VERSIONS[channel]);
    if (channels.length === 0) {
      skipped.push({ repo: r.repo,
        why: `targets no engine Phosphor ships (${Object.keys(ENGINE_VERSIONS).join(", ") || "none"})` });
      continue;
    }
    if (!satisfies(ENGINE_VERSIONS[channels[0]], manifest.game_version)) {
      console.log(`  ahead of our engine, drafted anyway  ${r.repo} — needs ${manifest.game_version}`);
    }
    rows.push({
      // The repository names the listing, EXCEPT where one repository
      // publishes several mods: 23 rows all called `gen3recomp` would be one
      // id taken 23 times, and the row that won would be whichever was written
      // last. The mod's own id is what tells them apart, and it is also what
      // apply-survey.mjs matches a later release against.
      id: slug(r.contents.modId && oneOfMany(r, results)
        ? `${r.repo.split("/")[1]}-${r.contents.modId}`
        : r.repo.split("/")[1]),
      title: manifest.name ?? r.indexEntry?.title ?? r.repo.split("/")[1],
      creator: manifest.author ?? r.indexEntry?.author ?? r.repo.split("/")[0],
      version: r.contents.modVersion ?? "",
      releaseDate: (r.release.publishedAt ?? "").slice(0, 10),
      category: channels[0],
      compatibility: channels,
      target: targetFor(channels),
      // Structured beside the free-text `target`, because the app filters on
      // it. A drafted row carries it so the row a human pastes into src/data
      // is already complete; build-manifest.mjs derives it again from the
      // pasted row rather than trusting this copy, so an edited target string
      // cannot leave a stale family behind it.
      engine: engineFacet({ target: targetFor(channels), channels, label: r.repo }),
      summary: "TODO tagline — one line, a whole sentence, no truncation",
      // The long prose the detail screen renders. The manifest's own words
      // first, because they are the author's; the index summary and the repo
      // description are what is left when a manifest carries none.
      description: manifest.description?.trim()
        || r.indexEntry?.summary?.trim()
        || r.description?.trim()
        || "",
      fileUrl: r.release.fileUrl,
      fileName: r.release.fileName,
      fileSize: humanSize(r.release.fileSizeBytes),
      fileSizeBytes: r.release.fileSizeBytes,
      sha256: r.release.sha256,
      homepageUrl: r.homepage,
      permission: "open-license",
      license: r.license,
      licenseIncluded: r.contents.licenseInArchive === true,
      ...(r.contents.licenseInArchive === true ? {} : { licenseText: r.licenseText }),
      permissionEvidenceUrl: r.licenseUrl,
      containsRom: false,
      images: [],
      modId: r.contents.modId,
      topic,
    });
  }
  return { rows, skipped };
}


/// Draft index rows: catalogued, linked, and deliberately not installable.
///
/// Membership of the official index is the bar. It is somebody else's
/// judgement that a mod is real and works, which is the only quality signal
/// available for something the catalog cannot download, hash or install.
///
/// The link goes to the releases page rather than the repository root wherever
/// there is one. A decomp mod's front page offers a source tree, and its most
/// obvious download button hands over an assembly tree rather than the mod, so
/// an unqualified repository link sends players somewhere useless.
function draftProjects(results, alreadyListed, takenIds) {
  const rows = [];
  for (const r of results) {
    if (r.verdict !== "link-out" && r.verdict !== "skip") continue;
    // Two ways to earn a link-out.
    //
    // Membership of the official index is somebody else's judgement that a mod
    // is real. Better, where we have it, is our own: the archive was
    // downloaded and opened, it declares a mod id, and nothing about it would
    // stop it running here. That is a stronger signal than curation, and it
    // reaches the mods the gen1 index has never heard of — every Gen 2 mod,
    // and most of the translations, which is a language's worth of players
    // each.
    //
    // `blocking` empty is the load-bearing half: it means the archive carries
    // no ROM, sits inside the installer's ceilings, keeps its manifest where
    // the installer looks, does not write to the love table, and does not rule
    // out the engine we ship. A link-out to something that cannot work here
    // would be a dead end dressed as a discovery.
    const verifiedRealMod = Boolean(r.contents?.modId) && r.blocking.length === 0;
    if (!r.inOfficialIndex && !verifiedRealMod) continue;
    // A mod the catalog already carries. Asked of the mod where the archive
    // names one, so a suite's other mods are not mistaken for this one.
    const known = r.contents?.modId
      ? alreadyListed.has(listingKey(r.repo, r.contents.modId))
      : alreadyListed.has(r.repo.toLowerCase());
    if (known) continue;
    if (EXCLUDED[r.repo]) continue;

    const manifest = r.contents?.manifest ?? {};
    const channels = channelsFor(manifest);
    // The manifest's own description is the last resort and a good one: a
    // repo with no GitHub description used to be dropped here outright, which
    // lost eight clean mods on Sep 19 2026, Crystal 251 and the Stadium 2
    // importer among them, for the want of a sentence they had written
    // themselves, one file down.
    const summary = (r.indexEntry?.summary ?? r.description ?? manifest.description ?? "").trim();
    if (!summary) continue;

    // Two people really do name their repositories the same thing: a link-out
    // to thorkdev/gen1recomp-running-shoes collided with the published
    // MadeinTaly mod of that name, which are different mods. The owner
    // disambiguates, and only where it has to, so existing ids stay stable.
    //
    // One repository publishing several mods is the other way ids collide,
    // and the owner cannot separate those — 23 mods from FAFF0x/gen3recomp
    // all wanted `gen3recomp` and then all wanted `faff0x-gen3recomp`. The
    // mod's own id is the only thing that tells them apart.
    const [owner, name] = r.repo.split("/");
    let id = slug(oneOfMany(r, results) ? `${name}-${r.contents.modId}` : name);
    if (takenIds.has(id)) id = `${slug(owner)}-${id}`;
    takenIds.add(id);

    rows.push({
      id,
      title: r.indexEntry?.title ?? manifest.name ?? r.repo.split("/")[1],
      creator: r.indexEntry?.author ?? manifest.author ?? r.repo.split("/")[0],
      kind: "mod",
      category: channels[0],
      compatibility: channels,
      target: targetFor(channels),
      engine: engineFacet({ target: targetFor(channels), channels, label: r.repo }),
      summary,
      homepageUrl: r.homepage,
      // Which mod inside the repository this row is. One repository can
      // publish a suite, and then the homepage no longer identifies a listing:
      // this is what stops the second mod being read as a duplicate of the
      // first, here and in promote-direct-source.mjs.
      ...(r.contents?.modId ? { modId: r.contents.modId } : {}),
      ...(r.release ? { releasesUrl: r.releasesPage } : {}),
      // Nothing has been asked of these creators and nothing has been granted.
      // The other two statuses would both claim a conversation that has not
      // happened.
      reviewStatus: "permission-needed",
    });
  }
  return rows;
}

/// Every hand-typed `target` already in the catalog, checked against the table
/// that turns it into an engine family.
///
/// This runs FIRST, before a single request, because it is the cheapest thing
/// here and the only one that can fail for a reason a person can fix in ten
/// seconds. It is also why the mapping lives on this side at all: the survey
/// is the script a human runs while editing the catalog, so a tenth spelling
/// of "Gen1Recomp" stops here, in front of the person who typed it, rather
/// than reaching a shipped app as a mod its engine filter quietly hides.
///
/// ROM-hack rows are not checked and must not be: their `target` names a
/// cartridge, and no engine filter has anything to say about it.
async function auditCatalogTargets() {
  const errors = [];
  for (const file of ["../src/data/releases.json", "../src/data/projects.json"]) {
    const rows = JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
    errors.push(...auditTargets(rows, file.replace("../src/data/", "")));
  }
  if (errors.length === 0) return;
  console.error("The catalog holds a target string this survey cannot read:\n");
  for (const error of errors) console.error(`  - ${error}`);
  console.error("");
  process.exit(1);
}

async function main() {
  await auditCatalogTargets();

  console.log("Gathering repositories…");
  const repos = await gatherRepos();

  const results = [];
  let n = 0;
  for (const [name, hint] of repos) {
    if (n >= LIMIT) break;
    n += 1;
    process.stdout.write(`  [${n}/${Math.min(repos.size, LIMIT)}] ${name}\r`);
    // One repository can publish a whole suite as committed archives, so this
    // is a list: 23 FireRed mods arrive from `FAFF0x/gen3recomp` alone.
    const rows = await surveyRepo(name, hint).catch(() => []);
    results.push(...rows);
  }
  console.log("\n");

  await mkdir(new URL("../survey/", import.meta.url), { recursive: true });
  await writeFile(REPORT, JSON.stringify(results, null, 2) + "\n");

  const count = (verdict) => results.filter((r) => r.verdict === verdict).length;
  console.log(`  installable  ${count("installable")}`);
  console.log(`  link-out     ${count("link-out")}`);
  console.log(`  skip         ${count("skip")}`);
  if (count("unevaluated")) {
    console.log(`  UNEVALUATED  ${count("unevaluated")} — fetched nothing, judged nothing:`);
    for (const r of results.filter((r) => r.verdict === "unevaluated")) {
      console.log(`               ${r.repo}`);
    }
  }
  console.log(`\nWritten to survey/report.json`);

  const { rows, skipped } = draftRows(results);
  await writeFile(draftPath("releases"),
                  JSON.stringify(rows, null, 2) + "\n");
  console.log(`\n  ${rows.length} rows drafted to survey/draft-releases.json`);
  for (const s of skipped) console.log(`  held back  ${s.repo} — ${s.why}`);

  // Said out loud, for every surveyed mod and not only the drafted ones: the
  // engine refuses these until the player supplies the file, so it is the
  // first thing to know about a row and the last thing a hash can tell you.
  // `scripts/backfill-mod-imports.mjs` is what publishes it.
  for (const r of results) {
    const imports = r.contents?.imports;
    if (!imports?.length) continue;
    const list = imports.map((i) => `${i.name}${i.required ? "" : " (optional)"}`).join(", ");
    console.log(`  needs a file from the player  ${r.repo} — ${list}`);
  }

  // What is already listed, by repository AND by the mod inside it.
  //
  // The repository alone was enough while a repository meant a mod. It stopped
  // being enough with a suite: once one of FAFF0x/gen3recomp's 23 mods was
  // listed, the repository counted as covered and the other 22 — and every mod
  // added to it later — would be dropped from the drafts as already known.
  // Recording the mod id too keeps each one its own answer.
  const listed = new Set();
  for (const file of ["../src/data/releases.json", "../src/data/projects.json"]) {
    const existing = JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
    for (const row of existing) {
      const url = String(row.homepageUrl ?? "");
      if (!url.startsWith("https://github.com/")) continue;
      const repo = url.replace("https://github.com/", "").toLowerCase();
      listed.add(repo);
      const modId = row.modId ?? row.directSource?.modId;
      if (modId) listed.add(listingKey(repo, modId));
    }
  }
  for (const row of rows) {
    const repo = row.homepageUrl.replace("https://github.com/", "").toLowerCase();
    listed.add(repo);
    if (row.modId) listed.add(listingKey(repo, row.modId));
  }

  // Every id already spoken for, so a new listing cannot quietly take one.
  const takenIds = new Set();
  for (const file of ["../src/data/releases.json", "../src/data/projects.json"]) {
    const existing = JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
    for (const row of existing) if (row.id) takenIds.add(row.id);
  }
  for (const row of rows) takenIds.add(row.id);

  const projects = draftProjects(results, listed, takenIds);
  await writeFile(draftPath("projects"),
                  JSON.stringify(projects, null, 2) + "\n");
  console.log(`  ${projects.length} link-outs drafted to survey/draft-projects.json`);

  const cached = await readdir(CACHE).catch(() => []);
  console.log(`\n${cached.length} archives cached under survey/cache/`);
}

await main();
