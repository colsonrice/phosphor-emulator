/// The one archive reader.
///
/// Three scripts need the same three answers out of a release zip, and a
/// hand-rolled second copy of this logic has already cost this repo real mods
/// in both directions: `unzip` treats a backslash in its match pattern as an
/// escape, and ten live releases are Windows-made and store "MOD\manifest.json".
/// A reader that splits paths on "/" alone reports every one of them as "not a
/// mod", silently, which reads downstream as a catalog that is simply smaller.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/// Entry names as stored, keyed by their normalised form, plus the
/// uncompressed size of each.
///
/// One `unzip -l` for both, because the callers below want the names and the
/// sizes together and listing a large archive twice is the slow half of the
/// survey.
export async function entryNames(path) {
  const { stdout } = await run("unzip", ["-l", path], { maxBuffer: 64 * 1024 * 1024 });
  const names = new Map();
  const sizes = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/);
    if (!m) continue;
    names.set(m[2].replace(/\\/g, "/"), m[2]);
    sizes.push(Number(m[1]));
  }
  return { names, sizes };
}

/// The shallowest manifest.json among already-listed entry names.
///
/// Shallowest wins, and that is a rule rather than a convenience: a `git
/// archive` release nests under `<name>-<version>/`, so a repo keeping its mod
/// in `mods/<id>/` is three deep, while an unbounded search reaches into a
/// bundled device pak and reads the manifest of the mod *it* ships.
function shallowest(names) {
  return [...names.keys()]
    .filter((name) => name.split("/").filter(Boolean).at(-1) === "manifest.json")
    .sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)
    .at(0) ?? null;
}

/// The shallowest manifest.json in the archive, how deep it sits, and the two
/// ceilings `RecompModLibrary` enforces on the way in.
///
/// Separators are normalised first: a Windows-made archive stores "MOD\..."
/// where the spec requires "/", real mods ship that way, and counting depth
/// without normalising silently misreads every one of them.
export async function manifestIn(path) {
  const { names, sizes } = await entryNames(path);
  const found = shallowest(names);
  if (!found) return null;

  return {
    path: found,
    depth: found.split("/").filter(Boolean).length - 1,
    entryCount: names.size,
    totalUncompressed: sizes.reduce((sum, n) => sum + n, 0),
  };
}

/// One entry's bytes, asked for by the name the archive actually stores.
///
/// `unzip` reads its argument as a match pattern where a backslash escapes the
/// next character, so a Windows-made entry has to be escaped to be asked for
/// by name at all. Six real mods, four of them MIT, were nearly lost to this.
export async function readEntry(path, normalisedName, names) {
  const stored = (names ?? (await entryNames(path)).names).get(normalisedName)
    ?? normalisedName;
  const pattern = stored.replace(/\\/g, "\\\\");
  const { stdout } = await run("unzip", ["-p", path, pattern],
                               { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/// The mod's own manifest, parsed.
///
/// `null` when the archive has none or the bytes are not JSON. Both mean "this
/// archive cannot describe itself", which a caller must COUNT rather than
/// skip: folding "could not read" into "nothing to say" is how a reader loses
/// ten archives and still reports success.
export async function readManifest(path) {
  const { names } = await entryNames(path);
  const found = shallowest(names);
  if (!found) return null;

  try {
    return JSON.parse(await readEntry(path, found, names));
  } catch {
    return null;
  }
}
