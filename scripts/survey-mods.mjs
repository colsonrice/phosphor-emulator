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

const run = promisify(execFile);

const INDEX_FEED = "https://bryanthaboi.github.io/gen1recomp-mod-index/data/index.json";

/// Search terms for mods the official index has never heard of. The index is
/// gen1recomp's, so every Gen 2 mod in existence is invisible to it.
const SEARCHES = [
  "gen1recomp", "gen1recomp mod", "gen2recomp", "gen2recomped",
  "pokemon recomp mod", "topic:gen1recomp", "topic:gen2recomp",
];

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
const MAX_TOTAL_UNCOMPRESSED = 512 * 1024 * 1024;

/// A ROM inside a mod archive is the one thing that can never be published,
/// whatever the licence says: an author's permission over their own mod grants
/// nothing over Nintendo's cartridge.
const ROM_EXTENSIONS = [".gb", ".gbc", ".gba", ".sgb"];

const CACHE = new URL("../survey/cache/", import.meta.url);
const REPORT = new URL("../survey/report.json", import.meta.url);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const OFFLINE = flag("--offline");
const LIMIT = Number(value("--limit")) || Infinity;

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

/// Every repository worth asking about, from both directions.
async function gatherRepos() {
  const repos = new Map();

  const feed = await fetch(INDEX_FEED).then((r) => r.json());
  for (const mod of feed.mods ?? []) {
    if (!mod.github) continue;
    repos.set(mod.github.replace(/\/+$/, ""), { indexed: mod });
  }
  console.log(`  official index: ${repos.size} mods`);

  for (const q of SEARCHES) {
    // A --jq filter yielding bare names prints them newline-separated rather
    // than as a JSON array, so this reads the text rather than parsing it.
    const names = (await gh(`search/repositories?q=${encodeURIComponent(q)}&per_page=100`,
      ".items[] | select(.fork == false and .archived == false) | .full_name")
      .catch(() => "")).split("\n").filter(Boolean);
    for (const name of names) if (!repos.has(name)) repos.set(name, { indexed: null });
  }
  console.log(`  after search sweep: ${repos.size} repositories`);
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

  let manifest = null;
  if (manifestRow) {
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
           loveAssignments };
}

/// Everything that would stop this being offered as a one-tap install.
function refusals({ release, asset, contents }) {
  const out = [];
  if (!release) out.push("no release");
  else if (!asset) out.push("no .zip in the latest release");
  if (!contents) return out.length ? out : ["archive could not be fetched"];
  if (contents.error) out.push(contents.error);
  if (!contents.manifest) out.push("no manifest.json — not an installable mod");
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

async function surveyRepo(name, hint) {
  const meta = await ghJSON(`repos/${name}`,
    "{full_name, license:(.license.spdx_id // null), pushed_at, stars:.stargazers_count, description, homepage, html_url}");
  if (!meta) return null;

  // The licence file as GitHub itself resolves it. Guessing "/blob/HEAD/LICENSE"
  // is wrong often enough to matter — LICENSE.md, COPYING, a licence in a
  // subdirectory — and CATALOG_POLICY asks for a URL that actually shows the
  // licence, not one that plausibly would.
  const license = await ghJSON(`repos/${name}/license`,
    "{url:.html_url, spdx:.license.spdx_id, text:.content}");

  const release = await ghJSON(`repos/${name}/releases/latest`,
    "{tag:.tag_name, published:.published_at, body:.body, assets:[.assets[]|{name:.name, url:.browser_download_url, size:.size}]}");

  const asset = release?.assets?.find((a) => /\.(zip|tar\.gz)$/i.test(a.name)) ?? null;

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
    releasesPage: `${meta.html_url}/releases`,
    release: release && asset
      ? { tag: release.tag, publishedAt: release.published,
          fileName: asset.name, fileUrl: asset.url,
          fileSizeBytes: asset.size, sha256 }
      : null,
    contents: contents && !contents.error
      ? { modId: contents.manifest?.id ?? null,
          modVersion: contents.manifest?.version ?? null,
          manifest: contents.manifest,
          licenseInArchive: contents.licenseInArchive,
          loveAssignments: contents.loveAssignments ?? [],
          entryCount: contents.entryCount,
          totalUncompressed: contents.totalUncompressed }
      : null,
    blocking,
    verdict: blocking.length === 0 && licensed ? "installable"
      : hint.indexed ? "link-out"
      : "skip",
  };
}


/// Mods deliberately kept out of the catalog, and why.
///
/// Curation, not blocking: every one of these can still be sideloaded through
/// the + button. What is refused here is Phosphor putting its name on it.
const EXCLUDED = {
  "gamecorner-033/Gen1Online":
    "an in-app MMO with chat, PvP and a poker lounge — 4.7.1 would require content filtering, reporting and blocking abusive users, none of which Phosphor can offer for someone else's server",
  "tebwritescode/gen1mmo":
    "a shared public world with chat, carrying the same 4.7.1 duties",
  "tebwritescode/savesync":
    "uploads the player's save to a public server; save custody is the app's own responsibility and not a thing to hand off in a listing",
  "mresnick67/Gen1ReComp-Pokewalker":
    "needs a companion iOS app and a step feed the sandbox does not provide, so the listing would promise something that cannot work here",
  "dburton95/crystal":
    "a sprite replacement that asks for the network permission; harmless or not, a cosmetic mod wanting the network is not something to wave through",
  "DavidSchuchert/gen1-voxel-dex":
    "hard dependency on DRAMATIC_SHAPE, which the catalog does not carry — it would install and do nothing",
  "masterwebx/gen1recomp-followers-ex":
    "hard dependencies on PokePCFollowers_VoxelMerge and overworld_wild_spawns, neither of them catalogued",
  "eduardocalafell/gen1recomp-player-sprite-flip":
    "flips a sprite in the Dramatic Shape voxel battle specifically; with no Dramatic Shape in the catalog there is nothing for it to flip",
  "randyadr/Gen1-Recomp-HD-Grass":
    "replaces grass objects inside DramaticShapes; with no voxel mod catalogued there is nothing for it to decorate",
};


/// The engine versions Phosphor actually ships, from LoveCore/GEN1RECOMP_VERSION
/// and LoveCore/GEN2RECOMP_VERSION in the app repo.
///
/// Update these when the app takes an engine bump. A stale value here does not
/// fail loudly: it publishes mods whose own manifest rules them out, and the
/// player gets a card that installs, switches on, and never loads.
const ENGINE_VERSIONS = { gen1recomp: "0.2.1", gen2recomp: "0.7.6" };

/// Enough semver to read a `game_version` range.
///
/// Ranges in the wild look like ">=0.1.37 <2.0.0", "0.0.0-dev || >=0.1.99 <2.0.0"
/// and "0.1.94-kanto.22". Prerelease tags are compared on their numeric core:
/// the engine's own tags are build markers, not the ordering npm assumes, and
/// treating "0.0.0-0" as lower than every release would exclude everything.
function parseVersion(text) {
  const [core] = String(text).trim().split("-");
  const [major = 0, minor = 0, patch = 0] = core.split(".").map((n) => parseInt(n, 10) || 0);
  return [major, minor, patch];
}

function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

function satisfies(version, range) {
  if (!range || !String(range).trim()) return true;
  return String(range).split("||").some((clause) =>
    clause.trim().split(/\s+/).filter(Boolean).every((comparator) => {
      const m = comparator.match(/^(>=|<=|>|<|=)?(.+)$/);
      if (!m) return false;
      const [, op = "=", target] = m;
      const c = compareVersions(version, target);
      switch (op) {
        case ">=": return c >= 0;
        case "<=": return c <= 0;
        case ">": return c > 0;
        case "<": return c < 0;
        default: return c === 0;
      }
    }));
}

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
};

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
  return TOPICS_BY_CATEGORY[own] ?? null;
}

/// Which engine's save world a mod belongs to.
///
/// `games` names games, not engines, and the two do not line up: Gold under
/// gen1recomp++ is still the Gen 1 engine, so a bare "gold" says nothing about
/// Gen2Recomped. Only an explicit "gen2" moves a mod to the other channel.
function channelsFor(manifest) {
  const games = (manifest.games ?? []).map((g) => String(g).toLowerCase());
  const channels = [];
  if (games.includes("gen2")) channels.push("gen2recomp");
  if (games.length === 0 || games.some((g) =>
    ["gen1", "all", "red", "blue", "yellow", "gold", "silver", "crystal"].includes(g))) {
    channels.unshift("gen1recomp");
  }
  return channels.length ? channels : ["gen1recomp"];
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
    // A mod that rules out the engine we ship is not a listing, it is a card
    // that installs and never loads. Checked per channel, because the two
    // engines version independently.
    const channels = channelsFor(manifest)
      .filter((channel) => satisfies(ENGINE_VERSIONS[channel], manifest.game_version));
    if (channels.length === 0) {
      skipped.push({ repo: r.repo,
        why: `needs engine ${manifest.game_version}, and we ship gen1recomp ${ENGINE_VERSIONS.gen1recomp} / gen2recomp ${ENGINE_VERSIONS.gen2recomp}` });
      continue;
    }
    rows.push({
      id: r.repo.split("/")[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      title: manifest.name ?? r.indexEntry?.title ?? r.repo.split("/")[1],
      creator: manifest.author ?? r.indexEntry?.author ?? r.repo.split("/")[0],
      version: r.contents.modVersion ?? "",
      releaseDate: (r.release.publishedAt ?? "").slice(0, 10),
      category: channels[0],
      compatibility: channels,
      target: channels.includes("gen2recomp") && channels.includes("gen1recomp")
        ? "Gen1Recomp and Gen2Recomped"
        : channels[0] === "gen2recomp" ? "Gen2Recomped" : "Gen1Recomp",
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
function draftProjects(results, alreadyListed) {
  const rows = [];
  for (const r of results) {
    if (r.verdict !== "link-out") continue;
    if (!r.inOfficialIndex) continue;
    if (alreadyListed.has(r.repo.toLowerCase())) continue;
    if (EXCLUDED[r.repo]) continue;

    const manifest = r.contents?.manifest ?? {};
    const channels = channelsFor(manifest);
    const summary = (r.indexEntry?.summary ?? r.description ?? "").trim();
    if (!summary) continue;

    rows.push({
      id: r.repo.split("/")[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      title: r.indexEntry?.title ?? manifest.name ?? r.repo.split("/")[1],
      creator: r.indexEntry?.author ?? manifest.author ?? r.repo.split("/")[0],
      kind: "mod",
      category: channels[0],
      compatibility: channels,
      target: channels.includes("gen2recomp") && channels.includes("gen1recomp")
        ? "Gen1Recomp and Gen2Recomped"
        : channels[0] === "gen2recomp" ? "Gen2Recomped" : "Gen1Recomp",
      summary,
      homepageUrl: r.homepage,
      ...(r.release ? { releasesUrl: r.releasesPage } : {}),
      // Nothing has been asked of these creators and nothing has been granted.
      // The other two statuses would both claim a conversation that has not
      // happened.
      reviewStatus: "permission-needed",
    });
  }
  return rows;
}

async function main() {
  console.log("Gathering repositories…");
  const repos = await gatherRepos();

  const results = [];
  let n = 0;
  for (const [name, hint] of repos) {
    if (n >= LIMIT) break;
    n += 1;
    process.stdout.write(`  [${n}/${Math.min(repos.size, LIMIT)}] ${name}\r`);
    const row = await surveyRepo(name, hint).catch(() => null);
    if (row) results.push(row);
  }
  console.log("\n");

  await mkdir(new URL("../survey/", import.meta.url), { recursive: true });
  await writeFile(REPORT, JSON.stringify(results, null, 2) + "\n");

  const count = (verdict) => results.filter((r) => r.verdict === verdict).length;
  console.log(`  installable  ${count("installable")}`);
  console.log(`  link-out     ${count("link-out")}`);
  console.log(`  skip         ${count("skip")}`);
  console.log(`\nWritten to survey/report.json`);

  const { rows, skipped } = draftRows(results);
  await writeFile(new URL("../survey/draft-releases.json", import.meta.url),
                  JSON.stringify(rows, null, 2) + "\n");
  console.log(`\n  ${rows.length} rows drafted to survey/draft-releases.json`);
  for (const s of skipped) console.log(`  held back  ${s.repo} — ${s.why}`);

  const listed = new Set();
  for (const file of ["../src/data/releases.json", "../src/data/projects.json"]) {
    const existing = JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
    for (const row of existing) {
      const url = String(row.homepageUrl ?? "");
      if (url.startsWith("https://github.com/")) {
        listed.add(url.replace("https://github.com/", "").toLowerCase());
      }
    }
  }
  for (const row of rows) listed.add(row.homepageUrl.replace("https://github.com/", "").toLowerCase());

  const projects = draftProjects(results, listed);
  await writeFile(new URL("../survey/draft-projects.json", import.meta.url),
                  JSON.stringify(projects, null, 2) + "\n");
  console.log(`  ${projects.length} link-outs drafted to survey/draft-projects.json`);

  const cached = await readdir(CACHE).catch(() => []);
  console.log(`\n${cached.length} archives cached under survey/cache/`);
}

await main();
