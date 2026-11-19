import test from "node:test";
import assert from "node:assert/strict";

import { buildManifest } from "../scripts/build-manifest.mjs";
import { EXCLUDED } from "../scripts/lib/excluded.mjs";
import { publishedGen1Versions, retiredEngineTarget } from "../scripts/lib/retired-engine.mjs";

const PUBLISHED = ["0.1.75", "0.3.53", "0.4.8"];

/// The three that went live on Nov 19 2026, as they described themselves.
/// S&J's AIO names the engine only in its listing, never in its manifest,
/// which is why the listing's words are part of what is judged.
test("a mod that names Gen2Recomped and needs an engine gen1recomp never shipped is caught", () => {
  for (const [text, range] of [
    ["Kanto Life for Gen2Recomped", ">=0.7.6 <2.0.0"],
    ["INDIGO//97 player and service characters for Gen2Recomped.", ">=0.7.6 <1.0.0"],
    ["S&J's AIO for Gen 2 All in one mod for gen2recomp GEN 2", ">=0.7.6 <1.0.0"],
  ]) {
    assert.match(retiredEngineTarget({ text, range }, PUBLISHED) ?? "", /built for Gen2Recomped/, text);
  }
});

/// Each fact alone is not enough, and both of these are real listings.
test("naming Gen2Recomp alone, or needing a newer engine alone, is not a Gen2Recomped mod", () => {
  // Mods that also run on Gen2Recomped and declare a range gen1recomp meets.
  assert.equal(retiredEngineTarget({ text: "HMs without teaching them in Gen2Recomp", range: ">=0.0.0-0 <2.0.0" }, PUBLISHED), null);
  assert.equal(retiredEngineTarget({ text: "Pokemon Crystal no Gen2Recomped", range: ">=0.0.0-0 <2.0.0" }, PUBLISHED), null);
  // A gen1recomp mod ahead of the engine pin is published on purpose (Sep 23 2026).
  assert.equal(retiredEngineTarget({ text: "a gen1recomp mod", range: ">=0.7.6" }, PUBLISHED), null);
  // No range is no claim about an engine at all.
  assert.equal(retiredEngineTarget({ text: "Gen2Recomped", range: "" }, PUBLISHED), null);
  // An unreadable engine catalog judges nothing rather than everything.
  assert.equal(retiredEngineTarget({ text: "Gen2Recomped", range: ">=0.7.6" }, []), null);
});

test("the rule is judged against the engines this site has published", () => {
  const versions = publishedGen1Versions();
  assert.ok(versions.includes("0.4.8"), "public/v1/engines.json lists the shipped engine");
});

/// The published catalog, end to end: no entry the rule recognises, and none
/// of the three by repository either, whatever gen1recomp's version becomes.
test("no published entry is a Gen2Recomped mod", async () => {
  const { entries } = await buildManifest();
  for (const entry of entries) {
    const why = retiredEngineTarget({
      text: [entry.id, entry.name, entry.tagline, entry.description, entry.modID, entry.author?.url].join(" "),
      range: entry.requirements?.engineRange,
    });
    assert.equal(why, null, entry.id);
  }
  const retired = ["jtfresh90/kantolife-gen2recomped", "n47h4ni3l/gen2recomp-indigo97", "shadowjackyl/S-J-s-AIO-Gen-2"];
  for (const repo of retired) {
    assert.ok(EXCLUDED[repo], `${repo} is held out by repository`);
    const listed = entries.filter((entry) => (entry.author?.url ?? "").toLowerCase().endsWith(`/${repo.toLowerCase()}`));
    assert.deepEqual(listed.map((entry) => entry.id), [], `${repo} is not published`);
  }
});
