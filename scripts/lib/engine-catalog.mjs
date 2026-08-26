/**
 * The published engine catalog: `public/v1/engines.json`.
 *
 * WHAT THIS LISTS. Engine artifacts Phosphor has PUBLISHED, one per release.
 * Not upstream commits. A payload is gen1recomp's source plus Phosphor's
 * overlay ported against one specific pin, so an old version cannot be rebuilt
 * from an old pin and something has to keep the built artifact.
 *
 * WHOSE ENGINES THESE ARE. They are builds of gen1recomp, by BOIS CLUB GAMES
 * (https://github.com/bryanthaboi/gen1recomp). Phosphor packages and publishes
 * them; it did not write them. Every entry carries `engineVersion`, the tag
 * upstream put on the commit, because that is the number on their own releases
 * page and the number the app shows. Nothing here may present a version in a
 * way that reads as a Phosphor build.
 *
 * THE ORDINAL IS THE POINT OF THIS FILE. `ordinal` is release order within one
 * engine, and it is what the app's rollback walks down: `nextOlder(than:)`
 * compares it, and two entries of one engine sharing one makes "the version
 * below this one" ambiguous, which is the single question rollback exists to
 * answer. The app refuses to install an entry whose ordinal collides with
 * something it already has, so a mistake here is a visible refusal on a phone
 * rather than a silent one.
 *
 * The sequence is seeded from what devices ALREADY believe: 1 and 2 for the
 * two 0.1.75 spares, 3 for the payload shipping in Phosphor 3.8. Nothing
 * renumbers under an existing install. Everything published after that counts
 * up from 4.
 */

/** Fields every entry must carry, and the shape the app decodes. */
export const REQUIRED_FIELDS = [
  'id', 'engineID', 'upstream', 'sha256', 'bytes', 'url', 'ordinal',
];

/**
 * A payload id IS `<engineID>-<sha256[0:12]>`.
 *
 * This is the whole integrity model: no signing scheme is needed because the
 * id already commits to the bytes. The app enforces it twice, on the offer and
 * on the install, so an entry that breaks the commitment is simply never
 * downloadable. Getting it wrong here means publishing something no device
 * will ever accept.
 */
export function payloadID(engineID, sha256) {
  return `${engineID}-${sha256.slice(0, 12)}`;
}

export function isSHA256Hex(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Every reason an entry is not publishable. Returns a list of problems, empty
 * when it is fine, because reporting one at a time turns a five-minute fix
 * into five workflow runs.
 */
export function validateEntry(entry) {
  const problems = [];
  for (const field of REQUIRED_FIELDS) {
    if (entry[field] === undefined || entry[field] === null) {
      problems.push(`missing ${field}`);
    }
  }
  if (problems.length > 0) return problems;

  if (!isSHA256Hex(entry.sha256)) {
    problems.push(`sha256 is not 64 lowercase hex characters: ${entry.sha256}`);
  } else if (entry.id !== payloadID(entry.engineID, entry.sha256)) {
    problems.push(
      `id ${entry.id} does not commit to its own hash `
      + `(expected ${payloadID(entry.engineID, entry.sha256)})`,
    );
  }
  if (!Number.isInteger(entry.bytes) || entry.bytes <= 0) {
    problems.push(`bytes must be a positive integer, got ${entry.bytes}`);
  }
  if (!Number.isInteger(entry.ordinal) || entry.ordinal <= 0) {
    problems.push(`ordinal must be a positive integer, got ${entry.ordinal}`);
  }
  // The app refuses a non-https entry outright, so publishing one is
  // publishing something nobody can install.
  if (typeof entry.url !== 'string' || !entry.url.startsWith('https://')) {
    problems.push(`url must be https, got ${entry.url}`);
  }
  // Optional, but the app will not offer an entry without it on a game's
  // page: it has no honest way to claim the payload runs that game.
  if (entry.games !== undefined && entry.games !== null) {
    if (!Array.isArray(entry.games) || entry.games.length === 0) {
      problems.push('games must be a non-empty array of engine tokens when present');
    }
  }
  return problems;
}

/** Every problem across the whole document, including cross-entry ones. */
export function validateCatalog(catalog) {
  const problems = [];
  if (!catalog || !Array.isArray(catalog.entries)) {
    return ['catalog has no entries array'];
  }
  const seenOrdinals = new Map();
  const seenIDs = new Set();
  for (const entry of catalog.entries) {
    for (const problem of validateEntry(entry)) {
      problems.push(`${entry.id ?? '(no id)'}: ${problem}`);
    }
    if (seenIDs.has(entry.id)) problems.push(`${entry.id}: listed twice`);
    seenIDs.add(entry.id);

    // Per engine, because two engines sharing an ordinal is normal: they are
    // separate release lines. Only a collision WITHIN one engine is ambiguous.
    const key = `${entry.engineID}/${entry.ordinal}`;
    if (seenOrdinals.has(key)) {
      problems.push(
        `${entry.engineID} ordinal ${entry.ordinal} is claimed by both `
        + `${seenOrdinals.get(key)} and ${entry.id}`,
      );
    }
    seenOrdinals.set(key, entry.id);
  }
  return problems;
}

/** The next release order for one engine. */
export function nextOrdinal(catalog, engineID) {
  const ordinals = (catalog.entries ?? [])
    .filter((entry) => entry.engineID === engineID)
    .map((entry) => entry.ordinal);
  return ordinals.length === 0 ? 1 : Math.max(...ordinals) + 1;
}

/** Has this exact artifact already been published? */
export function hasPayload(catalog, id) {
  return (catalog.entries ?? []).some((entry) => entry.id === id);
}

/**
 * Has this upstream COMMIT already been published for this engine?
 *
 * Distinct from `hasPayload`, and the more useful question for the hourly
 * workflow: `zip` is not byte-identical between runs, so repacking the same
 * commit produces a different hash and therefore a different id. Without this
 * check the workflow would publish a "new" engine every hour, each one the
 * same release with a fresh id, and every device would offer a list of
 * identical downloads.
 */
export function hasUpstream(catalog, engineID, upstream) {
  return (catalog.entries ?? []).some(
    (entry) => entry.engineID === engineID && entry.upstream === upstream,
  );
}

/**
 * Add one artifact, assigning its ordinal.
 *
 * Returns a NEW catalog; nothing is mutated, so a caller that then fails
 * validation has not already corrupted the document it was reading.
 */
export function addEntry(catalog, entry) {
  const ordinal = entry.ordinal ?? nextOrdinal(catalog, entry.engineID);
  const complete = { ...entry, ordinal };
  const problems = validateEntry(complete);
  if (problems.length > 0) {
    throw new Error(`refusing to publish ${complete.id}:\n  ${problems.join('\n  ')}`);
  }
  if (hasPayload(catalog, complete.id)) {
    throw new Error(`${complete.id} is already published`);
  }
  return {
    ...catalog,
    entries: [...(catalog.entries ?? []), complete],
  };
}

/**
 * Serialise, newest first.
 *
 * The app sorts for itself and does not depend on this, but a human opening
 * the URL should see the newest engine at the top rather than scrolling
 * through years of history to find out what is current.
 */
export function serialise(catalog) {
  const entries = [...(catalog.entries ?? [])].sort((a, b) => b.ordinal - a.ordinal);
  return `${JSON.stringify({ ...catalog, entries }, null, 2)}\n`;
}
