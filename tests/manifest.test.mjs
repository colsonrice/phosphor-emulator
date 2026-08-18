import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildManifest } from "../scripts/build-manifest.mjs";

const manifestURL = new URL("../public/v1/manifest.json", import.meta.url);

test("the committed manifest matches its sources", async () => {
  const built = JSON.stringify(await buildManifest(), null, 2) + "\n";
  const committed = await readFile(manifestURL, "utf8");
  assert.equal(committed, built, "run: node scripts/build-manifest.mjs");
});

test("every installable entry carries what the app needs to verify it", async () => {
  const { entries } = await buildManifest();
  const installable = entries.filter((entry) => entry.download);
  assert.ok(installable.length > 0, "expected at least one installable entry");

  for (const entry of installable) {
    assert.match(entry.download.sha256, /^[a-f\d]{64}$/i, `${entry.id}: digest`);
    assert.ok(entry.download.sizeBytes > 0, `${entry.id}: size`);
    assert.match(entry.download.url, /^https:\/\//, `${entry.id}: https`);
    assert.ok(entry.version, `${entry.id}: version`);
    // A luaMod with no engine or no modID is dropped by the app's decoder.
    assert.ok(entry.engine?.id, `${entry.id}: engine`);
    assert.ok(entry.modID, `${entry.id}: modID`);
  }
});

// Indexed listings are switched off for now (PUBLISH_INDEXED), so this asserts
// the rule rather than their presence: it has to keep holding whenever they are
// switched back on.
test("any indexed entry offers a link and never a download", async () => {
  const { entries } = await buildManifest();
  const indexed = entries.filter((entry) => entry.project);

  for (const entry of indexed) {
    assert.equal(entry.download, undefined, `${entry.id}: must not be mirrored while pending`);
    assert.match(entry.project.url, /^https:\/\//, `${entry.id}: project url`);
    assert.ok(entry.project.status, `${entry.id}: review status`);
    assert.deepEqual(entry.categories, ["PENDING"], `${entry.id}: shelf`);
  }
});

test("a mod supporting both engines is offered once per engine", async () => {
  const { entries } = await buildManifest();
  const fanned = entries.filter((entry) => entry.id.startsWith("pokeball-colors"));
  assert.deepEqual(
    fanned.map((entry) => entry.engine.id).sort(),
    ["gen1recomp", "gen2recomped"],
  );
  // Same archive, two listings: the app installs into one engine at a time.
  assert.equal(new Set(fanned.map((entry) => entry.download.sha256)).size, 1);
});

test("the second engine keeps the id the app expects", async () => {
  const { entries } = await buildManifest();
  const engines = new Set(entries.filter((e) => e.engine).map((e) => e.engine.id));
  // The site calls it gen2recomp; the app calls it gen2recomped. A mismatch
  // here produces mods that no installed engine ever claims.
  assert.ok(engines.has("gen2recomped"));
  assert.ok(!engines.has("gen2recomp"));
});

test("every entry lands in a declared section and category", async () => {
  const { entries, sections, categories } = await buildManifest();
  const kinds = new Set(sections.map((section) => section.kind));
  const ids = new Set(categories.map((category) => category.id));

  for (const entry of entries) {
    assert.ok(kinds.has(entry.kind), `${entry.id}: kind ${entry.kind} has no section`);
    for (const category of entry.categories) {
      assert.ok(ids.has(category), `${entry.id}: category ${category} is not declared`);
    }
  }
});

// The deliberate scope of the ship. If ROM hacks come back, or an indexed
// listing ever acquires a download, this test is the one that should fail and
// be updated on purpose, rather than the change going out unnoticed.
test("the published catalog is mods, installable or linked, and never a ROM hack", async () => {
  const { entries, sections, categories } = await buildManifest();

  assert.deepEqual(sections.map((section) => section.id), ["luaMods"]);
  assert.equal(entries.filter((entry) => entry.kind === "romPatch").length, 0);

  // Every entry is one thing or the other, never both and never neither. The
  // app's decoder splits on exactly this, and an entry carrying a download AND
  // a project would be an install site reached through a link-out card.
  for (const entry of entries) {
    const installable = Boolean(entry.download);
    const indexed = Boolean(entry.project);
    assert.ok(installable !== indexed,
      `${entry.id}: must be installable or indexed, not ${installable ? "both" : "neither"}`);
  }

  const indexed = entries.filter((entry) => entry.project);
  assert.ok(indexed.length > 0, "the link-out shelf is published");
  assert.equal(categories.filter((category) => category.id === "PENDING").length, 1,
    "indexed listings need the shelf they file under");

  // An indexed listing must carry no trace of a file. CATALOG_POLICY draws the
  // line at redistribution, and a version or a hash on a row nobody can install
  // is the beginning of pretending otherwise.
  for (const entry of indexed) {
    assert.ok(/^https:\/\//.test(entry.project.url), `${entry.id}: link must be HTTPS`);
    assert.equal(entry.version, undefined, `${entry.id}: an indexed listing has no version`);
    assert.equal(entry.license, undefined, `${entry.id}: an indexed listing claims no licence`);
  }
});

test("every open-license mod carries its licence somewhere", async () => {
  const releases = JSON.parse(await readFile(new URL("../src/data/releases.json", import.meta.url), "utf8"));
  for (const release of releases.filter((r) => r.permission === "open-license")) {
    const carried = release.licenseIncluded === true
      || (typeof release.licenseText === "string" && release.licenseText.trim().length > 0);
    assert.ok(carried, `${release.id}: MIT text travels with neither the archive nor the catalog`);
  }
});

test("entry ids are unique", async () => {
  const { entries } = await buildManifest();
  const ids = entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("generated is stable rather than a build clock", async () => {
  const first = await buildManifest();
  const second = await buildManifest();
  // A wall-clock stamp would make the committed file dirty on every build and
  // turn --check into noise.
  assert.equal(first.generated, second.generated);
  assert.match(first.generated, /^\d{4}-\d{2}-\d{2}$/);
});
