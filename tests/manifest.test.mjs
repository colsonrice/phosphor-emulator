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

test("indexed entries offer a link and never a download", async () => {
  const { entries } = await buildManifest();
  const indexed = entries.filter((entry) => entry.project);
  assert.ok(indexed.length > 0, "expected indexed entries");

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
