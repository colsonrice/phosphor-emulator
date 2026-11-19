import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findCachedAsset, gitBlobShaOf, isTheAsset, nameForNewBytes, parkedName, readPinned, sha256Of,
} from "../scripts/lib/cache.mjs";

const OLD = Buffer.from("mod.zip as released in v1.0");
const NEW = Buffer.from("mod.zip as released in v1.1, same name, new bytes");
const NAME = "someone__a-mod__mod.zip";

async function withCache(files, body) {
  const dir = await mkdtemp(join(tmpdir(), "cache-test-"));
  try {
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), bytes);
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/// The defect this exists for: a cache hit at the right NAME holding an older
/// release's bytes. The size, and the digest GitHub lists, are what tell them
/// apart; the name never can, because it carries no tag.
test("a cached file is the asset only when its size and digest are", () => {
  const asset = { size: NEW.length, digest: `sha256:${sha256Of(NEW)}` };
  assert.equal(isTheAsset(NEW, asset), true);
  assert.equal(isTheAsset(OLD, asset), false);
  assert.equal(isTheAsset(Buffer.concat([OLD, Buffer.alloc(NEW.length - OLD.length)]), asset), false,
    "same size, different bytes");
  // A tree archive is described by git's blob hash instead.
  assert.equal(isTheAsset(NEW, { size: NEW.length, gitSha: gitBlobShaOf(NEW) }), true);
  assert.equal(isTheAsset(NEW, { size: NEW.length, gitSha: gitBlobShaOf(OLD) }), false);
  // An asset GitHub recorded no digest for can only be matched on size.
  assert.equal(isTheAsset(NEW, { size: NEW.length }), true);
  assert.equal(isTheAsset(NEW, { size: NEW.length + 1 }), false);
});

test("git's blob hash is the one a tree listing reports", () => {
  // `printf 'hello\n' | git hash-object --stdin`
  assert.equal(gitBlobShaOf(Buffer.from("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
});

test("new bytes never overwrite different bytes at the same name", async () => {
  await withCache({ [NAME]: OLD }, async (dir) => {
    assert.equal(await nameForNewBytes(dir, NAME, NEW), parkedName(NAME, sha256Of(NEW)));
    assert.equal(await nameForNewBytes(dir, NAME, OLD), NAME, "the same bytes again are not a collision");
  });
  await withCache({}, async (dir) => {
    assert.equal(await nameForNewBytes(dir, NAME, NEW), NAME, "a free name is used as is");
  });
});

/// A reader holds a pin, not a path. The parked name is derivable from the
/// pin, so neither tier has to be told where a run left its bytes.
test("a pin finds its bytes at the plain name or parked beside it, and nothing else", async () => {
  const parked = parkedName(NAME, sha256Of(NEW));
  await withCache({ [NAME]: OLD, [parked]: NEW }, async (dir) => {
    assert.equal((await readPinned(dir, NAME, sha256Of(OLD)))?.name, NAME);
    assert.equal((await readPinned(dir, NAME, sha256Of(NEW)))?.name, parked);
    assert.equal(await readPinned(dir, NAME, "0".repeat(64)), null);
    assert.equal(await readPinned(dir, null, sha256Of(OLD)), null);
  });
});

test("a cached asset is found at the plain name or parked, by its digest", async () => {
  const parked = parkedName(NAME, sha256Of(NEW));
  const asset = { size: NEW.length, digest: `sha256:${sha256Of(NEW)}` };
  await withCache({ [NAME]: OLD, [parked]: NEW }, async (dir) => {
    assert.equal((await findCachedAsset(dir, NAME, asset))?.name, parked);
  });
  await withCache({ [NAME]: OLD }, async (dir) => {
    assert.equal(await findCachedAsset(dir, NAME, asset), null, "a stale hit is a miss");
  });
});
