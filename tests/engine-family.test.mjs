import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildManifest } from "../scripts/build-manifest.mjs";
import { auditTargets, engineFacet, ENGINE_BY_TARGET } from "../scripts/engine-family.mjs";

const read = async (name) =>
  JSON.parse(await readFile(new URL(`../src/data/${name}`, import.meta.url), "utf8"));

test("every target string in the catalog is one the table knows", async () => {
  for (const file of ["releases.json", "projects.json"]) {
    assert.deepEqual(auditTargets(await read(file), file), []);
  }
});

/// The whole reason the mapping lives on the publishing side. An app-side
/// table would meet a tenth spelling by quietly dropping the mod out of a
/// filter; this meets it by refusing to build.
test("a target spelling nobody taught the catalog stops the build", () => {
  assert.throws(
    () => engineFacet({ target: "Gen 1 Recomp", channels: ["gen1recomp"], label: "new-mod" }),
    /not one of the engine spellings/,
  );
});

test("a target that contradicts compatibility stops the build", () => {
  assert.throws(
    () => engineFacet({ target: "Gen2Recomped", channels: ["gen1recomp"], label: "typo" }),
    /One of the two is a typo/,
  );
});

/// A ROM hack targets a cartridge, not an engine, so its target is a game's
/// name and the table has nothing to say about it. Checking those would fail
/// the survey on five legitimate rows.
test("a ROM hack names no engine and is not checked against the table", () => {
  assert.equal(
    engineFacet({ target: "Pokémon Crystal", channels: ["rom-hack"], label: "hack" }),
    null,
  );
});

/// A dual-engine mod is published once per engine and each half installs into
/// exactly one. Publishing "both" on both halves would make a Gen 2 filter
/// return the Gen 1 listing of the same mod, next to its twin.
test("each half of a dual-engine mod claims only the engine it installs into", () => {
  const gen1 = engineFacet({
    target: "Gen1Recomp and Gen2Recomped",
    channels: ["gen1recomp", "gen2recomp"],
    installsInto: "gen1recomp",
  });
  const gen2 = engineFacet({
    target: "Gen1Recomp and Gen2Recomped",
    channels: ["gen1recomp", "gen2recomp"],
    installsInto: "gen2recomped",
  });
  assert.equal(gen1.family, "gen1recomp");
  assert.equal(gen2.family, "gen2recomped");
});

test("the games a narrowed target names travel with it", () => {
  assert.deepEqual(
    engineFacet({ target: "Gen1Recomp · R/B/Y", channels: ["gen1recomp"] }),
    { family: "gen1recomp", games: ["red", "blue", "yellow"] },
  );
});

test("every published entry carries an engine family the app can filter on", async () => {
  const { entries } = await buildManifest();
  const families = new Set(Object.values(ENGINE_BY_TARGET).map((e) => e.family));

  for (const entry of entries) {
    assert.ok(entry.engine?.family, `${entry.id}: no engine family`);
    assert.ok(families.has(entry.engine.family) || entry.engine.family === "gen2recomped",
              `${entry.id}: unknown family ${entry.engine.family}`);
    assert.ok(Array.isArray(entry.engine.games), `${entry.id}: games must be an array`);
  }
});

/// An installable entry installs into one engine, so its family is that
/// engine and never "both". The app's own fallback derives the same answer
/// from `engine.id`, and the two must not disagree.
test("an installable entry's family agrees with the engine it installs into", async () => {
  const { entries } = await buildManifest();
  for (const entry of entries.filter((e) => e.download)) {
    assert.equal(entry.engine.family, entry.engine.id, entry.id);
  }
});

/// Every engine facet has to be populated among both the installable listings
/// and the link-outs, or a filter chip in the app's Workshop appears over
/// nothing.
///
/// The engines are read out of the manifest rather than written down here. The
/// list used to be `["gen1recomp", "gen2recomped"]` and it went stale the day
/// Gen2Recomped left the app: a hardcoded engine turns a correct catalog into
/// a failing suite, and the reflex is to delete the assertion rather than
/// notice what it was protecting. Derived, the same test keeps working through
/// an engine arriving or leaving, and still fails on the thing it is for — an
/// engine present in one population and absent from the other.
test("every engine is represented among both installable and indexed listings", async () => {
  const { entries } = await buildManifest();
  const covers = (entry, engine) =>
    entry.engine.family === engine || entry.engine.family === "both";

  const engines = [...new Set(
    entries.map((e) => e.engine?.family).filter((f) => f && f !== "both"),
  )];
  assert.ok(engines.length > 0, "the catalog names no engine at all");

  for (const [label, pool] of [
    ["installable", entries.filter((e) => e.download)],
    ["indexed", entries.filter((e) => !e.download)],
  ]) {
    for (const engine of engines) {
      assert.ok(pool.some((entry) => covers(entry, engine)),
                `no ${engine} listing among the ${label} entries`);
    }
  }
});
