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
stay on the "From their creators" shelf rather than a curated one, and always
show a link to the project itself. Phosphor does not describe them as reviewed,
approved, or endorsed, because they are none of those things.

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
