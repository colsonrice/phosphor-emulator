// The survey cache, and the one rule every reader of it has to keep.
//
// `survey/cache/` is keyed `owner__repo__asset`, with no tag in the name, and
// most authors upload `mod.zip` (or `my_mod-1.0.zip`, renamed by hand) for
// every release. So a file at a name proves nothing about WHICH release it is.
// The survey used to read whatever sat at the name and hash it, which pairs a
// new release's URL with the digest of an old one: a catalog row that installs
// nothing, because the app's hash check refuses every byte served.
//
// Two rules, enforced here so every script keeps both:
//
//   - a cached file counts as an asset only when it matches what GitHub says
//     the asset is: its size, and its digest where GitHub recorded one (the
//     git blob SHA-1 for an archive committed to a tree)
//   - new bytes never overwrite a different file at the same name, because
//     that file may be the release a held-back row still pins. They are
//     parked beside it under a name that carries their own SHA-256, so a
//     reader holding a pin can find the right bytes without being told where.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

/// Git's own hash of a file, which is what a tree listing reports as `sha`.
export const gitBlobShaOf = (bytes) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/// Where bytes that collide with a different file at `name` are kept.
/// Content-addressed, so the name is derivable from a pin alone.
export const parkedName = (name, sha256) => `incoming__${String(sha256).slice(0, 12)}__${name}`;

/// Whether `bytes` are the asset GitHub describes. `asset.digest` is the
/// release API's `sha256:<hex>`; `asset.gitSha` is a tree entry's blob SHA-1.
/// An asset with neither (uploaded before GitHub recorded digests) is matched
/// on size alone, which is the best that can be said without downloading.
export function isTheAsset(bytes, asset) {
  if (!bytes || bytes.length !== asset.size) return false;
  const digest = typeof asset.digest === "string" ? asset.digest.replace(/^sha256:/, "") : null;
  if (digest) return sha256Of(bytes) === digest;
  if (asset.gitSha) return gitBlobShaOf(bytes) === asset.gitSha;
  return true;
}

const readOrNull = (path) => readFile(path).catch(() => null);

/// The bytes a pin names, from wherever they were left: the plain name, or
/// parked beside it. `null` when neither holds bytes that hash to the pin.
export async function readPinned(dir, name, sha256) {
  if (!name || !sha256) return null;
  for (const candidate of [name, parkedName(name, sha256)]) {
    const path = join(dir, candidate);
    const bytes = await readOrNull(path);
    if (bytes && sha256Of(bytes) === sha256) return { bytes, path, name: candidate };
  }
  return null;
}

/// A cached copy of `asset`, if one matches it: the plain name first, then
/// anything parked beside it by a previous run. Parked names are content
/// addressed, so without a digest there is no name to look for and only the
/// plain one is asked.
export async function findCachedAsset(dir, name, asset) {
  const plain = join(dir, name);
  const bytes = await readOrNull(plain);
  if (bytes && isTheAsset(bytes, asset)) return { bytes, path: plain, name };
  const digest = typeof asset.digest === "string" ? asset.digest.replace(/^sha256:/, "") : null;
  if (digest) {
    const parked = parkedName(name, digest);
    const parkedBytes = await readOrNull(join(dir, parked));
    if (parkedBytes && isTheAsset(parkedBytes, asset)) return { bytes: parkedBytes, path: join(dir, parked), name: parked };
  }
  return null;
}

/// The name new bytes should be written under: the plain name when it is free
/// or already holds these exact bytes, the parked name otherwise.
export async function nameForNewBytes(dir, name, bytes) {
  const existing = await readOrNull(join(dir, name));
  if (!existing || sha256Of(existing) === sha256Of(bytes)) return name;
  return parkedName(name, sha256Of(bytes));
}
