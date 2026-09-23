# Catalog policy

Phosphor Index never hosts, mirrors or re-serves anybody's file. Every install
in the catalog points at the creator's own release asset on their own hosting,
and the app pins the SHA-256 of the exact bytes a human looked at: a swapped
asset fails verification and installs nothing. That is true of both tiers below
and it is the reason the second tier is possible at all.

**Tier 1, permission verified.** A public URL shows an open licence or explicit
redistribution permission. These carry a `license` field and sit on the
catalog's ordinary shelves.

**Tier 2, direct from source.** The creator has granted nothing and has not
been asked. Phosphor links their own release asset and fetches it on the
player's behalf, exactly as the player's browser would if they clicked through,
with the hash pinned so what arrives is what was reviewed. These are marked
`permission: "none-direct-source"`, keep `reviewStatus: "permission-needed"`,
keep the "From their creators" shelf, and always show a link to the project
itself. Phosphor does not describe them as reviewed, approved, or endorsed,
because they are none of those things.

**A kind is not an endorsement** (Sep 22 2026). These used to carry the
`PENDING` shelf and NOTHING ELSE, which meant they were absent from every
taxonomy chip in the app: 233 of 379 entries, 214 of them installable, so
tapping Gameplay or Interface silently hid three fifths of the catalog and the
chip row advertised 43 Gameplay over 379 rows. A player who had been told a
mod's name was shown an empty list.

`scripts/lib/categorize.mjs` now derives a kind from the listing's own words,
and `PENDING` stays beside it rather than being replaced. The distinction that
matters is the one the manifest tests enforce: a derived fact is not an
editorial one. VOXEL was already granted this exception for being read out of
the mod's own archive, and a tagline that says "a complete Brazilian
Portuguese translation" is a fact about the mod in exactly the same way. What
must never happen is a tier 2 row being FILED by hand onto a shelf, and
`tests/manifest.test.mjs` re-derives every one of them from its published
words and requires the same answer, which a hand-filed category cannot
survive.

**What decides a tier 2 listing is what the archive does, never what licence
it carries** (Sep 19 2026). Phosphor is free, the community asks for its mods
to be playable, and a creator who wants out is one message away from being
out. So every mod the survey can find is listed unless something measured
stops it: the archive could not be opened, carries a ROM, sits outside the
installer's ceilings, writes to the love table the sandbox protects, or rules
out the engine Phosphor ships. `scripts/lib/excluded.mjs` holds the few kept
out for what they are, each with its reason: online play with strangers that
Phosphor cannot moderate (guideline 4.7.1), a server taking custody of a
player's save, a hard dependency nothing carries. None of those is a licence.

A tier 2 listing must still clear every safety check tier 1 does: a verified
SHA-256, a known file size, and an archive proven to contain no base-game ROM.
A ROM hack is never tier 2, because a hack that is not a patch is a cartridge.

Creator requests are honoured immediately in both tiers, and a creator who
grants permission moves to tier 1. This tier exists because the ecosystem is
overwhelmingly unlicensed and a catalog that showed only the licensed fraction
misrepresented the field it indexes; it does not exist because consent is
unimportant.
An author's permission to redistribute their patch or mod does not grant rights
to redistribute a base-game ROM or other third-party copyrighted material.
Permission review reduces risk; it is not a guarantee that every underlying
third-party right has been licensed. Obtain qualified legal advice before a
public launch or after any rights complaint.

## Required for every release

- A stable project homepage and named creator or team.
- A public URL showing an open license or explicit redistribution permission.
- A patch/mod archive rather than a commercial ROM image.
- A SHA-256 checksum for the exact hosted file.
- A version, release date, target platform, and file size.
- A declaration that the archive contains no base-game ROM.

## Accepted file types

Patch formats: `.ips`, `.ups`, `.bps`, `.xdelta`, `.vcdiff`.

Recomp mods may use `.zip` or `.tar.gz` when the archive contains only original
mod files and redistribution permission covers the complete archive.

## Images

Images are optional for the first version. The future image pipeline must store
the image source, creator, permission evidence, checksum, and whether the image
is creator-supplied or captured in-game. Images fail closed: missing provenance
means they are not published.

Game screenshots require their own review. Creator permission for a mod does not
automatically grant permission for game art, characters, or other third-party
content visible in a capture.

## Removal

Creator requests and credible rights complaints should immediately hide the
affected listing while it is reviewed. Keep a removal contact visible before
the first public file is added.
