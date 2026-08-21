import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { manifestIn, readManifest } from "../scripts/lib/archive.mjs";

const run = promisify(execFile);

/// Two archives that differ ONLY in their separator. Ten real releases in the
/// live catalog are the second kind, and a reader that splits on "/" alone
/// reports every one of them as "not a mod".
async function fixtures() {
  const dir = await mkdtemp(join(tmpdir(), "archive-test-"));

  await mkdir(join(dir, "MOD"), { recursive: true });
  await writeFile(join(dir, "MOD", "manifest.json"), JSON.stringify({ id: "posix" }));
  await run("zip", ["-q", "-r", "posix.zip", "MOD"], { cwd: dir });

  // A single file whose NAME contains a backslash, which is how a
  // Windows-made archive stores a nested path.
  await writeFile(join(dir, "MOD\\manifest.json"), JSON.stringify({ id: "windows" }));
  await run("zip", ["-q", "windows.zip", "MOD\\manifest.json"], { cwd: dir });

  await writeFile(join(dir, "readme.txt"), "hello");
  await run("zip", ["-q", "bare.zip", "readme.txt"], { cwd: dir });

  return dir;
}

test("finds the manifest in a posix archive", async (t) => {
  const dir = await fixtures();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const found = await manifestIn(join(dir, "posix.zip"));
  assert.equal(found.path, "MOD/manifest.json");
  assert.equal(found.depth, 1);
  assert.equal((await readManifest(join(dir, "posix.zip"))).id, "posix");
});

test("finds the manifest in a backslash archive", async (t) => {
  const dir = await fixtures();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const found = await manifestIn(join(dir, "windows.zip"));
  assert.equal(found.path, "MOD/manifest.json");
  assert.equal(found.depth, 1);
  assert.equal((await readManifest(join(dir, "windows.zip"))).id, "windows");
});

test("an archive with no manifest answers null, not a throw", async (t) => {
  const dir = await fixtures();
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal(await manifestIn(join(dir, "bare.zip")), null);
  assert.equal(await readManifest(join(dir, "bare.zip")), null);
});

test("the shallowest manifest wins", async (t) => {
  const dir = await fixtures();
  t.after(() => rm(dir, { recursive: true, force: true }));

  // A `git archive` release nests everything under <name>-<version>/, and a
  // repo keeping its mod in mods/<id>/ puts the real manifest three deep. The
  // shallow one is the mod's own; a deeper one can belong to a bundled pak.
  await mkdir(join(dir, "deep", "nested", "inner"), { recursive: true });
  await writeFile(join(dir, "deep", "manifest.json"), JSON.stringify({ id: "shallow" }));
  await writeFile(join(dir, "deep", "nested", "inner", "manifest.json"),
                  JSON.stringify({ id: "buried" }));
  await run("zip", ["-q", "-r", "deep.zip", "deep"], { cwd: dir });

  assert.equal((await readManifest(join(dir, "deep.zip"))).id, "shallow");
  assert.equal((await manifestIn(join(dir, "deep.zip"))).depth, 1);
});
