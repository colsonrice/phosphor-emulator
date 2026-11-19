import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { cartridgesFor, CARTRIDGES, expandToken, requirementsFrom } from "../scripts/enrich-catalog.mjs";

const GEN1 = ["red", "blue", "yellow"];
const GEN2 = ["gold", "silver", "crystal"];
const FRLG = ["firered", "leafgreen"];
const RSE = ["ruby", "sapphire", "emerald"];
const GEN3 = [...FRLG, ...RSE];

/// gen1recomp v0.4.8, src/core/GameVersion.lua: `GameVersion.ORDER`. Ruby and
/// Sapphire come BEFORE Emerald and after LeafGreen; the chips and every
/// games line are written in this order, so a list sorted any other way
/// compares unequal to the engine's own.
test("the vocabulary is the engine's eleven cartridges in GameVersion.ORDER", () => {
  assert.deepEqual(CARTRIDGES, [
    "red", "blue", "yellow", "gold", "silver", "crystal",
    "firered", "leafgreen", "ruby", "sapphire", "emerald",
  ]);
});

/// The rule that was missing for two weeks for FireRed, and for two months for
/// Hoenn: a manifest naming a GBA game has to reach it, by name, by
/// generation, by layout family, or by "all".
test("an explicit games line reaches every GBA cartridge", () => {
  assert.deepEqual(cartridgesFor({ games: ["firered"] }), ["firered"]);
  assert.deepEqual(cartridgesFor({ games: ["emerald"] }), ["emerald"]);
  assert.deepEqual(cartridgesFor({ games: ["sapphire", "ruby"] }), ["ruby", "sapphire"]);
  assert.deepEqual(cartridgesFor({ games: ["gen3"] }), GEN3);
  assert.deepEqual(cartridgesFor({ games: ["gen1", "gen3"] }), [...GEN1, ...GEN3]);
  assert.deepEqual(cartridgesFor({ games: ["all"] }), CARTRIDGES);
  assert.deepEqual(cartridgesFor({ games: ["LeafGreen", " firered "] }), FRLG);
  // The order a manifest lists them in is not the order they are published in.
  assert.deepEqual(cartridgesFor({ games: ["emerald", "ruby", "sapphire", "firered", "leafgreen"] }), GEN3);
});

/// `ModTargets.expand` takes `^gen%s*(%d+)$` and, since the Hoenn games
/// arrived, a layout family (`GameVersion.layout`): "frlg" and "rse".
test("generations may be spaced, and layout families expand", () => {
  assert.deepEqual(expandToken("gen 2"), GEN2);
  assert.deepEqual(expandToken("GEN3"), GEN3);
  assert.deepEqual(expandToken("frlg"), FRLG);
  assert.deepEqual(expandToken("RSE"), RSE);
  assert.equal(expandToken("gen4"), null, "a generation the engine has no game for names nothing");
  assert.equal(expandToken("platinum"), null);
  assert.equal(expandToken(3), null);
  assert.deepEqual(cartridgesFor({ games: ["rse", "gold"] }), ["gold", ...RSE]);
});

/// Mirrors src/mods/ModTargets.lua `legacy`: no games line means Gen 1,
/// `gen2compat` widens it to Gen 2, and nothing widens it to Gen 3. A silent
/// manifest must never be published as a GBA mod.
test("the legacy rule never reaches Gen 3", () => {
  assert.deepEqual(cartridgesFor({}), GEN1);
  assert.deepEqual(cartridgesFor({ gen2compat: true }), [...GEN1, ...GEN2]);
  assert.deepEqual(cartridgesFor({ games: [] }), GEN1, "an empty list is no list");
  assert.deepEqual(cartridgesFor({ games: ["platinum"] }), GEN1,
    "a token the engine does not know falls through to the legacy rule");
  assert.deepEqual(cartridgesFor({ games: ["platinum"], gen2compat: true }), [...GEN1, ...GEN2]);
});

/// `Manifest.validate`: "gen2compat is kept as its Gen 2 spelling and only
/// ever ADDS Gen 2". The catalog used to let an explicit list win outright,
/// which published a mod the engine loads on Crystal as Red-only.
test("gen2compat still adds Gen 2 beside an explicit list", () => {
  assert.deepEqual(cartridgesFor({ games: ["red"], gen2compat: true }), ["red", ...GEN2]);
  assert.deepEqual(cartridgesFor({ games: ["emerald"], gen2compat: true }), [...GEN2, "emerald"]);
  assert.deepEqual(cartridgesFor({ games: ["red"], gen2compat: false }), ["red"]);
});

/// Silence used to mean "every cartridge this catalog knows", and was what a
/// row said when nothing had ever read it. An explicit line is written for
/// every manifest, including one that covers everything.
test("a games line is published even for a mod that covers every cartridge", () => {
  assert.deepEqual(requirementsFrom({ games: ["all"] })?.games, CARTRIDGES);
  assert.deepEqual(requirementsFrom({})?.games, GEN1);
});

/// The other half of the contract lives in the app: a row's games line is
/// read against the manifest's own `games`, so the manifest has to say what
/// that list was.
test("the published manifest states its vocabulary", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../public/v1/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.games, CARTRIDGES);
});
