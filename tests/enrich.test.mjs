import { test } from "node:test";
import assert from "node:assert/strict";
import { requirementsFrom, popularityFrom } from "../scripts/enrich-catalog.mjs";

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

test("optional_dependencies become worksWith; dependencies are ignored", () => {
  // `dependencies` is declared by 61 manifests and empty in every one. There
  // is no Requires line to build, and drawing one as a blocker would be a lie.
  assert.deepEqual(
    requirementsFrom({ dependencies: [], optional_dependencies: ["exp_share"], games: ["all"] }),
    { worksWith: ["exp_share"] },
  );
  assert.equal(requirementsFrom({ dependencies: ["national_dex"], games: ["all"] }), null);
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
