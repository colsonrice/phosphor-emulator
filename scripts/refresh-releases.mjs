// Moves every installable row to its creator's latest release, where that
// release clears the same bar the pinned one did.
//
// A listing pins the SHA-256 of bytes that were downloaded and inspected, and
// nothing here ever moved that pin again. On Sep 19 2026, 61 of 217 installable
// rows were behind their own repo, some by forty releases, and one could not
// load on the engine Phosphor ships because upstream had since removed a
// module it required. Engines have an hourly workflow; mods had nothing.
//
// What this does, per row: ask GitHub for the repo's latest release, pick its
// .zip, and when that is not the release already pinned, download it into
// survey/cache/ and run the SURVEY'S checks over it (`inspect` and `refusals`,
// imported, not copied): no ROM, a manifest no deeper than the installer looks,
// the entry and size ceilings, no writes to the love table. On top of those,
// the things only a refresh can get wrong: the modId must be the one the row
// pins, the release must not rule out the engine we ship, a tier 1 repo must
// still be under the licence its listing names, and the release must not have
// started needing the network or a mod the catalog does not carry.
//
// **A row whose new archive fails anything keeps its old pin.** It is reported
// with the reason and nothing about it is written. The old release is still
// the last one somebody looked at, and an out-of-date mod that installs beats
// a current one that does not.
//
// Usage:
//   node scripts/refresh-releases.mjs                  dry run, report only
//   node scripts/refresh-releases.mjs --write          save the rows that passed
//   node scripts/refresh-releases.mjs --only id,id     look at these rows only
//
// After a --write, in this order:
//   node scripts/verify-releases.mjs          re-downloads and re-hashes tier 1
//   node scripts/backfill-mod-imports.mjs --write
//   npm run build:manifest && npm test && npm run check:catalog && npm run lint
//
// Requires the `gh` CLI, authenticated, like the survey.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { cacheNameFor } from "./backfill-mod-imports.mjs";
import { ENGINE_VERSIONS } from "./engine-family.mjs";
import { requirementsFrom, requiresFrom, usesNetwork } from "./enrich-catalog.mjs";
import { satisfies } from "./lib/semver.mjs";
import {
  gh, humanSize, inspect, refusals, MAX_TOTAL_UNCOMPRESSED, PERMISSIVE,
} from "./survey-mods.mjs";

const RELEASES = new URL("../src/data/releases.json", import.meta.url);
const PROJECTS = new URL("../src/data/projects.json", import.meta.url);
const ENRICHMENT = new URL("../src/data/enrichment.json", import.meta.url);
const CACHE = fileURLToPath(new URL("../survey/cache/", import.meta.url));
const REPORT = new URL("../survey/refresh-report.json", import.meta.url);

/// The one engine every listed mod installs into. See `channelsFor` in the
/// survey for why there is no second one to ask about.
const ENGINE = "gen1recomp";

const ASSET_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/?#]+)$/;

/// What a row pins, read the same way out of either tier.
///
/// Tier 1 keeps its install data on the row and tier 2 keeps it under
/// `directSource`, with different names for the same facts. Everything below
/// asks one question of both, so they are flattened here and nowhere else.
/// `null` for a row with nothing to refresh: a link-out, or a file that is not
/// a GitHub release asset and so has no "latest" to compare against.
export function pinOf(row) {
  const direct = row?.directSource ?? null;
  const from = direct ?? row ?? {};
  const m = ASSET_URL.exec(from.fileUrl ?? "");
  if (!m) return null;
  return {
    tier: direct ? 2 : 1,
    repo: `${m[1]}/${m[2]}`,
    tag: decodeURIComponent(m[3]),
    fileUrl: from.fileUrl,
    fileName: direct ? decodeURIComponent(m[4]) : row.fileName,
    sha256: from.sha256,
    fileSizeBytes: from.fileSizeBytes,
    modId: from.modId,
    version: from.version,
  };
}

/// Which asset of a release is the mod.
///
/// One .zip is the answer whatever it is called now; authors rename. Several
/// is where the survey's "first one" stops being good enough, because the
/// first zip of a release that also ships a source bundle or a desktop build
/// is whichever the author uploaded first. So the pinned file's own name
/// decides, compared with its digits masked, since version numbers are what
/// legitimately change. No single match is a person's call, not a guess.
export function pickAsset(assets, pinnedFileName) {
  const zips = (assets ?? []).filter((asset) => /\.zip$/i.test(asset.name ?? ""));
  if (zips.length === 0) return { why: "no .zip in the latest release" };
  if (zips.length === 1) return { asset: zips[0] };

  const shape = (name) => String(name).toLowerCase().replace(/\d+/g, "#");
  const alike = zips.filter((asset) => shape(asset.name) === shape(pinnedFileName));
  if (alike.length === 1) return { asset: alike[0] };
  return { why: `${zips.length} .zip assets in the latest release and `
    + `${alike.length ? "more than one is" : "none is"} named like ${pinnedFileName} `
    + "— a person has to say which is the mod" };
}

/// Whether the latest release is the one already pinned.
///
/// The tag alone is not enough in either direction. An author can re-cut an
/// asset under the same tag and URL, which leaves a pin the app refuses; the
/// digest GitHub records for an asset says so without a download. Assets
/// uploaded before it recorded them carry none, and then the size is what is
/// left.
export function sameRelease(pin, release, asset) {
  if (release.tag !== pin.tag || asset.url !== pin.fileUrl) return false;
  if (asset.digest) return asset.digest === `sha256:${pin.sha256}`;
  return asset.size === pin.fileSizeBytes;
}

/// What a NEW release can get wrong that a first listing could not.
///
/// `refusals` answers "is this archive a safe, installable mod". These answer
/// "is it still the mod this row lists": every one of them is a way for a
/// refresh to swap a listing that works for one that does not, or for a claim
/// the catalog makes to stop being true without anybody having typed anything.
export function changeReasons({
  pin, manifest, engineVersion, license, pinnedLicense,
  needsNetwork, catalogModIds, pinnedRequires,
}) {
  const out = [];

  if (manifest?.id && manifest.id !== pin.modId) {
    out.push(`declares modId ${manifest.id} where the catalog pins ${pin.modId} — install(expectingID:) would refuse the update`);
  }

  // A card that installs, switches on, and never loads.
  if (!satisfies(engineVersion, manifest?.game_version)) {
    out.push(`needs engine ${manifest.game_version}, and Phosphor ships ${engineVersion}`);
  }

  // Tier 1 says "open licence" on the listing, about the repo, in the present
  // tense. gen1recomp itself went from MIT to GPLv3 between two patch releases,
  // so that is a thing to look at again every time and not once.
  if (pin.tier === 1) {
    if (!license?.spdx) {
      out.push("the repo's licence could not be read, and tier 1 lists it as open");
    } else if (license.spdx !== pinnedLicense) {
      out.push(`the repo's licence is now ${license.spdx} where the listing says ${pinnedLicense}`);
    } else if (!PERMISSIVE.has(license.spdx)) {
      out.push(`${license.spdx} is not a licence the catalog can take on its own — somebody read the text for the pinned release, and has to read it again for this one`);
    }
  }

  // The sandbox denies sockets, and the app refuses to install a tier 1 mod
  // whose published requirements say it needs them, so this would trade a
  // working listing for a dead one. The caller asks it only of a release that
  // STARTED to: one whose pinned release already did was listed knowing that.
  if (needsNetwork) {
    out.push("now reaches for the network, which the pinned release did not and the sandbox denies");
  }

  // A dependency is a disclosure when the player can get it and a dead end
  // when they cannot. One the pinned release already had was accepted by
  // whoever listed it; only a new one is this script's to question.
  const had = new Set(pinnedRequires ?? []);
  for (const id of requiresFrom(manifest) ?? []) {
    if (id === pin.modId || had.has(id) || catalogModIds?.has(id)) continue;
    out.push(`now depends on ${id}, which the catalog does not carry — it would install and not load`);
  }

  return out;
}

/// The row with its pin moved, and nothing a person wrote touched.
///
/// Spread over the old row so the keys keep their order and the diff is the
/// pin. `manifestPath`, `gameVersion`, `surveyedRelease` and `licenseIncluded`
/// move with it because they are facts about the archive, not about the mod:
/// left behind, the first fails verify-releases and the last is a false claim.
export function refreshedRow(row, fresh) {
  if (row.directSource) {
    return { ...row, directSource: {
      ...row.directSource,
      fileUrl: fresh.fileUrl,
      sha256: fresh.sha256,
      fileSizeBytes: fresh.fileSizeBytes,
      version: fresh.version,
      releasedAt: fresh.publishedAt,
      manifestPath: fresh.manifestPath,
      gameVersion: fresh.gameVersion,
      surveyedRelease: fresh.tag,
    } };
  }
  const next = {
    ...row,
    version: fresh.version,
    releaseDate: fresh.publishedAt.slice(0, 10),
    fileUrl: fresh.fileUrl,
    fileName: fresh.fileName,
    fileSize: humanSize(fresh.fileSizeBytes),
    fileSizeBytes: fresh.fileSizeBytes,
    sha256: fresh.sha256,
    manifestPath: fresh.manifestPath,
    licenseIncluded: fresh.licenseInArchive === true,
  };
  // An open licence asks for its text to travel with the distribution. Where
  // the archive stopped carrying it, the row does.
  if (!next.licenseIncluded && !next.licenseText && fresh.licenseText) {
    next.licenseText = fresh.licenseText;
  }
  return next;
}

/// The row pointed at the same bytes under their new address.
///
/// An author who renames their account takes every release URL with them.
/// GitHub redirects the old ones only until somebody else registers the old
/// name, and after that the pin refuses whatever is served there and the
/// listing installs nothing. The digest is the pinned one, so nothing new was
/// inspected and nothing else about the row is touched.
export function movedRow(row, { fileUrl, fileName }) {
  if (row.directSource) return { ...row, directSource: { ...row.directSource, fileUrl } };
  return { ...row, fileUrl, fileName };
}

/// Installable rows that are one mod listed twice.
///
/// Keyed on the id the engine installs under, because that is what makes them
/// the same thing to a player: installing the second overwrites the first.
/// Two repos under one modId is a different problem and reads differently in
/// the output, which is why the repo is carried.
export function duplicateListings(rows) {
  const byModId = new Map();
  for (const row of rows) {
    const pin = pinOf(row);
    if (!pin?.modId) continue;
    if (!byModId.has(pin.modId)) byModId.set(pin.modId, []);
    byModId.get(pin.modId).push({ id: row.id, tier: pin.tier, repo: pin.repo });
  }
  return [...byModId.entries()]
    .filter(([, listings]) => listings.length > 1)
    .map(([modId, listings]) => ({ modId, listings }));
}

// ---------------------------------------------------------------------------
// Everything below talks to GitHub or the disk.

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/// The latest release, or WHY there is none to read.
///
/// "No release" is a fact about the repo. "GitHub did not answer" is a fact
/// about this run, and folding the second into the first is how a network blip
/// becomes a verdict: the survey learned that the expensive way.
async function latestRelease(repo) {
  try {
    const out = await gh(`repos/${repo}/releases/latest`,
      "{tag:.tag_name, published:.published_at, assets:[.assets[]|{name:.name, url:.browser_download_url, size:.size, digest:(.digest // null)}]}");
    return { release: JSON.parse(out) };
  } catch (error) {
    const said = `${error?.stderr ?? ""}${error?.message ?? ""}`;
    if (/HTTP 404/.test(said)) return { release: null };
    return { unreachable: said.split("\n").find((line) => line.trim())?.trim() ?? "gh failed" };
  }
}

async function licenseOf(repo) {
  try {
    const out = await gh(`repos/${repo}/license`, "{spdx:.license.spdx_id, text:.content}");
    const { spdx, text } = JSON.parse(out);
    return { spdx, text: text ? Buffer.from(text, "base64").toString("utf8").trim() : null };
  } catch {
    return null;
  }
}

const readOrNull = (path) => readFile(path).catch(() => null);

/// The asset's bytes, and where they sit on disk.
///
/// The cache is keyed `owner__repo__asset`, like the survey's, so
/// backfill-mod-imports finds a refreshed tier 2 archive where it looks. That
/// key has no tag in it, and plenty of authors upload `mod.zip` every time, so
/// a cache hit proves nothing until the bytes match what GitHub says the asset
/// is. Hashing a stale hit against a new tag would publish a URL that serves
/// one file next to the digest of another.
///
/// And the file already at that name may be the PINNED release, which a row
/// that ends up held back still needs there. So new bytes that collide are
/// parked beside it, and `promote` moves them over only once the row is
/// actually rewritten.
async function bytesFor(asset, pin) {
  const name = cacheNameFor({ directSource: { fileUrl: asset.url } });
  const settled = join(CACHE, name);
  const parked = join(CACHE, `incoming__${sha256(asset.url).slice(0, 12)}__${name}`);

  const want = asset.digest?.replace(/^sha256:/, "") ?? null;
  const isTheAsset = (bytes) => {
    if (bytes.length !== asset.size) return false;
    const digest = sha256(bytes);
    // No digest from GitHub: bytes that hash to the OLD pin under a new tag
    // are far likelier a stale hit than a re-tag, so they are fetched again.
    return want ? digest === want : digest !== pin.sha256;
  };

  for (const path of [settled, parked]) {
    const bytes = await readOrNull(path);
    if (bytes && isTheAsset(bytes)) return { bytes, path, settled };
  }

  const response = await fetch(asset.url, { redirect: "follow" });
  if (!response.ok) return { unreachable: `${asset.url} answered ${response.status}` };
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== asset.size || (want && sha256(bytes) !== want)) {
    return { unreachable: `${asset.url} served ${bytes.length} bytes that are not the asset GitHub lists` };
  }

  await mkdir(CACHE, { recursive: true });
  const path = (await readOrNull(settled)) ? parked : settled;
  await writeFile(path, bytes);
  return { bytes, path, settled };
}

async function promote({ path, settled }) {
  if (path !== settled) await rename(path, settled);
}

/// One row, all the way to a verdict. Writes nothing but the cache.
async function evaluate(row, context) {
  const pin = pinOf(row);
  const found = await context.latest(pin.repo);
  if (found.unreachable) return { verdict: "unevaluated", why: [found.unreachable] };

  const { release } = found;
  if (!release) return { verdict: "held", why: refusals({ release: null }) };

  const { asset, why } = pickAsset(release.assets, pin.fileName);
  if (!asset) return { verdict: "held", to: release.tag, why: [why] };
  if (sameRelease(pin, release, asset)) return { verdict: "unchanged" };

  // The survey's own bound: past this the installer could not unpack it, so
  // there is nothing to learn by downloading it.
  if (asset.size > MAX_TOTAL_UNCOMPRESSED) {
    return { verdict: "held", to: release.tag,
      why: [`a ${humanSize(asset.size)} download, over what the installer can unpack`] };
  }

  const fetched = await bytesFor(asset, pin);
  if (fetched.unreachable) return { verdict: "unevaluated", to: release.tag, why: [fetched.unreachable] };

  // The pinned bytes at a new address: see `movedRow`. Decided before any
  // check runs, because the checks are about bytes nobody has looked at and
  // these are the ones somebody did.
  if (sha256(fetched.bytes) === pin.sha256) {
    return { verdict: "moved", to: release.tag, fetched,
             fresh: { fileUrl: asset.url, fileName: asset.name } };
  }

  const contents = await inspect(fetched.path);
  const why2 = refusals({ release, asset, contents });
  const manifest = contents.manifest?.unreadable ? null : contents.manifest;

  // What the PINNED release does, for the two checks where that changes the
  // answer. Read only from bytes that still hash to the pin; anything else is
  // "unknown", which is treated as "did not".
  const pinnedName = cacheNameFor(row);
  const pinnedPath = pinnedName ? join(CACHE, pinnedName) : null;
  const pinnedBytes = pinnedPath ? await readOrNull(pinnedPath) : null;
  const pinnedIsCached = Boolean(pinnedBytes) && sha256(pinnedBytes) === pin.sha256;

  // The survey's love-table scan is noisy by design and every hit was read by
  // a person. If the pinned release trips it too, somebody already read that
  // and listed it anyway. Still held back, because the scan is the survey's
  // bar and not this script's to lower; but said, because it changes what the
  // reviewer does next.
  if (contents.loveAssignments?.length && pinnedIsCached
      && (await inspect(pinnedPath)).loveAssignments?.length) {
    why2.push("(the pinned release trips the love-table scan too, and was listed by hand)");
  }

  const notes = [];
  let networkUse = null;
  if (manifest) {
    const tier1 = pin.tier === 1;
    // Only asked of a mod that declares `network`, as enrich-catalog does.
    if ((manifest.permissions ?? []).includes("network")) {
      networkUse = await usesNetwork(fetched.path);
    }
    // The same principle as `pinnedRequires`: what the listed release already
    // did was accepted by whoever listed it, and holding the row back for it
    // would freeze the listing for ever without protecting anybody.
    const pinnedUsedNetwork = networkUse === true && pinnedIsCached
      && await usesNetwork(pinnedPath);
    if (pinnedUsedNetwork) notes.push("reaches for the network, as the pinned release already did");

    why2.push(...changeReasons({
      pin, manifest,
      engineVersion: context.engineVersion,
      license: tier1 ? await context.license(pin.repo) : null,
      pinnedLicense: row.license,
      needsNetwork: networkUse === true && !pinnedUsedNetwork,
      catalogModIds: context.catalogModIds,
      pinnedRequires: context.enrichment[row.id]?.requirements?.requires ?? [],
    }));
  }

  const fresh = why2.length ? null : {
    tag: release.tag,
    publishedAt: release.published,
    fileUrl: asset.url,
    fileName: asset.name,
    fileSizeBytes: fetched.bytes.length,
    sha256: sha256(fetched.bytes),
    // The manifest's own version, because that is what the app compares
    // against an installed copy. The tag is what is left when it has none.
    version: String(manifest.version ?? release.tag.replace(/^v(?=\d)/, "")),
    manifestPath: contents.manifestPath,
    gameVersion: manifest.game_version ?? null,
    licenseInArchive: contents.licenseInArchive,
    licenseText: null,
  };

  // An archive that stopped carrying its licence needs the text on the row.
  if (fresh && pin.tier === 1 && !fresh.licenseInArchive && !row.licenseText) {
    fresh.licenseText = (await context.license(pin.repo))?.text ?? null;
    if (!fresh.licenseText) {
      return { verdict: "held", to: release.tag,
        why: ["the new archive ships no LICENSE and the repo's text could not be fetched to carry instead"] };
    }
  }

  if (!fresh) return { verdict: "held", to: release.tag, why: why2 };
  return { verdict: "refreshed", to: release.tag, fresh, fetched, manifest, networkUse, notes };
}

const memo = (fn) => {
  const seen = new Map();
  return (key) => {
    if (!seen.has(key)) seen.set(key, fn(key));
    return seen.get(key);
  };
};

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const only = args.includes("--only")
    ? new Set(args[args.indexOf("--only") + 1]?.split(",") ?? []) : null;

  // Without it every `game_version` check would pass on nothing, which is the
  // survey's "coin toss". engine-family.mjs reads it from the engines this
  // repo publishes, so a missing value means that file is, too.
  const engineVersion = ENGINE_VERSIONS[ENGINE];
  if (!engineVersion) {
    console.error("No shipped engine version (public/v1/engines.json unreadable): refusing to refresh against nothing.");
    process.exit(1);
  }

  const releases = JSON.parse(await readFile(RELEASES, "utf8"));
  const projects = JSON.parse(await readFile(PROJECTS, "utf8"));
  const enrichment = JSON.parse(await readFile(ENRICHMENT, "utf8"));
  const installable = [...releases, ...projects.filter((project) => project.directSource)];

  const context = {
    engineVersion,
    enrichment,
    latest: memo(latestRelease),
    license: memo(licenseOf),
    catalogModIds: new Set(installable.map((row) => pinOf(row)?.modId).filter(Boolean)),
  };

  console.log(`${installable.length} installable rows, checked against ${ENGINE} ${engineVersion}`
    + `${write ? "" : " (dry run)"}\n`);

  const results = [];
  for (const row of installable) {
    if (only && !only.has(row.id)) continue;
    const pin = pinOf(row);
    process.stdout.write(`  [${results.length + 1}] ${row.id}\x1b[K\r`);
    const result = pin
      ? await evaluate(row, context).catch((error) => ({ verdict: "unevaluated", why: [String(error?.message ?? error)] }))
      : { verdict: "held", why: ["its file is not a GitHub release asset, so there is no latest release to compare"] };
    results.push({ row, pin, ...result });
  }
  process.stdout.write("\x1b[K");

  const of = (verdict) => results.filter((r) => r.verdict === verdict);
  const width = Math.max(...results.map((r) => r.row.id.length), 10);
  const line = (r, rest) => `  ${r.row.id.padEnd(width)}  tier ${r.pin?.tier ?? "?"}  ${rest}`;

  console.log(`refreshed (${of("refreshed").length})`);
  for (const r of of("refreshed")) {
    const grew = r.fresh.fileSizeBytes / r.pin.fileSizeBytes;
    console.log(line(r, `${r.pin.version} → ${r.fresh.version}  (${r.pin.tag} → ${r.to})  `
      + `${humanSize(r.pin.fileSizeBytes)} → ${humanSize(r.fresh.fileSizeBytes)}`
      // Not a reason to refuse, and exactly what a reviewer wants pointed at.
      + `${grew >= 10 ? "  ** ten times the size it was **" : ""}`
      + `${r.fresh.version === r.pin.version ? "  ** new bytes under the same version **" : ""}`));
    for (const note of r.notes) console.log(`  ${" ".repeat(width)}    - ${note}`);
  }

  if (of("moved").length) {
    console.log(`\nmoved, the pinned bytes at a new address (${of("moved").length})`);
    for (const r of of("moved")) console.log(line(r, `${r.pin.fileUrl}\n  ${" ".repeat(width)}          → ${r.fresh.fileUrl}`));
  }

  console.log(`\nheld back, old pin kept (${of("held").length})`);
  for (const r of of("held")) {
    console.log(line(r, `${r.pin?.version ?? ""}${r.to ? `  (${r.pin.tag} → ${r.to})` : ""}`));
    for (const reason of r.why) console.log(`  ${" ".repeat(width)}    - ${reason}`);
  }

  if (of("unevaluated").length) {
    console.log(`\nUNEVALUATED, fetched nothing and judged nothing (${of("unevaluated").length})`);
    for (const r of of("unevaluated")) console.log(line(r, r.why.join("; ")));
  }

  console.log(`\nunchanged (${of("unchanged").length})`);

  const duplicates = duplicateListings(installable);
  if (duplicates.length) {
    console.log(`\none mod listed more than once (${duplicates.length})`);
    for (const { modId, listings } of duplicates) {
      console.log(`  ${modId}: ${listings.map((l) => `${l.id} (tier ${l.tier}, ${l.repo})`).join("  /  ")}`);
    }
  }

  await mkdir(new URL("../survey/", import.meta.url), { recursive: true });
  await writeFile(REPORT, JSON.stringify({
    engine: { [ENGINE]: engineVersion },
    rows: results.map((r) => ({
      id: r.row.id, tier: r.pin?.tier ?? null, repo: r.pin?.repo ?? null, verdict: r.verdict,
      from: r.pin ? { tag: r.pin.tag, version: r.pin.version, sha256: r.pin.sha256 } : null,
      to: r.verdict === "refreshed"
        ? { tag: r.to, version: r.fresh.version, sha256: r.fresh.sha256,
            fileSizeBytes: r.fresh.fileSizeBytes, fileUrl: r.fresh.fileUrl }
        : r.verdict === "moved" ? { tag: r.to, fileUrl: r.fresh.fileUrl }
        : r.to ? { tag: r.to } : null,
      why: r.why ?? [],
      notes: r.notes ?? [],
    })),
    duplicates,
  }, null, 2) + "\n");
  console.log("\nWritten to survey/refresh-report.json");

  if (!write) {
    console.log("(dry run, pass --write to save)");
    return;
  }

  // Rows are replaced in the arrays they came from, by identity, so a held
  // back row is not so much "left alone" as never reachable from here.
  for (const r of [...of("refreshed"), ...of("moved")]) {
    const next = r.verdict === "moved" ? movedRow(r.row, r.fresh) : refreshedRow(r.row, r.fresh);
    const list = r.row.directSource ? projects : releases;
    list[list.indexOf(r.row)] = next;
    await promote(r.fetched);
    if (r.verdict === "moved") continue;

    // Tier 1 publishes what the manifest says about itself (permissions,
    // conflicts, which games), read by enrich-catalog from the pinned bytes.
    // Those bytes just changed, and a full enrichment pass is three hundred
    // repositories away, so the one block is re-read here by the same rule.
    // Tier 2 publishes only imports and requires, which the backfill fills.
    if (!r.row.directSource) {
      const requirements = requirementsFrom(r.manifest, { usesNetwork: r.networkUse });
      const entry = (enrichment[r.row.id] ??= {});
      if (requirements) entry.requirements = requirements;
      else delete entry.requirements;
      if (Object.keys(entry).length === 0) delete enrichment[r.row.id];
    }
  }

  await writeFile(RELEASES, JSON.stringify(releases, null, 2) + "\n");
  await writeFile(PROJECTS, JSON.stringify(projects, null, 2) + "\n");
  await writeFile(ENRICHMENT, JSON.stringify(enrichment, null, 2) + "\n");
  console.log(`wrote ${of("refreshed").length + of("moved").length} row(s) to src/data — now run verify-releases, the imports backfill and the manifest build`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
