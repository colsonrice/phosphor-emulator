// Which engine a listing runs on, as a field the app can filter by.
//
// `target` is free text. A human types it into src/data when they paste a
// drafted row, and after a year of that there are nine spellings for two
// engines: "Gen1Recomp", "Gen1Recomp · R/B/Y", "Gen1Recomp + Gen2Recomp",
// "Gen2Recomp · Gold", and so on. It reads well on a card and it cannot be a
// filter facet, because "Gen 1" as a chip would have to match six of those
// strings and would silently miss the seventh.
//
// So the structured field is derived HERE, on the publishing side. The
// alternative — a table of spellings inside the app — rots the first time
// somebody invents a tenth, and its failure mode is the bad one: a filter
// that quietly hides mods, on a build already in players' hands, with nothing
// on screen saying anything is missing. A table here fails a build instead,
// in front of the person who just typed the new spelling.
//
// `compatibility` decides the family and `target` decides the games, because
// that is where each is actually written down. They must agree: a target
// string naming Gen 2 on a row whose compatibility says gen1recomp is a typo,
// and it stops the build.

/// The engine versions this catalog's `game_version` ranges were evaluated
/// against — the versions Phosphor actually ships.
///
/// Lives here rather than in survey-mods.mjs because two callers need it and
/// they need it to agree: the survey applies it as a gate, and
/// build-manifest.mjs publishes it so the app can tell whether the catalog it
/// fetched was built for the engine it is running. It was a private constant
/// in the survey and went stale three times, invisibly, because nothing that
/// could notice ever saw it.
///
/// Check against `LoveCore/GEN1RECOMP_VERSION` in the app repo whenever the
/// pin moves. The app's own suite fails when these disagree now, which is the
/// point of publishing it.
export const ENGINE_VERSIONS = { gen1recomp: "0.2.27" };

/// The two families, spelled the way the APP spells them.
///
/// The site says `gen2recomp` and the app says `gen2recomped`, which is a
/// difference that has produced a silent mismatch before (see ENGINE_IDS in
/// build-manifest.mjs). This field is read by the app, so it uses the app's
/// vocabulary and the translation happens once, here.
export const GEN1 = "gen1recomp";
export const GEN2 = "gen2recomped";
/// Runs under either engine. Not a third engine: a filter for one family
/// matches it, and the app never has to install "both" as such.
export const BOTH = "both";

/// The site's own channel names, which are neither of the above.
const CHANNEL_GEN1 = "gen1recomp";
const CHANNEL_GEN2 = "gen2recomp";

/// Every `target` string in the catalog that names an engine, and what it
/// means. The games are lowercase and use the app's own vocabulary for a
/// cartridge, not the abbreviation the string happens to use.
///
/// An empty `games` is not "unknown": it means the listing does not narrow
/// itself to particular games, which is what most of the catalog does.
export const ENGINE_BY_TARGET = {
  "Gen1Recomp": { family: GEN1, games: [] },
  "Gen1Recomp · R/B/Y": { family: GEN1, games: ["red", "blue", "yellow"] },
  "Gen1Recomp · Red": { family: GEN1, games: ["red"] },
  "Gen1Recomp · Yellow": { family: GEN1, games: ["yellow"] },
  "Gen1Recomp and Gen2Recomped": { family: BOTH, games: [] },
  "Gen1Recomp + Gen2Recomp": { family: BOTH, games: [] },
  "Gen2Recomped": { family: GEN2, games: [] },
  "Gen2Recomp · Gold": { family: GEN2, games: ["gold"] },
  "Gen2Recomped · Gold / Silver": { family: GEN2, games: ["gold", "silver"] },
};

/// The family a row's `compatibility` names, or null when it names no engine
/// at all.
///
/// Null is the ROM-hack case and it is a real answer, not a failure: a hack
/// targets a cartridge, so its `target` is a game's name and there is no
/// engine to file it under. Those rows carry no engine field and are never
/// looked up in the table above, which is why "Pokémon Crystal" being absent
/// from it is not a hole.
export function familyForChannels(channels = []) {
  const gen1 = channels.includes(CHANNEL_GEN1);
  const gen2 = channels.includes(CHANNEL_GEN2);
  if (gen1 && gen2) return BOTH;
  if (gen2) return GEN2;
  if (gen1) return GEN1;
  return null;
}

/// Whether a family covers one particular engine.
export function familyCovers(family, engine) {
  return family === BOTH || family === engine;
}

/// The structured engine field for one listing, or null when the listing
/// names no engine.
///
/// `installsInto` is the engine id of the entry actually being emitted, and it
/// wins over `compatibility` when it is given. build-manifest.mjs fans a
/// dual-engine release out into one entry PER engine, and each of those
/// entries installs into exactly one: publishing "both" on both halves would
/// make a Gen 2 filter return the Gen 1 listing of the same mod, sitting
/// beside its twin with the same name and the same tagline. The mod is
/// compatible with both; this entry is not.
///
/// Throws on a `target` the table has never seen, and on one that contradicts
/// `compatibility`. Both are the same mistake — a hand-typed string nobody
/// taught the catalog — and both must stop a build rather than reach a player
/// as a listing their engine filter drops.
export function engineFacet({ target, channels = [], installsInto = null, label = "entry" }) {
  const fromChannels = familyForChannels(channels);
  if (!fromChannels) return null;

  const declared = ENGINE_BY_TARGET[target];
  if (!declared) {
    throw new Error(
      `${label}: target "${target}" is not one of the engine spellings this catalog knows. ` +
      `Add it to ENGINE_BY_TARGET in scripts/engine-family.mjs with the family it means ` +
      `and the games it names, or use one of: ${Object.keys(ENGINE_BY_TARGET).join(", ")}`,
    );
  }
  if (declared.family !== fromChannels) {
    throw new Error(
      `${label}: target "${target}" says ${declared.family} but compatibility ` +
      `[${channels.join(", ")}] says ${fromChannels}. One of the two is a typo.`,
    );
  }

  if (installsInto) {
    if (!familyCovers(declared.family, installsInto)) {
      throw new Error(
        `${label}: emitted for ${installsInto}, which target "${target}" does not cover`,
      );
    }
    return { family: installsInto, games: declared.games };
  }
  return { family: declared.family, games: declared.games };
}

/// Every target string in a set of hand-edited rows, checked against the
/// table. Returns the errors rather than throwing, so a caller can report all
/// of them at once instead of one per run.
export function auditTargets(rows, label = "row") {
  const errors = [];
  for (const row of rows) {
    try {
      engineFacet({
        target: row.target,
        channels: row.compatibility ?? [],
        label: `${label} ${row.id ?? "(no id)"}`,
      });
    } catch (error) {
      errors.push(error.message);
    }
  }
  return errors;
}
