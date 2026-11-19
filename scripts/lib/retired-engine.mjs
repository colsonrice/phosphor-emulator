// Mods built for Gen2Recomped, the engine Phosphor removed in 3.8 over its
// licence, that arrive claiming gen1recomp.
//
// build-manifest's RETIRED_ENGINES catches a row whose `compatibility` names
// the retired engine. It cannot catch these: the survey files every mod under
// gen1recomp (one engine ships, see `channelsFor`), so a Gen2Recomped mod
// reaches the catalog as an ordinary gen1recomp row. On Nov 19 2026 three went
// live that way (Kanto Life for Gen2Recomped, INDIGO//97, S&J's AIO for Gen
// 2), each needing engine `>=0.7.6`, which is Gen2Recomped's version line:
// gen1recomp was at 0.4.8 and has never shipped a 0.7. The app's own
// published-manifest test is what caught them.
//
// Two facts together, because neither alone is enough:
//   - the mod's own words name Gen2Recomp(ed). Alone that is not enough:
//     several mods say they also run there and declare a range gen1recomp
//     satisfies (`>=0.0.0-0 <2.0.0`), and the engine loads them
//   - its declared engine range is satisfied by NO gen1recomp release ever
//     published. Alone that is not enough either: the catalog publishes mods
//     ahead of the engine pin on purpose (Sep 23 2026), and a gen1recomp mod
//     needing tomorrow's release looks the same
//
// Once gen1recomp itself reaches 0.7.6 the second fact stops holding for
// these three, which is why they are ALSO in scripts/lib/excluded.mjs by
// repository: the rule catches the next one, the list keeps these out.

import { readFileSync } from "node:fs";

import { satisfies } from "./semver.mjs";

/// "Gen2Recomp", "Gen2Recomped", "gen2recomp", "Gen 2 Recomp".
export const NAMES_RETIRED_ENGINE = /gen\s*2\s*recomp/i;

/// Every gen1recomp version this site has ever published, from the engine
/// catalog the app downloads from. Empty when that file is unreadable, which
/// makes the rule judge nothing rather than everything.
export function publishedGen1Versions(url = new URL("../../public/v1/engines.json", import.meta.url)) {
  try {
    const { entries } = JSON.parse(readFileSync(url, "utf8"));
    return [...new Set((entries ?? [])
      .filter((entry) => entry?.engineID === "gen1recomp" && typeof entry.engineVersion === "string")
      .map((entry) => entry.engineVersion))];
  } catch {
    return [];
  }
}

/// Why a mod is a Gen2Recomped mod, or null. `text` is everything the mod and
/// its listing say about themselves; `range` is its declared `game_version`.
export function retiredEngineTarget({ text, range }, versions = publishedGen1Versions()) {
  const declared = typeof range === "string" ? range.trim() : "";
  if (!declared || versions.length === 0) return null;
  if (!NAMES_RETIRED_ENGINE.test(String(text ?? ""))) return null;
  if (versions.some((version) => satisfies(version, declared))) return null;
  return `built for Gen2Recomped, the engine Phosphor removed in 3.8: it names that engine `
    + `and needs ${declared}, which no published gen1recomp release satisfies`;
}
