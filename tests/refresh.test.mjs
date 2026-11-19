import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pinOf, pickAsset, sameRelease, changeReasons, refreshedRow, movedRow, duplicateListings,
} from "../scripts/refresh-releases.mjs";

const tier1 = {
  id: "gen1recomp-gen3-dex",
  title: "Gen 3 Dex",
  version: "0.5.0",
  releaseDate: "2026-08-12",
  summary: "The Pokedex as a grid of pictures.",
  fileUrl: "https://github.com/MadeinTaly/gen1recomp-gen3-dex/releases/download/v0.5.0/gen3_dex-0.5.0.zip",
  fileName: "gen3_dex-0.5.0.zip",
  fileSize: "24.5 KB",
  sha256: "8f3ca00b261d99f9c700e41ea9d184a4cacb0afc4c6a784137b34414c4c207ab",
  permission: "open-license",
  license: "MIT",
  licenseIncluded: true,
  modId: "gen3_dex",
  fileSizeBytes: 25092,
  topic: "UI",
  manifestPath: "manifest.json",
};

const tier2 = {
  id: "green-sgb-palette",
  title: "Green SGB Palette",
  homepageUrl: "https://github.com/harryw4444/green_sgb_palette_gen1recomp",
  reviewStatus: "permission-queued",
  directSource: {
    permission: "none-direct-source",
    fileUrl: "https://github.com/harryw4444/green_sgb_palette_gen1recomp/releases/download/FirstRelease/green_sgb_palette.zip",
    sha256: "9a377038c5cb8e8b7f240de6a2ad811192ad52a3c3a3eb80ba3443e12360b8d5",
    fileSizeBytes: 2170,
    version: "1.0.0",
    releasedAt: "2026-08-05T07:16:55Z",
    manifestPath: "manifest.json",
    modId: "green_sgb_palette",
    gameVersion: ">=0.0.0-0 <2.0.0",
    surveyedRelease: "FirstRelease",
  },
};

test("a pin is read the same way out of either tier", () => {
  assert.deepEqual(pinOf(tier1), {
    tier: 1,
    repo: "MadeinTaly/gen1recomp-gen3-dex",
    tag: "v0.5.0",
    fileUrl: tier1.fileUrl,
    fileName: "gen3_dex-0.5.0.zip",
    sha256: tier1.sha256,
    fileSizeBytes: 25092,
    modId: "gen3_dex",
    version: "0.5.0",
  });
  const pin = pinOf(tier2);
  assert.equal(pin.tier, 2);
  assert.equal(pin.repo, "harryw4444/green_sgb_palette_gen1recomp");
  assert.equal(pin.tag, "FirstRelease");
  assert.equal(pin.fileName, "green_sgb_palette.zip");
  assert.equal(pin.modId, "green_sgb_palette");
});

test("a tag or an asset name with an escaped character is read decoded", () => {
  const pin = pinOf({ ...tier1,
    fileUrl: "https://github.com/a/b/releases/download/v1.0%2Bhotfix/My%20Mod.zip" });
  assert.equal(pin.tag, "v1.0+hotfix");
  // Tier 1 keeps the row's own fileName; tier 2 has none, so it is the URL's.
  assert.equal(pinOf({ directSource: { ...tier2.directSource,
    fileUrl: "https://github.com/a/b/releases/download/v1/My%20Mod.zip" } }).fileName, "My Mod.zip");
});

test("a row that is not a GitHub release asset has no pin to compare", () => {
  assert.equal(pinOf({ ...tier1, fileUrl: "https://example.com/mod.zip" }), null);
  assert.equal(pinOf({ id: "link-out", homepageUrl: "https://github.com/a/b" }), null);
});

test("the only zip in a release is the mod, whatever it is called now", () => {
  const assets = [{ name: "SHA256SUMS.txt" }, { name: "Renamed-Mod-2.0.zip" }];
  assert.deepEqual(pickAsset(assets, "old_name-1.0.zip"), { asset: assets[1] });
});

test("among several zips, the one named like the pinned file wins", () => {
  // Version digits are what legitimately change between releases, so they are
  // what the comparison ignores.
  const assets = [
    { name: "mod-source-2.10.0.zip" },
    { name: "mod-2.10.0-direct-install.zip" },
    { name: "mod-2.10.0.tar.gz" },
  ];
  assert.deepEqual(pickAsset(assets, "mod-0.1.1-direct-install.zip"), { asset: assets[1] });
});

test("several zips and no way to tell them apart is a person's call", () => {
  const none = pickAsset([{ name: "windows.zip" }, { name: "android.zip" }], "mod-1.0.zip");
  assert.match(none.why, /2 \.zip assets.*none is named like mod-1\.0\.zip/);
  assert.equal(none.asset, undefined);

  const both = pickAsset([{ name: "mod-1.1.zip" }, { name: "mod-1.2.zip" }], "mod-1.0.zip");
  assert.match(both.why, /more than one is named like/);
});

test("a release with no zip says so in the survey's own words", () => {
  assert.deepEqual(pickAsset([{ name: "mod.tar.gz" }], "mod.zip"), { why: "no .zip in the latest release" });
  assert.deepEqual(pickAsset([], "mod.zip"), { why: "no .zip in the latest release" });
});

test("the same tag, URL and bytes is the release already pinned", () => {
  const pin = pinOf(tier1);
  const asset = { url: tier1.fileUrl, size: 25092, digest: `sha256:${tier1.sha256}` };
  assert.equal(sameRelease(pin, { tag: "v0.5.0" }, asset), true);
  // An asset uploaded before GitHub recorded digests carries none.
  assert.equal(sameRelease(pin, { tag: "v0.5.0" }, { ...asset, digest: null }), true);
});

test("a new tag is a new release", () => {
  const pin = pinOf(tier1);
  const asset = { url: tier1.fileUrl.replaceAll("0.5.0", "0.21.0"), size: 40000, digest: null };
  assert.equal(sameRelease(pin, { tag: "v0.21.0" }, asset), false);
});

test("an asset re-cut under the same tag is NOT the release that was pinned", () => {
  // The URL is identical and the app would refuse the install: the digest is
  // the only thing that says so without downloading.
  const pin = pinOf(tier1);
  const recut = { url: tier1.fileUrl, size: 25092, digest: `sha256:${"0".repeat(64)}` };
  assert.equal(sameRelease(pin, { tag: "v0.5.0" }, recut), false);
  assert.equal(sameRelease(pin, { tag: "v0.5.0" },
    { url: tier1.fileUrl, size: 25093, digest: null }), false);
});

const passing = {
  pin: pinOf(tier1),
  manifest: { id: "gen3_dex", version: "0.21.0", game_version: ">=0.1.99 <2.0.0" },
  engineVersion: "0.2.61",
  license: { spdx: "MIT" },
  pinnedLicense: "MIT",
  needsNetwork: false,
  catalogModIds: new Set(["gen3_dex"]),
  pinnedRequires: [],
};

test("a release that changes nothing a listing promises has nothing against it", () => {
  assert.deepEqual(changeReasons(passing), []);
});

test("a changed modId holds the row back", () => {
  const reasons = changeReasons({ ...passing, manifest: { ...passing.manifest, id: "gen3_dex_v2" } });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /declares modId gen3_dex_v2 where the catalog pins gen3_dex/);
});

/// The catalog stopped gating on the engine pin on Sep 23 2026: a mod ahead
/// of the shipped engine is published, and the app labels the fit from
/// `requirements.engineRange`. A refresh that held the row at its old release
/// for the same reason was that gate under another name.
test("a release ahead of the shipped engine still moves the row forward", () => {
  assert.deepEqual(changeReasons({ ...passing,
    manifest: { ...passing.manifest, game_version: ">=0.2.62 <2.0.0" } }), []);
  assert.deepEqual(changeReasons({ ...passing, manifest: { id: "gen3_dex" } }), []);
});

test("tier 1 is held back when the licence it was listed under is not the repo's any more", () => {
  assert.match(changeReasons({ ...passing, license: { spdx: "GPL-3.0" } })[0],
    /licence is now GPL-3\.0 where the listing says MIT/);
  // Unidentifiable is not the same as unchanged, even when the row says the same.
  assert.match(changeReasons({ ...passing, license: { spdx: "NOASSERTION" }, pinnedLicense: "NOASSERTION" })[0],
    /NOASSERTION is not a licence the catalog can take on its own/);
  assert.match(changeReasons({ ...passing, license: null })[0], /licence could not be read/);
});

test("tier 2 claims no licence, so none is checked", () => {
  assert.deepEqual(changeReasons({ ...passing, pin: pinOf(tier2),
    manifest: { id: "green_sgb_palette" }, license: null, pinnedLicense: undefined }), []);
});

test("a release that starts using the network holds the row back", () => {
  assert.match(changeReasons({ ...passing, needsNetwork: true })[0], /reaches for the network/);
});

test("a NEW hard dependency the catalog does not carry holds the row back", () => {
  const manifest = { ...passing.manifest, dependencies: ["gen2_dex@^1.2.2", "gen3_dex"] };
  assert.match(changeReasons({ ...passing, manifest })[0], /now depends on gen2_dex, which the catalog does not carry/);
  // One the catalog carries is a disclosure, not a dead end.
  assert.deepEqual(changeReasons({ ...passing, manifest,
    catalogModIds: new Set(["gen3_dex", "gen2_dex"]) }), []);
  // One the PINNED release already had was accepted by whoever listed it.
  assert.deepEqual(changeReasons({ ...passing, manifest, pinnedRequires: ["gen2_dex"] }), []);
});

const fresh = {
  tag: "v0.21.0",
  publishedAt: "2026-09-14T18:02:11Z",
  fileUrl: "https://github.com/MadeinTaly/gen1recomp-gen3-dex/releases/download/v0.21.0/gen3_dex-0.21.0.zip",
  fileName: "gen3_dex-0.21.0.zip",
  fileSizeBytes: 1572864,
  sha256: "a".repeat(64),
  version: "0.21.0",
  manifestPath: "gen3_dex/manifest.json",
  gameVersion: ">=0.1.99 <2.0.0",
  licenseInArchive: true,
  licenseText: null,
};

test("a tier 1 refresh rewrites the pin and nothing a person wrote", () => {
  const next = refreshedRow(tier1, fresh);
  assert.equal(next.version, "0.21.0");
  assert.equal(next.releaseDate, "2026-09-14");
  assert.equal(next.fileUrl, fresh.fileUrl);
  assert.equal(next.fileName, "gen3_dex-0.21.0.zip");
  assert.equal(next.fileSize, "1.5 MB");
  assert.equal(next.fileSizeBytes, 1572864);
  assert.equal(next.sha256, fresh.sha256);
  // verify-releases fails a row whose manifest moved, so it moves with the pin.
  assert.equal(next.manifestPath, "gen3_dex/manifest.json");
  for (const field of ["id", "title", "summary", "permission", "license", "modId", "topic"]) {
    assert.equal(next[field], tier1[field], field);
  }
  // Same keys in the same order, so the diff is the pin and only the pin.
  assert.deepEqual(Object.keys(next), Object.keys(tier1));
  assert.equal(tier1.version, "0.5.0", "the row handed in is not edited in place");
});

test("an archive that drops its LICENSE carries the text in the row instead", () => {
  const next = refreshedRow(tier1, { ...fresh, licenseInArchive: false, licenseText: "MIT License\n…" });
  assert.equal(next.licenseIncluded, false);
  assert.equal(next.licenseText, "MIT License\n…");
  // A row that already carries the text keeps its own copy.
  const kept = refreshedRow({ ...tier1, licenseIncluded: false, licenseText: "theirs" },
    { ...fresh, licenseInArchive: false, licenseText: "fetched" });
  assert.equal(kept.licenseText, "theirs");
});

test("a tier 2 refresh rewrites the directSource block and leaves the row", () => {
  const next = refreshedRow(tier2, { ...fresh, tag: "v2", version: "2.0.0", manifestPath: "manifest.json" });
  assert.deepEqual(next.directSource, {
    permission: "none-direct-source",
    fileUrl: fresh.fileUrl,
    sha256: fresh.sha256,
    fileSizeBytes: 1572864,
    version: "2.0.0",
    releasedAt: "2026-09-14T18:02:11Z",
    manifestPath: "manifest.json",
    modId: "green_sgb_palette",
    gameVersion: ">=0.1.99 <2.0.0",
    surveyedRelease: "v2",
  });
  assert.equal(next.reviewStatus, "permission-queued");
  assert.equal("version" in next, false, "tier 2 keeps its install data inside directSource");
  assert.equal(tier2.directSource.version, "1.0.0");
});

test("a renamed account moves the address and nothing else", () => {
  const at = {
    fileUrl: "https://github.com/NewName/gen1recomp-gen3-dex/releases/download/v0.5.0/gen3_dex-0.5.0.zip",
    fileName: "gen3_dex-0.5.0.zip",
  };
  assert.deepEqual(movedRow(tier1, at), { ...tier1, fileUrl: at.fileUrl });
  assert.deepEqual(movedRow(tier2, at),
    { ...tier2, directSource: { ...tier2.directSource, fileUrl: at.fileUrl } });
  assert.equal(tier2.directSource.fileUrl.includes("harryw4444"), true);
});

test("two listings of one mod are reported, by the id the engine installs under", () => {
  const twin = { ...tier1, id: "gen3-dex" };
  assert.deepEqual(duplicateListings([tier1, tier2, twin, { id: "link-out" }]), [
    { modId: "gen3_dex", listings: [
      { id: "gen1recomp-gen3-dex", tier: 1, repo: "MadeinTaly/gen1recomp-gen3-dex" },
      { id: "gen3-dex", tier: 1, repo: "MadeinTaly/gen1recomp-gen3-dex" },
    ] },
  ]);
  assert.deepEqual(duplicateListings([tier1, tier2]), []);
});
