// Applies the survey's drafts to src/data: every mod it found that the catalog
// does not list, and every listed mod whose creator has released since.
//
// The survey writes nothing to src/data by design, and for a long time the
// step after it was a person pasting rows. That is how the catalog came to
// trail the field it indexes: on Sep 19 2026 the survey held 33 licensed mods
// and 54 unlicensed ones the catalog had never heard of, and 20 listings were
// pinned to a release their creator had moved past, some by twenty versions.
// The bottleneck was never supply or judgement. It was this paste.
//
// What it does NOT decide is whether a mod may be listed. The survey did, on
// what it measured (`blocking`), and scripts/lib/excluded.mjs holds the mods
// kept out for what they do. This only moves rows.
//
//   tier 1 update   a listed release row whose repo + mod id has a newer
//                   drafted release: version, date, file, size and hash move;
//                   the hand-written title, summary, topic and images stay
//   tier 1 new      a drafted release for a repo with no release row. Its
//                   project row, if it had one, goes: a mod is on one shelf
//   tier 2 new      a drafted project row; promote-direct-source.mjs gives it
//                   an install afterwards, on the same evidence
//
// Usage: node scripts/apply-survey.mjs [--write]
// Then:  node scripts/promote-direct-source.mjs --write
//        node scripts/verify-releases.mjs --fill
//        node scripts/backfill-mod-games.mjs --write
//        node scripts/backfill-mod-imports.mjs --write
//        npm run build:manifest && npm test

import { readFile, writeFile } from "node:fs/promises";

import { EXCLUDED } from "./lib/excluded.mjs";

const RELEASES = new URL("../src/data/releases.json", import.meta.url);
const PROJECTS = new URL("../src/data/projects.json", import.meta.url);
/// `--from report-dropped` reads the drafts a hand-fed survey left beside its
/// own report (draft-releases.report-dropped.json), instead of the standing ones.
const from = process.argv.includes("--from") ? process.argv[process.argv.indexOf("--from") + 1] : null;
const draft = (kind) => new URL(`../survey/draft-${kind}${from ? `.${from}` : ""}.json`, import.meta.url);
const DRAFT_RELEASES = draft("releases");
const DRAFT_PROJECTS = draft("projects");
const write = process.argv.includes("--write");

const repoOf = (url) =>
  (url ?? "").match(/^https:\/\/github\.com\/([^/#?]+\/[^/#?]+)/)?.[1]?.toLowerCase()
    .replace(/\.git$/, "") ?? null;
const excluded = new Set(Object.keys(EXCLUDED).map((k) => k.toLowerCase()));

/// The fields a new release moves. Everything else on a row is somebody's
/// sentence, and a release is not a reason to lose it.
const MOVES = ["version", "releaseDate", "fileUrl", "fileName", "fileSize", "fileSizeBytes", "sha256"];

/// A draft's tagline is a placeholder ("TODO tagline"), and its description is
/// the creator's own. The first whole sentence of that is the honest tagline:
/// their words, not truncated mid-thought, and not ours pretending to be a
/// review. A description with no sentence end is used whole.
export function taglineFrom(description, fallback) {
  const text = String(description ?? "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  const end = text.search(/[.!?](\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1);
}

/// A drafted release row in the shape the published rows have.
export function releaseRowFrom(draft) {
  const { description, engine, summary, ...row } = draft;
  return { ...row, summary: taglineFrom(description, draft.title) };
}

async function main() {
  const releases = JSON.parse(await readFile(RELEASES, "utf8"));
  const projects = JSON.parse(await readFile(PROJECTS, "utf8"));
  const draftReleases = JSON.parse(await readFile(DRAFT_RELEASES, "utf8"));
  const draftProjects = JSON.parse(await readFile(DRAFT_PROJECTS, "utf8"));

  const updated = [], added = [], moved = [], listed = [], skipped = [];
  const takenIds = new Set([...releases, ...projects].map((row) => row.id));

  for (const draft of draftReleases) {
    const repo = repoOf(draft.fileUrl);
    if (excluded.has(repo)) { skipped.push([draft.id, "held out for what it does"]); continue; }

    // One repo can publish several mods (six do), so the mod id decides which
    // row a release belongs to. Fan-out rows share both and all move together.
    const rows = releases.filter((row) => repoOf(row.fileUrl) === repo && row.modId === draft.modId);
    if (rows.length) {
      for (const row of rows) {
        if (row.sha256 === draft.sha256) continue;
        updated.push([row.id, `${row.version} -> ${draft.version}`]);
        for (const key of MOVES) row[key] = draft[key];
        // The manifest can move between releases; verify-releases --fill
        // reads it back out of the new bytes rather than trusting the old one.
        delete row.manifestPath;
      }
      continue;
    }
    if (releases.some((row) => repoOf(row.fileUrl) === repo)) {
      // Same repo, a mod id the catalog does not carry from it: a second mod
      // in one repository. Left for a person, because which asset belongs to
      // which mod is not something the survey's one-asset-per-repo read knows.
      skipped.push([draft.id, "its repo is listed under a different mod id"]);
      continue;
    }

    const row = releaseRowFrom(draft);
    const project = projects.findIndex((p) => repoOf(p.homepageUrl) === repo);
    if (project !== -1) {
      // Keep the id players' install ledgers already know it by.
      row.id = projects[project].id;
      moved.push([row.id, "link-out -> licensed release"]);
      projects.splice(project, 1);
    } else if (takenIds.has(row.id)) {
      row.id = `${repo.split("/")[0].replace(/[^a-z0-9]+/g, "-")}-${row.id}`;
    }
    takenIds.add(row.id);
    releases.push(row);
    added.push([row.id, `${row.version} (${row.license})`]);
  }

  for (const draft of draftProjects) {
    const repo = repoOf(draft.homepageUrl);
    if (excluded.has(repo)) { skipped.push([draft.id, "held out for what it does"]); continue; }
    if ([...releases.map((r) => repoOf(r.fileUrl)), ...projects.map((p) => repoOf(p.homepageUrl))].includes(repo)) continue;
    const row = { ...draft };
    if (takenIds.has(row.id)) row.id = `${repo.split("/")[0].replace(/[^a-z0-9]+/g, "-")}-${row.id}`;
    takenIds.add(row.id);
    projects.push(row);
    listed.push([row.id, repo]);
  }

  const say = (title, rows) => {
    console.log(`${title}: ${rows.length}`);
    for (const [id, note] of rows) console.log(`   ${id} — ${note}`);
  };
  say("listed releases moved to a newer release", updated);
  say("new licensed mods (tier 1)", added);
  say("  of which were link-outs before", moved);
  say("new mods to list from their creators (tier 2 after promotion)", listed);
  say("left alone", skipped);

  if (write) {
    await writeFile(RELEASES, JSON.stringify(releases, null, 2) + "\n");
    await writeFile(PROJECTS, JSON.stringify(projects, null, 2) + "\n");
    console.log("\nwrote src/data/releases.json and src/data/projects.json");
  } else {
    console.log("\n(dry run, pass --write to save)");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
