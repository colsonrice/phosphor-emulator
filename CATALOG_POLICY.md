# Catalog policy

Phosphor Index may index an official project page while its permission review is
pending, but it only lists or mirrors a downloadable file when redistribution
permission can be verified. Pending project cards link to the creator's official
source and never expose an unapproved mirror.
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
