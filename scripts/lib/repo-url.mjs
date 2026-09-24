// Which repository a catalog URL belongs to.
//
// Three scripts carried a private copy of this regex, all reading only
// `https://github.com/owner/repo`. That was true while every install pointed
// at a release asset, and it stopped being true when the catalog learned to
// list an archive committed to a repository's tree: those are served from
// `raw.githubusercontent.com`, which the old regex answers `null` for.
//
// `null` is the expensive answer here, because of what reads it. In
// apply-survey.mjs it is looked up in the exclusion set (a held-out mod stops
// being recognised as held out) and used to match a drafted release against
// the row it updates (no match, so the row is added a second time instead of
// moved forward). In promote-direct-source.mjs it decides which project row an
// install is attached to. None of those fail loudly; they each do the wrong
// thing quietly, which is why this is one function in one place now.
const FORMS = [
  // https://github.com/owner/repo/releases/download/v1/mod.zip
  /^https:\/\/github\.com\/([^/#?]+\/[^/#?]+)/,
  // https://raw.githubusercontent.com/owner/repo/<commit>/mod.zip
  /^https:\/\/raw\.githubusercontent\.com\/([^/#?]+\/[^/#?]+)/,
];

export function repoOf(url) {
  for (const form of FORMS) {
    const hit = String(url ?? "").match(form);
    if (hit) return hit[1].toLowerCase().replace(/\.git$/, "");
  }
  return null;
}
