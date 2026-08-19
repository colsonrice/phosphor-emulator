# Contributing a release

1. Confirm that the creator permits redistribution of the exact patch or mod.
2. Confirm the archive contains no commercial ROM or extracted third-party
   assets that the creator cannot redistribute.
3. Open the repository's **Submit a release** issue form for permission review.
4. After approval, add a record to `src/data/releases.json` using the schema
   described below.
5. Run `node scripts/verify-releases.mjs --fill` to fill `manifestPath` and
   confirm every row still matches the bytes it points at.
6. Run `npm test` and `npm run build`, then open a pull request containing the
   metadata and permission evidence.

## What changes here breaks over in the app

The app fetches this manifest, so two of its tests are assertions about content
published from this repo. Neither can fail here, which is the point of writing
them down:

- `gbal8rTests/Fixtures/published-manifest.json` is a byte copy of
  `public/v1/manifest.json`. Refresh it in the app repo whenever this file
  changes, or the app is testing a catalog that no longer exists.
- `DiscoverPublishedManifestTests` pins that **both manifest depths stay
  represented**: at least one listing with its manifest at the archive root,
  and at least one nesting it a directory down. Not the counts, which would
  fail on every honest addition. Publishing an ordinary mod, at either depth,
  needs nothing done there.

  It fails only if a whole group empties. The depth-1 group is the one that
  matters: `maxManifestDepth` exists for it, since depth 0 alone would be
  satisfied by a bound of zero, so if every published archive were flattened
  the app's bound would stop being exercised by real data and could drift
  unnoticed. If that ever happens on purpose, the test is the thing to
  reconsider, and it says so.

`manifestPath` exists for the same reason: the app asserts that nothing
published sits deeper than its own installer will look
(`RecompModLibrary.maxManifestDepth`, mirrored here as `maxManifestDepth` in
`scripts/validate-catalog.mjs`). Reaching deeper finds the mod bundled inside a
device package and installs it under its author's name.

Repository owners can instead use the automated issue review flow described in
the README. Approval verifies the submitted checksum, rejects ROM files, checks
for a bundled open-source license, updates the catalog, and deploys the site.

## Record fields

- `id`: stable lowercase slug
- `title`, `creator`, `version`, `releaseDate`
- `category`: `rom-hack`, `gen1recomp`, or `gen2recomp`
- `compatibility`: every catalog channel in which the release should appear
- `target`: base game or recomp target. On a row that names an engine this is
  ALSO read by `scripts/engine-family.mjs`, which turns it into the
  `engine.family` the app's Workshop filters by. Use a spelling that table
  already knows, or add yours to it: an unrecognised one fails the survey and
  the manifest build rather than reaching players as a mod their engine filter
  quietly hides. A ROM hack's target names a cartridge and is not checked.
- `summary`: plain-language description
- `fileUrl`, `fileName`, `fileSize`, `sha256`
- `homepageUrl`: canonical project page
- `permission`: `open-license` or `author-approved`
- `license`, `licenseIncluded`: the license name and confirmation that its text
  ships inside the exact archive
- `permissionEvidenceUrl`: public evidence covering redistribution
- `containsRom`: must be `false`
- `images`: optional array; leave empty until image provenance is verified

Do not commit large release binaries directly to the default branch. Point
`fileUrl` at a GitHub Release asset or another approved, durable host.
