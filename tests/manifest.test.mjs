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

// A pending listing always offers the creator's own page. Since CATALOG_POLICY
// grew tier 2 it MAY also offer an install straight from their release asset --
// their hosting, their file, our pinned hash -- so the rule is no longer "never
// a download". It is: whatever else a pending row does, it keeps the link, it
// keeps the PENDING shelf, and if it installs then it is verifiable.
test("any indexed entry offers a link, and a tier-2 install is verifiable", async () => {
  const { entries } = await buildManifest();
  const indexed = entries.filter((entry) => entry.project);

  for (const entry of indexed) {
    assert.match(entry.project.url, /^https:\/\//, `${entry.id}: project url`);
    assert.ok(entry.project.status, `${entry.id}: review status`);
    assert.deepEqual(entry.categories, ["PENDING"], `${entry.id}: shelf`);

    if (!entry.download) continue;

    // Tier 2. Everything below is the safety argument for fetching a file
    // nobody granted us: an unverifiable install is the one thing pointing at
    // a third-party URL must never allow.
    assert.notEqual(entry.kind, "romPatch",
      `${entry.id}: a rom-hack is never tier 2 -- a hack that is not a patch is a cartridge`);
    assert.match(entry.download.url, /^https:\/\//, `${entry.id}: tier-2 download url`);
    assert.ok(entry.download.sha256, `${entry.id}: tier 2 without a pinned hash`);
    assert.ok(entry.download.sizeBytes > 0, `${entry.id}: tier 2 without a size cap`);
    assert.ok(entry.version, `${entry.id}: tier 2 without a version`);
    assert.ok(entry.modID, `${entry.id}: tier 2 without a modID to install under`);
    assert.equal(typeof entry.engine?.id, "string",
      `${entry.id}: engine.id must be a STRING -- the app decodes it as one and drops the row otherwise`);
    // No licence, because there is no licence. Claiming one here is the single
    // most misleading thing this file could publish.
    assert.equal(entry.license, undefined,
      `${entry.id}: tier 2 has no licence to name`);
  }
});

test("the fan-out is dormant while one engine ships, and ids carry no suffix", async () => {
  const { entries } = await buildManifest();
  // `pokeball-colors` was the fan-out's live example: one release, two
  // listings, `id@engineId` apiece. With Gen2Recomped gone there is one engine
  // to install into, so it is one entry again and the id is bare.
  //
  // The bare id is the part worth pinning. The app's install ledger is keyed on
  // the catalog id, so the suffix coming off is a key change for every player
  // who installed one of the ten dual-engine mods. It is self-healing —
  // `DiscoverModel.modsAlreadyOnDisk` adopts an entry with no ledger row when a
  // mod with its `modID` is on disk — but only while the id stays put after
  // this. Reintroducing a suffix would break it a second time with no adoption
  // to catch it, because the old row would already be adopted under the new id.
  const fanned = entries.filter((entry) => entry.id.startsWith("pokeball-colors"));
  assert.deepEqual(fanned.map((entry) => entry.id), ["pokeball-colors"]);
  assert.equal(fanned[0].engine.id, "gen1recomp");

  assert.ok(
    !entries.some((entry) => entry.id.includes("@")),
    "no entry should carry an @engine suffix while only one engine ships",
  );
});

test("the manifest publishes the engine version it was gated against", async () => {
  const { entries, engines } = await buildManifest();

  assert.ok(Array.isArray(engines) && engines.length > 0,
            "the app has nothing to compare against without this");
  for (const engine of engines) {
    assert.match(engine.catalogedAgainst, /^\d+\.\d+\.\d+(-\S+)?$/,
                 `${engine.id}: catalogedAgainst must be a version the app can parse`);
  }

  // Every engine an entry claims must be declared, or the app can check the
  // gate for one engine while installing under another. This is the half that
  // would go quiet on its own: adding a second engine is exactly the moment
  // somebody forgets the table, and the symptom is a gate that passes because
  // it was never consulted.
  const declared = new Set(engines.map((e) => e.id));
  const used = new Set(entries.map((e) => e.engine?.id).filter(Boolean));
  for (const id of used) {
    assert.ok(declared.has(id), `entries install into ${id}, which engines[] does not declare`);
  }
});

test("no retired engine reaches the manifest", async () => {
  const { entries } = await buildManifest();
  // An indexed listing carries `engine.family` but no `engine.id` — there is
  // nothing to install it into — so the two are counted separately. Folding
  // them together yields an `undefined` that hides whatever it is standing in
  // for.
  const engines = new Set(entries.map((e) => e.engine?.id).filter(Boolean));
  const families = new Set(entries.map((e) => e.engine?.family).filter(Boolean));

  // Gen2Recomped came out of Phosphor in 3.8 over its licence. Until 20 Aug
  // 2026 this test asserted the opposite — that the app's spelling for it was
  // present — because the risk then was the site saying `gen2recomp` and the
  // app saying `gen2recomped`, which produced listings no installed engine
  // claimed. The risk is the same shape now and the answer is stricter: there
  // is no installed engine to claim them at all, under either spelling.
  assert.ok(!engines.has("gen2recomped"), "the app has no Gen2Recomped engine to install into");
  assert.ok(!engines.has("gen2recomp"), "and the site spelling must never reach the app either");
  assert.deepEqual([...engines].sort(), ["gen1recomp"]);

  // "both" is a family, not an engine, and it is unreachable while one engine
  // ships: a row naming both channels is now refused outright. A link-out
  // filed under it would be offered by a Gen 2 filter that matches nothing.
  assert.deepEqual([...families].sort(), ["gen1recomp"]);
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

// The deliberate scope of the ship. If ROM hacks come back this test is the one
// that should fail and be updated on purpose, rather than the change going out
// unnoticed. It already did that job once: an indexed listing acquiring a
// download was forbidden here until tier 2 made it deliberate, and this test
// is what stopped that going out unremarked.
test("the published catalog is mods, installable or linked, and never a ROM hack", async () => {
  const { entries, sections, categories } = await buildManifest();

  assert.deepEqual(sections.map((section) => section.id), ["luaMods"]);
  assert.equal(entries.filter((entry) => entry.kind === "romPatch").length, 0);

  // Every entry offers the player SOMETHING: an install, a link, or (tier 2)
  // both. Neither is the only forbidden combination -- it is a card that does
  // nothing when tapped. "Both" used to be forbidden too, and stopped being so
  // when tier 2 landed: a tier-2 row is an install AND a link to the person
  // whose work it is, deliberately.
  for (const entry of entries) {
    const installable = Boolean(entry.download);
    const indexed = Boolean(entry.project);
    assert.ok(installable || indexed,
      `${entry.id}: offers neither an install nor a link, so its card does nothing`);
  }

  const indexed = entries.filter((entry) => entry.project);
  assert.ok(indexed.length > 0, "the link-out shelf is published");
  assert.equal(categories.filter((category) => category.id === "PENDING").length, 1,
    "indexed listings need the shelf they file under");

  // A pending listing never claims a LICENCE, in either tier. That is the line
  // CATALOG_POLICY actually draws: tier 2 fetches a file the creator published
  // and pins its hash, which is a statement about bytes, while a licence would
  // be a statement about permission that nobody granted.
  //
  // A version is fine now, and on a tier-2 row it is required -- the app
  // refuses to install anything it cannot name a version for. A version on a
  // row with no download would still be pretending, so that stays refused.
  for (const entry of indexed) {
    assert.ok(/^https:\/\//.test(entry.project.url), `${entry.id}: link must be HTTPS`);
    assert.equal(entry.license, undefined, `${entry.id}: a pending listing claims no licence`);
    if (!entry.download) {
      assert.equal(entry.version, undefined,
        `${entry.id}: a link-out with no file has no version to state`);
    }
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
