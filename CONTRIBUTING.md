# Contributing a release

1. Confirm that the creator permits redistribution of the exact patch or mod.
2. Confirm the archive contains no commercial ROM or extracted third-party
   assets that the creator cannot redistribute.
3. Open the repository's **Submit a release** issue form for permission review.
4. After approval, add a record to `src/data/releases.json` using the schema
   described below.
5. Run `npm test` and `npm run build`, then open a pull request containing the
   metadata and permission evidence.

Repository owners can instead use the automated issue review flow described in
the README. Approval verifies the submitted checksum, rejects ROM files, checks
for a bundled open-source license, updates the catalog, and deploys the site.

## Record fields

- `id`: stable lowercase slug
- `title`, `creator`, `version`, `releaseDate`
- `category`: `rom-hack`, `gen1recomp`, or `gen2recomp`
- `compatibility`: every catalog channel in which the release should appear
- `target`: base game or recomp target
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
