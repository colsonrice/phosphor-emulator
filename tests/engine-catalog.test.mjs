import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addEntry,
  hasPayload,
  hasUpstream,
  nextOrdinal,
  payloadID,
  serialise,
  validateCatalog,
  validateEntry,
} from '../scripts/lib/engine-catalog.mjs';

const HASH_A = 'a54cd6fc1ab40a52265904665669740a22f51477619ababf9f8f183f7178b121';
const HASH_B = 'a0d04b927d2b0f82d58ade620e3ebef2fd94a9b1437f1916e8fb042cbf547e72';

function entry(overrides = {}) {
  const sha256 = overrides.sha256 ?? HASH_A;
  const engineID = overrides.engineID ?? 'gen1recomp';
  return {
    id: payloadID(engineID, sha256),
    engineID,
    engineVersion: '0.2.27',
    upstream: '7797962f664b52a25c25db9952d367c340dd6bc0',
    snapshotDate: '2026-08-26T09:00:00-04:00',
    sha256,
    bytes: 8656726,
    url: 'https://github.com/colsonrice/phosphor-emulator/releases/download/gen1recomp-0.2.27/x.love',
    shippedIn: null,
    ordinal: 4,
    games: ['red', 'blue', 'yellow'],
    ...overrides,
  };
}

test('a payload id commits to its own bytes', () => {
  assert.equal(payloadID('gen1recomp', HASH_A), 'gen1recomp-a54cd6fc1ab4');
});

test('an entry whose id does not reproduce from its hash is refused', () => {
  const problems = validateEntry(entry({ id: 'gen1recomp-deadbeefcafe' }));
  assert.ok(problems.some((p) => p.includes('does not commit to its own hash')));
});

test('a truncated hash is refused: it cannot verify a download', () => {
  const problems = validateEntry(entry({ sha256: 'a54cd6fc1ab4', id: 'gen1recomp-a54cd6fc1ab4' }));
  assert.ok(problems.some((p) => p.includes('64 lowercase hex')));
});

test('a non-https url is refused, because the app will not offer it', () => {
  const problems = validateEntry(entry({ url: 'http://example.test/x.love' }));
  assert.ok(problems.some((p) => p.includes('url must be https')));
});

test('every missing required field is reported at once', () => {
  const incomplete = entry();
  delete incomplete.sha256;
  delete incomplete.bytes;
  const problems = validateEntry(incomplete);
  assert.ok(problems.includes('missing sha256'));
  assert.ok(problems.includes('missing bytes'));
});

test('ordinals count up per engine', () => {
  const catalog = { entries: [entry({ ordinal: 1 }), entry({ sha256: HASH_B, ordinal: 3 })] };
  assert.equal(nextOrdinal(catalog, 'gen1recomp'), 4);
  assert.equal(nextOrdinal(catalog, 'someotherengine'), 1);
});

test('two entries of ONE engine may not share an ordinal', () => {
  const catalog = {
    entries: [entry({ ordinal: 4 }), entry({ sha256: HASH_B, ordinal: 4 })],
  };
  const problems = validateCatalog(catalog);
  assert.ok(problems.some((p) => p.includes('ordinal 4 is claimed by both')));
});

test('two DIFFERENT engines may share an ordinal: separate release lines', () => {
  const catalog = {
    entries: [
      entry({ ordinal: 4 }),
      entry({ sha256: HASH_B, engineID: 'someotherengine', ordinal: 4 }),
    ],
  };
  assert.deepEqual(validateCatalog(catalog), []);
});

test('adding an artifact assigns the next ordinal', () => {
  const catalog = { entries: [entry({ ordinal: 3 })] };
  const next = entry({ sha256: HASH_B });
  delete next.ordinal;
  const updated = addEntry(catalog, next);
  assert.equal(updated.entries.at(-1).ordinal, 4);
  assert.deepEqual(validateCatalog(updated), []);
});

test('addEntry does not mutate the catalog it was given', () => {
  const catalog = { entries: [entry({ ordinal: 3 })] };
  addEntry(catalog, entry({ sha256: HASH_B }));
  assert.equal(catalog.entries.length, 1);
});

test('publishing the same artifact twice is refused', () => {
  const catalog = { entries: [entry({ ordinal: 3 })] };
  assert.throws(() => addEntry(catalog, entry({ ordinal: 4 })), /already published/);
});

test('an invalid artifact is refused rather than written', () => {
  assert.throws(
    () => addEntry({ entries: [] }, entry({ url: 'http://nope.test/x.love' })),
    /url must be https/,
  );
});

// The check that keeps the hourly workflow from filling the catalog with
// duplicates. zip is not byte-identical between runs, so repacking one commit
// produces a fresh hash and therefore a fresh id: hasPayload would say "new"
// every single hour.
test('an upstream commit already published is recognised even under a new id', () => {
  const catalog = { entries: [entry({ ordinal: 4 })] };
  const repacked = entry({ sha256: HASH_B, ordinal: 5 });
  assert.equal(hasPayload(catalog, repacked.id), false);
  assert.equal(hasUpstream(catalog, 'gen1recomp', repacked.upstream), true);
});

test('a different upstream commit is genuinely new', () => {
  const catalog = { entries: [entry({ ordinal: 4 })] };
  assert.equal(hasUpstream(catalog, 'gen1recomp', '0c6c813e87d61a0b61ebd904cbb98a830a8f4be1'), false);
});

test('serialising puts the newest engine first', () => {
  const catalog = {
    entries: [entry({ ordinal: 1 }), entry({ sha256: HASH_B, ordinal: 7 })],
  };
  const parsed = JSON.parse(serialise(catalog));
  assert.deepEqual(parsed.entries.map((e) => e.ordinal), [7, 1]);
});

test('shippedIn null means preview, and a value means it shipped', () => {
  // The one field that decides what a player sees. Derived rather than
  // stamped, so an archived preview stays a preview: its status simply
  // reflects whether it ever shipped.
  const preview = entry({ shippedIn: null });
  const shipped = entry({ sha256: HASH_B, shippedIn: '3.9' });
  assert.deepEqual(validateEntry(preview), []);
  assert.deepEqual(validateEntry(shipped), []);
});

test('the games list, when present, must not be empty', () => {
  const problems = validateEntry(entry({ games: [] }));
  assert.ok(problems.some((p) => p.includes('non-empty array')));
});
