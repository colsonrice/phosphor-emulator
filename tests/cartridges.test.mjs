import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { cartridgesFor, CARTRIDGES } from "../scripts/enrich-catalog.mjs";

const GEN1 = ["red", "blue", "yellow"];
const GEN2 = ["gold", "silver", "crystal"];
const GEN3 = ["firered", "leafgreen"];

test("the vocabulary is the engine's eight cartridges in release order", () => {
  assert.deepEqual(CARTRIDGES, [...GEN1, ...GEN2, ...GEN3]);
});

/// The rule that was missing for two weeks: a manifest naming a GBA game has
/// to reach it, by name, by generation, or by "all".
test("an explicit games line reaches FireRed and LeafGreen", () => {
  assert.deepEqual(cartridgesFor({ games: ["firered"] }), ["firered"]);
  assert.deepEqual(cartridgesFor({ games: ["gen3"] }), GEN3);
  assert.deepEqual(cartridgesFor({ games: ["gen1", "gen3"] }), [...GEN1, ...GEN3]);
  assert.deepEqual(cartridgesFor({ games: ["all"] }), CARTRIDGES);
  assert.deepEqual(cartridgesFor({ games: ["LeafGreen", " firered "] }), GEN3);
});

/// Mirrors src/mods/ModTargets.lua `legacy`: no games line means Gen 1,
/// `gen2compat` widens it to Gen 2, and nothing widens it to Gen 3. A silent
/// manifest must never be published as a FireRed mod.
test("the legacy rule never reaches Gen 3", () => {
  assert.deepEqual(cartridgesFor({}), GEN1);
  assert.deepEqual(cartridgesFor({ gen2compat: true }), [...GEN1, ...GEN2]);
  assert.deepEqual(cartridgesFor({ games: [] }), GEN1, "an empty list is no list");
  assert.deepEqual(cartridgesFor({ games: ["emerald"] }), GEN1,
    "a token the engine does not know falls through to the legacy rule");
});

/// The other half of the contract lives in the app: a silent games line covers
/// every cartridge in the manifest's own `games`, so the manifest has to say
/// what that list was.
test("the published manifest states its vocabulary", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../public/v1/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.games, CARTRIDGES);
});
