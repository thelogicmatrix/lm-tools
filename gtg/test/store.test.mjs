import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCollection, writeCollection, slugCollision } from '../skills/gtg/lib/store.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'gtg-store-'));

test('reads records from a directory, one file per record', () => {
  const root = tmp();
  mkdirSync(join(root, 'd'), { recursive: true });
  writeFileSync(join(root, 'd', 'alpha.json'), JSON.stringify({ slug: 'alpha', project: 'A' }));
  writeFileSync(join(root, 'd', 'beta.json'), JSON.stringify({ slug: 'beta', project: 'B' }));
  const got = readCollection(root, 'd');
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((e) => e.slug).sort(), ['alpha', 'beta']);
});

// The contraction, pinned from the outside. readCollection took (root, dir, legacyRel, legacyKey)
// and read the packed file whenever the directory was absent. The packed files are deleted, so a
// re-added fallback would read a file that is not there - and its failure shape was [], so it
// would fail no assertion anywhere and would just silently empty a list. This case is the one
// that fails if it comes back.
test('a packed file beside a missing directory is ignored, not read as a fallback', () => {
  const root = tmp();
  writeFileSync(join(root, 'legacy.json'), JSON.stringify({ items: [{ slug: 'old', project: 'O' }] }));
  assert.deepEqual(readCollection(root, 'd'), []);
});

test('an empty directory reads as an empty array', () => {
  const root = tmp();
  mkdirSync(join(root, 'd'), { recursive: true });
  assert.deepEqual(readCollection(root, 'd'), []);
});

test('a missing directory reads as empty', () => {
  assert.deepEqual(readCollection(tmp(), 'd'), []);
});

test('a malformed record file throws rather than silently vanishing', () => {
  const root = tmp();
  mkdirSync(join(root, 'd'), { recursive: true });
  writeFileSync(join(root, 'd', 'bad.json'), '{ not json');
  assert.throws(() => readCollection(root, 'd'), /bad\.json/);
});

test('write creates one file per record and reports its paths', () => {
  const root = tmp();
  const res = writeCollection(root, 'd', [{ slug: 'alpha' }, { slug: 'beta' }]);
  // .gitkeep rides along on the FIRST write, path included, so the same commit that adds the
  // records adds the thing that keeps the directory alive once they are all gone.
  assert.deepEqual(res.written.sort(), ['d/.gitkeep', 'd/alpha.json', 'd/beta.json']);
  assert.deepEqual(res.deleted, []);
  assert.deepEqual(readdirSync(join(root, 'd')).sort(), ['.gitkeep', 'alpha.json', 'beta.json']);
});

test('write deletes files for removed records and reports them', () => {
  const root = tmp();
  writeCollection(root, 'd', [{ slug: 'alpha' }, { slug: 'beta' }]);
  const res = writeCollection(root, 'd', [{ slug: 'alpha' }]);
  assert.deepEqual(res.deleted, ['d/beta.json']);
  assert.equal(existsSync(join(root, 'd', 'beta.json')), false);
  assert.equal(existsSync(join(root, 'd', 'alpha.json')), true);
});

test('unrelated record edits touch disjoint files - the point of the change', () => {
  const root = tmp();
  writeCollection(root, 'd', [{ slug: 'alpha', n: 1 }, { slug: 'beta', n: 1 }]);
  const a = writeCollection(root, 'd', [{ slug: 'alpha', n: 2 }, { slug: 'beta', n: 1 }]);
  assert.deepEqual(a.written, ['d/alpha.json']);
  const b = writeCollection(root, 'd', [{ slug: 'alpha', n: 2 }, { slug: 'beta', n: 2 }]);
  assert.deepEqual(b.written, ['d/beta.json']);
});

test('writing an empty collection deletes every record file', () => {
  const root = tmp();
  writeCollection(root, 'd', [{ slug: 'alpha' }]);
  const res = writeCollection(root, 'd', []);
  assert.deepEqual(res.deleted, ['d/alpha.json']);
  assert.deepEqual(readdirSync(join(root, 'd')).sort(), ['.gitkeep']);
});

// The failure this prevents is not local. Git cannot track an empty directory, so without the
// .gitkeep an emptied collection is ABSENT on the other machine's checkout - which used to fall
// through to the frozen packed file and get re-sharded, every deleted record back from the dead.
// The packed files are gone, so the remaining cost is that the collection reads there as a store
// that never existed and the next write re-creates it as a fresh commit, forking history. Either
// way the directory and its keeper have to survive an emptying write, which is what this pins.
// The stray packed file is left in the fixture on purpose: it must not be read.
test('an emptied collection keeps its directory, and reads empty rather than falling back', () => {
  const root = tmp();
  writeFileSync(join(root, 'legacy.json'), JSON.stringify({ items: [{ slug: 'ghost' }] }));
  writeCollection(root, 'd', [{ slug: 'alpha' }]);
  writeCollection(root, 'd', []);
  assert.equal(existsSync(join(root, 'd')), true, 'the directory must survive an emptying write');
  assert.equal(existsSync(join(root, 'd', '.gitkeep')), true, 'and git needs a file in it to carry it');
  assert.deepEqual(readCollection(root, 'd'), [],
    'an empty sharded store is a real state - the packed file must NOT resurrect its records');
});

test('record files round-trip byte-identically through read and write', () => {
  const root = tmp();
  const rec = { slug: 'alpha', project: 'A', sessions: 3, next: 'do the thing' };
  writeCollection(root, 'd', [rec]);
  assert.deepEqual(readCollection(root, 'd'), [rec]);
});

test('a record with no slug is rejected rather than written to undefined.json', () => {
  assert.throws(() => writeCollection(tmp(), 'd', [{ project: 'A' }]), /slug/);
});

test('slugCollision catches case-only duplicates', () => {
  assert.equal(slugCollision([{ slug: 'a' }, { slug: 'b' }]), null);
  assert.equal(slugCollision([{ slug: 'Alpha' }, { slug: 'alpha' }]), 'alpha');
});

test('a case-colliding write is refused before any file is touched', () => {
  const root = tmp();
  assert.throws(() => writeCollection(root, 'd', [{ slug: 'Alpha' }, { slug: 'alpha' }]), /collide/i);
  assert.equal(existsSync(join(root, 'd')), false);
});

// Alpha.json and alpha.json are two files on Obelisk and one file on reborn. Writing the
// new casing on reborn lands in the old file, so a naive delete-what-is-not-kept pass
// removes the record it just wrote.
test('a slug whose case changed keeps the record and reports both paths', () => {
  const root = tmp();
  writeCollection(root, 'd', [{ slug: 'Alpha', n: 1 }]);
  const res = writeCollection(root, 'd', [{ slug: 'alpha', n: 2 }]);
  assert.deepEqual(readCollection(root, 'd'), [{ slug: 'alpha', n: 2 }]);
  assert.deepEqual(readdirSync(join(root, 'd')).sort(), ['.gitkeep', 'alpha.json']);
  assert.deepEqual(res.deleted, ['d/Alpha.json']);
  assert.deepEqual(res.written, ['d/alpha.json']);
});

test('a path-traversing slug is refused', () => {
  assert.throws(() => writeCollection(tmp(), 'd', [{ slug: '../escape' }]), /slug/);
});
