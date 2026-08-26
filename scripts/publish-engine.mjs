#!/usr/bin/env node
/**
 * Append one built artifact to `public/v1/engines.json`.
 *
 * Called by `.github/workflows/engine-catalog.yml` after `build_payload.sh`
 * has produced a `.love` and the release asset has been uploaded. Everything
 * it decides lives in `scripts/lib/engine-catalog.mjs` and is under test; this
 * is argument parsing and file I/O.
 *
 * Usage:
 *   publish-engine.mjs --engine gen1recomp --engine-version 0.2.27 \
 *     --upstream <sha> --snapshot-date <iso> --sha256 <hex> --bytes <n> \
 *     --url <https url> --games "red blue yellow" [--overlay-stamp <hex>] \
 *     [--shipped-in 3.9]
 *
 * `--shipped-in` is deliberately absent for anything this workflow publishes.
 * A workflow build was never chosen for anybody, and that is exactly what
 * "preview" means. It is set only when a release actually ships an engine, by
 * a human cutting that release.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { addEntry, hasPayload, payloadID, serialise, validateCatalog }
  from './lib/engine-catalog.mjs';

const CATALOG_PATH = new URL('../public/v1/engines.json', import.meta.url).pathname;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument: ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

function readCatalog() {
  try {
    return JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      // A catalog that does not exist yet is an empty one, not a failure. The
      // `note` travels with every copy of the document: anyone who opens the
      // URL directly should learn whose engines these are without having to
      // ask.
      return {
        note: 'Builds of gen1recomp (https://github.com/bryanthaboi/gen1recomp) '
          + 'by BOIS CLUB GAMES, packaged and published by Phosphor. Phosphor '
          + 'is not an official build of gen1recomp and is not endorsed by its '
          + 'authors.',
        entries: [],
      };
    }
    throw error;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = ['engine', 'upstream', 'sha256', 'bytes', 'url', 'games'];
  const missing = required.filter((key) => !args[key]);
  if (missing.length > 0) {
    throw new Error(`missing required arguments: ${missing.map((k) => `--${k}`).join(', ')}`);
  }

  const entry = {
    id: payloadID(args.engine, args.sha256),
    engineID: args.engine,
    engineVersion: args['engine-version'] ?? null,
    upstream: args.upstream,
    snapshotDate: args['snapshot-date'] ?? null,
    sha256: args.sha256,
    bytes: Number(args.bytes),
    url: args.url,
    shippedIn: args['shipped-in'] ?? null,
    games: args.games.split(/\s+/).filter(Boolean),
    // Which overlay these bytes were built with. Provenance, not something
    // the app reads: two copies of the overlay exist (this repo mirrors
    // Phosphor's), so a published payload has to be traceable to an exact
    // overlay state or a stale mirror is undetectable after the fact.
    overlay: args['overlay-stamp'] ?? null,
  };

  const catalog = readCatalog();
  if (hasPayload(catalog, entry.id)) {
    process.stdout.write(`PUBLISH_RESULT=already-published\nPUBLISH_ID=${entry.id}\n`);
    return;
  }

  const updated = addEntry(catalog, entry);
  const problems = validateCatalog(updated);
  if (problems.length > 0) {
    // Refuse to write rather than publish a document the app will reject
    // wholesale: a duplicate ordinal takes the WHOLE catalog down on every
    // device, because "the version below this one" would be ambiguous and
    // that is the single question rollback exists to answer.
    throw new Error(`refusing to write an invalid catalog:\n  ${problems.join('\n  ')}`);
  }

  mkdirSync(dirname(CATALOG_PATH), { recursive: true });
  writeFileSync(CATALOG_PATH, serialise(updated));
  const written = updated.entries.at(-1);
  process.stdout.write(
    `PUBLISH_RESULT=published\nPUBLISH_ID=${written.id}\nPUBLISH_ORDINAL=${written.ordinal}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
