// A mod published as an archive committed to a repository, rather than
// released.
//
// Everything here was a one-mod-per-repository assumption that held while
// every install pointed at a GitHub release asset. `FAFF0x/gen3recomp`
// publishes 23 FireRed mods as zips at the root of its default branch, with no
// releases and no tags, and each assumption failed silently against it: a URL
// that read as no repository at all, 23 listings that collapsed onto whichever
// mod was surveyed last, and an archive nothing could find again.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { repoOf } from "../scripts/lib/repo-url.mjs";
import { cacheNameFor } from "../scripts/backfill-mod-imports.mjs";

const RELEASE_URL =
  "https://github.com/wild1walker/Gen1AutoSave/releases/download/v1.20.2/gen1autosave-1.20.2.zip";
const TREE_URL =
  "https://raw.githubusercontent.com/FAFF0x/gen3recomp/9f0c1d2e3a4b5c6d7e8f/hm_anywhere_gen3_v2.1.3.zip";

test("a repository is read from both the release and the commit-pinned form", () => {
  assert.equal(repoOf(RELEASE_URL), "wild1walker/gen1autosave");
  assert.equal(repoOf(TREE_URL), "faff0x/gen3recomp");
  assert.equal(repoOf("https://github.com/owner/repo.git"), "owner/repo");
});

/// `null` is the answer that does damage: it is looked up in the exclusion set
/// and used to match a drafted release to the row it updates, and both of
/// those quietly do the wrong thing rather than failing.
test("a URL that is not a repository is null, and a look-alike host is not GitHub", () => {
  assert.equal(repoOf(null), null);
  assert.equal(repoOf(""), null);
  assert.equal(repoOf("https://example.invalid/owner/repo/mod.zip"), null);
  assert.equal(repoOf("https://notgithub.com/owner/repo"), null);
  assert.equal(repoOf("https://raw.githubusercontent.evil.test/owner/repo/x/m.zip"), null);
});

/// The survey caches an archive as `owner__repo__asset`, and this is what
/// finds it again. A tree archive that could not be named here was published
/// with nothing read out of it: if such a mod ever declares `required_imports`
/// the catalog would say it needs no file from the player, which is the one
/// thing a player has to know before installing it.
test("a committed archive is found in the cache under the survey's own name", () => {
  assert.equal(cacheNameFor({ directSource: { fileUrl: TREE_URL } }),
               "FAFF0x__gen3recomp__hm_anywhere_gen3_v2.1.3.zip");
  assert.equal(cacheNameFor({ directSource: { fileUrl: RELEASE_URL } }),
               "wild1walker__Gen1AutoSave__gen1autosave-1.20.2.zip");
  assert.equal(cacheNameFor({ id: "x", fileName: "x-1.0.zip" }), "published__x__x-1.0.zip");
  assert.equal(cacheNameFor({ directSource: { fileUrl: "https://example.invalid/m.zip" } }), null);
});

/// Pinned to a commit and never to a branch.
///
/// `.../main/mod.zip` serves whatever that path becomes, so the SHA-256 the
/// catalog publishes stops matching the moment the creator updates, and every
/// install refuses — safely, and for a reason no player can act on. The commit
/// form is immutable, which is the whole of what CATALOG_POLICY means by
/// pinning the bytes somebody looked at.
test("no published install points at a mutable branch path", async () => {
  const projects = JSON.parse(await readFile(new URL("../src/data/projects.json", import.meta.url), "utf8"));
  const releases = JSON.parse(await readFile(new URL("../src/data/releases.json", import.meta.url), "utf8"));
  const urls = [...projects.map((p) => p.directSource?.fileUrl), ...releases.map((r) => r.fileUrl)]
    .filter((url) => typeof url === "string" && url.includes("raw.githubusercontent.com"));
  for (const url of urls) {
    const ref = url.split("/")[5];
    assert.match(ref, /^[0-9a-f]{40}$/,
                 `${url} pins "${ref}" — a commit SHA is the only immutable ref here`);
  }
});

/// One repository, several mods, and every listing its own archive.
test("a suite's listings do not share one mod id, one id, or one archive", async () => {
  const projects = JSON.parse(await readFile(new URL("../src/data/projects.json", import.meta.url), "utf8"));
  const suite = projects.filter((p) => repoOf(p.homepageUrl) === "faff0x/gen3recomp");
  assert.ok(suite.length > 1, "expected the Gen 3 suite to be listed as several mods");

  for (const field of [(p) => p.id, (p) => p.modId, (p) => p.directSource?.fileUrl,
                       (p) => p.directSource?.sha256]) {
    const seen = suite.map(field);
    assert.ok(seen.every(Boolean), "every listing in a suite states this for itself");
    assert.equal(new Set(seen).size, seen.length, `two listings share ${seen.find(
      (v, i) => seen.indexOf(v) !== i)}`);
  }
});
