import { test } from "node:test";
import assert from "node:assert/strict";
import { requirementsFrom, importsFrom, popularityFrom } from "../scripts/enrich-catalog.mjs";

// Several fixtures below carry `games: ["all"]`. That is not what they test:
// it keeps the games line out of the answer so each test still asserts one
// field. Without it every fixture would also disclose "Gen 1 only", which is
// correct (see the games test) and would bury the point being made.

test("a mod with nothing to say produces nothing", () => {
  assert.equal(requirementsFrom({ id: "x", games: ["all"] }), null);
});

test("engine_internals is not a disclosure", () => {
  // Every one of the mods that declares any permission declares this one. A
  // line every mod carries tells the player nothing, and printing it would
  // repeat the mistake this feature is deleting from the detail screen.
  assert.equal(requirementsFrom({ permissions: ["engine_internals"], games: ["all"] }), null);
  assert.deepEqual(
    requirementsFrom({ permissions: ["engine_internals", "filesystem"], games: ["all"] }),
    { permissions: ["filesystem"] },
  );
});

test("optional_dependencies become worksWith; an EMPTY dependencies says nothing", () => {
  assert.deepEqual(
    requirementsFrom({ dependencies: [], optional_dependencies: ["exp_share"], games: ["all"] }),
    { worksWith: ["exp_share"] },
  );
});

test("a hard dependency is published, because the engine blocks the mod without it", () => {
  // This asserted the opposite until Sep 19 2026, and was right to: every
  // manifest that declared `dependencies` left it empty. Six published mods
  // now declare a real one, the loader answers "missing dependency: <id>",
  // and the Workshop was installing them without a word.
  assert.deepEqual(requirementsFrom({ dependencies: ["national_dex"], games: ["all"] }),
    { requires: ["national_dex"] });
  // The range is the loader's business; the app resolves the bare id against
  // what is installed.
  assert.deepEqual(
    requirementsFrom({ dependencies: ["gen2_dex@^1.2.2", "DRAMALESS_SHAPE@>=1.6.3 <2.0.0"], games: ["all"] }),
    { requires: ["gen2_dex", "DRAMALESS_SHAPE"] },
  );
  assert.deepEqual(requirementsFrom({ dependencies: [{ id: "gimmick_menu", version: ">=1" }, "gimmick_menu"], games: ["all"] }),
    { requires: ["gimmick_menu"] });
  // A range written with a space instead of "@" is still not part of the id.
  assert.deepEqual(requirementsFrom({ dependencies: ["national_dex >=0.3", " gen2_dex\t^1"], games: ["all"] }),
    { requires: ["national_dex", "gen2_dex"] });
  assert.equal(requirementsFrom({ dependencies: [7, null, "", { name: "x" }], games: ["all"] }), null);
  assert.equal(requirementsFrom({ dependencies: "national_dex", games: ["all"] }), null);
});

test("conflicts are carried verbatim", () => {
  assert.deepEqual(
    requirementsFrom({ conflicts: ["DRAMATIC_SHAPE", "free_fly"], games: ["all"] }),
    { conflicts: ["DRAMATIC_SHAPE", "free_fly"] },
  );
});

test("flags are carried only when true", () => {
  assert.equal(requirementsFrom({ experimental: false, affects_link: false, games: ["all"] }), null);
  assert.deepEqual(
    requirementsFrom({ experimental: true, affects_link: true, games: ["all"] }),
    { affectsLink: true, experimental: true },
  );
});

test("games are published whenever a mod does not cover every cartridge", () => {
  // This test used to assert the opposite, and its reasoning was sound at the
  // time: with Gen 2 retired, "gen1" and "blue, red, yellow" named every game
  // the app could offer, so the line was a constant worth deleting. gen1recomp
  // brought silver back on Aug 20 and crystal on Aug 24, and the moment the
  // engine ran six games "Gen 1 only" stopped being a constant and became the
  // single most important thing a Crystal owner can be told before installing.
  // The rule follows the engine's own src/mods/ModTargets.lua.

  // Still constants: these cover every cartridge.
  assert.equal(requirementsFrom({ games: ["gen1", "gen2"] }), null);
  assert.equal(requirementsFrom({ games: ["all"] }), null);
  assert.equal(requirementsFrom({ gen2compat: true }), null);

  // Gen 1 only, which is most of the catalog and the whole point of this line.
  assert.deepEqual(requirementsFrom({ games: ["gen1"] }), { games: ["red", "blue", "yellow"] });
  assert.deepEqual(requirementsFrom({ games: ["blue", "red", "yellow"] }),
                   { games: ["red", "blue", "yellow"] });
  // No games key and no gen2compat is the legacy default, and it means Gen 1.
  // The engine refuses those on a Gen 2 game as `wrong_generation`, so saying
  // nothing here would promise an install the loader silently declines.
  assert.deepEqual(requirementsFrom({ id: "legacy-mod" }), { games: ["red", "blue", "yellow"] });

  // Gold is a cartridge again, so a mod naming it names a real game.
  assert.deepEqual(requirementsFrom({ games: ["gen1", "gold"] }),
                   { games: ["red", "blue", "yellow", "gold"] });
  assert.deepEqual(requirementsFrom({ games: ["crystal"] }), { games: ["crystal"] });

  assert.deepEqual(requirementsFrom({ games: ["yellow"] }), { games: ["yellow"] });
  assert.deepEqual(requirementsFrom({ games: ["Yellow"] }), { games: ["yellow"] },
                   "case is the author's business, not the player's");
  // Order follows the engine's launcher order, never the author's spelling.
  assert.deepEqual(requirementsFrom({ games: ["yellow", "red"] }), { games: ["red", "yellow"] });
});

test("a network permission survives, because it is the one that refuses", () => {
  // The sandbox denies sockets unconditionally, so this is the disclosure that
  // changes what the install button says.
  assert.deepEqual(requirementsFrom({ permissions: ["network"], games: ["all"] }), { permissions: ["network"] });
});

test("a real manifest from the catalog reads the way the survey counted it", () => {
  // Exp Multiplier, as published. Nothing to disclose but its optional
  // dependency: engine_internals is dropped and both flags are false.
  assert.deepEqual(
    requirementsFrom({
      id: "EXP_MULTIPLIER", api: 2, game_version: ">=0.1.0 <2.0.0", games: ["yellow"],
      dependencies: [], optional_dependencies: ["exp_share"], conflicts: [],
      permissions: ["engine_internals"], affects_link: false, experimental: false,
    }),
    { worksWith: ["exp_share"], games: ["yellow"] },
  );
});

// MARK: imports

/// The shape of StadiumBattleFX 2.1.8.1's two blocks. The digests and the
/// filenames are DUMMIES on purpose: the real ones identify commercial ROMs,
/// this repository is public, and a test file is publishing too.
const STADIUM_FX_IMPORTS = {
  required_imports: [{
    id: "stadium1_rom", name: "Pokemon Stadium (USA) v1.0 ROM",
    file: "first.bin", format: "n64", md5: "00000000000000000000000000000001",
  }],
  optional_imports: [{
    id: "stadium2_rom", name: "Pokemon Stadium 2 (USA) ROM",
    file: "second.bin", format: "n64", md5: "00000000000000000000000000000002",
  }],
};

test("a file the player must supply is disclosed, required ones first", () => {
  // The engine refuses the mod ("required import missing: <name>") until the
  // player supplies that exact file, and before this the catalog said nothing:
  // the first a player heard of it was a mod that installed and would not load.
  assert.deepEqual(requirementsFrom({ ...STADIUM_FX_IMPORTS, games: ["all"] }), {
    imports: [
      { name: "Pokemon Stadium (USA) v1.0 ROM", required: true },
      { name: "Pokemon Stadium 2 (USA) ROM", required: false },
    ],
  });
});

test("an import publishes its name and whether it is required, and nothing else", () => {
  // The md5 identifies a commercial ROM and the filename is where the engine
  // looks for it. Neither is needed to tell a player what to go and find, the
  // app reads both from the installed manifest when it collects the file, and
  // a catalog has no business being a lookup table for cartridge hashes.
  const [entry] = importsFrom({
    required_imports: [{
      id: "crystal_rom", name: "Pokemon Crystal (English UE) ROM",
      description: "Required source ROM.", file: "third.bin", format: "raw",
      size: 2097152, md5: ["00000000000000000000000000000003", "00000000000000000000000000000004"],
    }],
  });
  assert.deepEqual(Object.keys(entry).sort(), ["name", "required"]);
  assert.deepEqual(entry, { name: "Pokemon Crystal (English UE) ROM", required: true });
});

test("an import with no name of its own is shown by its id, as the app shows it", () => {
  // RecompModFileStore falls back the same way, so the line a player reads
  // before installing names the same thing as the row they fill in after.
  assert.deepEqual(importsFrom({ required_imports: [{ id: "stadium1_rom", file: "first.bin", md5: "x" }] }),
    [{ name: "stadium1_rom", required: true }]);
  assert.deepEqual(importsFrom({ required_imports: [{ id: "rom", name: "   ", file: "fourth.bin" }] }),
    [{ name: "rom", required: true }]);
});

test("a name that is really a filename or a hash is not published as one", () => {
  // `name` is free text, and nothing stops an author typing the file into it.
  // The rule is that a filename or a digest never reaches the catalog, so the
  // id stands in, and when that is no better a plain description does. The
  // entry itself is never dropped: that would publish "needs nothing".
  assert.deepEqual(importsFrom({ required_imports: [{ id: "base_rom", name: "first.z64" }] }),
    [{ name: "base_rom", required: true }]);
  assert.deepEqual(importsFrom({ required_imports: [{ id: "base_rom", name: "0123456789abcdef0123456789abcdef" }] }),
    [{ name: "base_rom", required: true }]);
  assert.deepEqual(importsFrom({ required_imports: [{ id: "game.gbc", name: "GAME.GBC" }] }),
    [{ name: "A file from the original game", required: true }]);
  // An ordinary name that merely ends a sentence is left alone.
  assert.deepEqual(importsFrom({ required_imports: [{ id: "x", name: "Pokemon Stadium (USA) v1.0 ROM" }] }),
    [{ name: "Pokemon Stadium (USA) v1.0 ROM", required: true }]);
});

test("the same file declared twice is said once", () => {
  assert.deepEqual(
    importsFrom({ required_imports: [{ id: "a", name: "A ROM" }, { id: "b", name: "A ROM" }],
                  optional_imports: [{ id: "c", name: "A ROM" }] }),
    [{ name: "A ROM", required: true }]);
});

test("a mod that declares no imports says nothing about them", () => {
  assert.equal(importsFrom({}), null);
  assert.equal(importsFrom({ required_imports: [], optional_imports: [] }), null);
  assert.equal(requirementsFrom({ required_imports: [], games: ["all"] }), null);
});

test("a malformed imports block is skipped rather than published as a blank line", () => {
  // `manifest.json` is whatever its author typed. An entry with neither a name
  // nor an id would draw "Needs a file from you: " and then nothing.
  assert.equal(importsFrom({ required_imports: "first.bin" }), null);
  assert.equal(importsFrom({ required_imports: [null, "x", 7, {}, { file: "fourth.bin" }] }), null);
  assert.deepEqual(
    importsFrom({ required_imports: [{}, { id: "rom", name: "A ROM" }], optional_imports: { id: "x" } }),
    [{ name: "A ROM", required: true }],
  );
});

// MARK: popularity

test("a repo with no release assets has no popularity block at all", () => {
  // NOT { downloads: 0 }. A mod distributed outside GitHub releases is
  // unmeasured, not unpopular, and the two must never share a bucket: that is
  // how a network blip becomes a delisting.
  assert.equal(popularityFrom({ stargazers_count: 12 }, [], "2026-08-21"), null);
  assert.equal(popularityFrom({ stargazers_count: 12 }, [{ assets: [] }], "2026-08-21"), null);
  assert.equal(popularityFrom(null, null, "2026-08-21"), null);
});

test("downloads sum across every asset of every release", () => {
  const releases = [
    { assets: [{ download_count: 100 }, { download_count: 5 }] },
    { assets: [{ download_count: 21 }] },
  ];
  assert.deepEqual(
    popularityFrom({ stargazers_count: 84 }, releases, "2026-08-21"),
    { downloads: 126, stars: 84, asOf: "2026-08-21" },
  );
});

test("a release with assets that nobody downloaded is a measured zero", () => {
  // Distinct from the absent case above, and the whole reason the schema has
  // both: this repo published a file and nobody took it.
  assert.deepEqual(
    popularityFrom(null, [{ assets: [{ download_count: 0 }] }], "2026-08-21"),
    { downloads: 0, asOf: "2026-08-21" },
  );
});

test("stars are omitted rather than zeroed when the repo call failed", () => {
  assert.deepEqual(
    popularityFrom(null, [{ assets: [{ download_count: 7 }] }], "2026-08-21"),
    { downloads: 7, asOf: "2026-08-21" },
  );
});

test("a declared network permission that the code never uses is not published", () => {
  // Check what a mod requires, not what it declares. Pokewalker declares
  // `network` and never loads a network module: it reads `mod.steps`, a field
  // of the mod object. Publishing the declaration made the app refuse the one
  // working mod the rule applies to.
  assert.equal(
    requirementsFrom({ permissions: ["engine_internals", "network"], games: ["all"] }, { usesNetwork: false }),
    null,
  );
  assert.deepEqual(
    requirementsFrom({ permissions: ["network", "steps"], games: ["all"] }, { usesNetwork: false }),
    { permissions: ["steps"] },
  );
});

test("a network permission the code DOES use is still published", () => {
  assert.deepEqual(
    requirementsFrom({ permissions: ["network"], games: ["all"] }, { usesNetwork: true }),
    { permissions: ["network"] },
  );
  // Unchecked stays published: withholding on 'we did not look' would silently
  // let a mod that needs sockets through as installable.
  assert.deepEqual(requirementsFrom({ permissions: ["network"], games: ["all"] }), { permissions: ["network"] });
});

// MARK: where the published bytes are cached

test("a row's archive is looked up where the script that hashed it left it", async () => {
  const { cacheNameFor } = await import("../scripts/backfill-mod-imports.mjs");
  // Tier 1: verify-releases.mjs, under the catalog id.
  assert.equal(
    cacheNameFor({ id: "stadium-battle-fx", fileName: "STADIUM_BATTLE_FX-2.1.8.1.zip" }),
    "published__stadium-battle-fx__STADIUM_BATTLE_FX-2.1.8.1.zip",
  );
  // Tier 2: survey-mods.mjs, under owner__repo__asset, with the asset's own
  // name rather than its URL-encoded one.
  assert.equal(
    cacheNameFor({ id: "x", directSource: {
      fileUrl: "https://github.com/someone/some-mod/releases/download/v1.0/Some%20Mod.zip" } }),
    "someone__some-mod__Some Mod.zip",
  );
  // No release asset to find it by is "unread", which stops the write. So is a
  // host that merely contains the word, and an escape that does not decode.
  assert.equal(cacheNameFor({ id: "x", directSource: { fileUrl: "https://example.com/mod.zip" } }), null);
  assert.equal(cacheNameFor({ id: "x", directSource: {
    fileUrl: "https://notgithub.com/a/b/releases/download/v1/m.zip" } }), null);
  assert.equal(cacheNameFor({ id: "x", directSource: {
    fileUrl: "https://github.com/a/b/releases/download/v1/%ZZ.zip" } }), null);
});
