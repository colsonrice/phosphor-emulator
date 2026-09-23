import test from "node:test";
import assert from "node:assert/strict";
import { categorize } from "../scripts/lib/categorize.mjs";

/// The rules that must hold whatever the keyword table grows into.
///
/// Written as behaviour rather than as a table of expected outputs on purpose:
/// the vocabulary will keep growing as mods arrive, and a test that pins the
/// exact categories of twenty named mods would fail on every honest addition
/// and teach whoever sees it to edit the expectation.

test("a mod whose words say nothing keeps no category at all", () => {
  assert.deepEqual(categorize({ title: "zzzz", tagline: "qqqq", modId: "wwww" }), []);
  assert.deepEqual(categorize({}), []);
  assert.deepEqual(categorize({ title: "   " }), []);
});

test("the specific categories outrank the broad ones on the same sentence", () => {
  // "A voxel overworld and a 3D battle view" says both VOXEL and GAMEPLAY.
  // VOXEL is the fact a player is filtering for; "battle" is scenery.
  const voxel = categorize({ title: "Voxel Ascendant",
                             tagline: "A voxel overworld and a 3D battle view, rendered inside the sandbox." });
  assert.ok(voxel.includes("VOXEL"), `expected VOXEL, got ${voxel}`);

  const translated = categorize({ title: "Pokemon Red PT-BR",
                                  tagline: "A complete Brazilian Portuguese translation with accented text." });
  assert.ok(translated.includes("TRANSLATION"), `expected TRANSLATION, got ${translated}`);
});

test("a translation in any of the languages creators actually publish in", () => {
  for (const tagline of [
    "Traducao completa para Portugues do Brasil",
    "Edición en español para Pokemon Rojo",
    "Komplette deutsche Übersetzung", // carries no keyword; the title must.
    "Traduzione italiana completa",
    "Generate ready-to-import multilingual translation mods",
  ]) {
    const got = categorize({ title: "Pokemon Blau Deutsch Mod", tagline });
    assert.ok(got.includes("TRANSLATION"), `${JSON.stringify(tagline)} -> ${got}`);
  }
});

test("never more than three, so a wordy tagline cannot file a mod under everything", () => {
  const wordy = categorize({
    title: "Everything Mod",
    tagline: "Voxel sprites, translated menus, new music, faster battles, a new region, "
           + "shortcuts, palettes, an overlay, encounters, quests and a secret base.",
  });
  assert.ok(wordy.length <= 3, `got ${wordy.length}: ${wordy}`);
  assert.ok(wordy.length > 0);
});

test("identical input gives identical output, because the manifest is rebuilt on a schedule", () => {
  const input = { title: "Bag Sort", tagline: "Sort the bag by name, quantity or type.", modId: "bag_sort" };
  assert.deepEqual(categorize(input), categorize(input));
});

test("the result is ordered by how strongly it matched, not by the table", () => {
  // Three audio words and one stray UI word: AUDIO has to lead.
  const got = categorize({ title: "Music Player",
                           tagline: "Play any music track, keep favourite songs, from a menu." });
  assert.equal(got[0], "AUDIO", `got ${got}`);
});

test("a repository slug is read as words, so a mod id alone can classify it", () => {
  const got = categorize({ title: "", tagline: "", modId: "gen1recomp-shiny-pokemon" });
  assert.ok(got.length > 0, "a slug carries words too");
});
