import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCollection, writeCollection, slugCollision } from '../skills/gtg/lib/store.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'gtg-store-'));

test('reads records from a directory, one file per record', () => {
  const root = tmp();
  mkdirSync(join(root, 'd'), { recursive: true });
  writeFileSync(join(root, 'd', 'alpha.json'), JSON.stringify({ slug: 'alpha', project: 'A' }));
  writeFileSync(join(root, 'd', 'beta.json'), JSON.stringify({ slug: 'beta', project: 'B' }));
  const got = readCollection(root, 'd', 'legacy.json', 'items');
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((e) => e.slug).sort(), ['alpha', 'beta']);
});

test('falls back to the packed legacy file when the directory is absent', () => {
  const root = tmp();
  writeFileSync(join(root, 'legacy.json'), JSON.stringify({ items: [{ slug: 'old', project: 'O' }] }));
  const got = readCollection(root, 'd', 'legacy.json', 'items');
  assert.deepEqual(got.map((e) => e.slug), ['old']);
});

test('empty directory reads as an empty array, not a fallback to legacy', () => {
  const root = tmp();
  mkdirSync(join(root, 'd'), { recursive: true });
  writeFileSync(join(root, 'legacy.json'), JSON.stringify({ items: [{ slug: 'old' }] }));
  assert.deepEqual(readCollection(root, 'd', 'legacy.json', 'items'), []);
});

test('missing directory and missing legacy file reads as empty', () => {
  assert.deepEqual(readCollection(tmp(), 'd', 'legacy.json', 'items'), []);
});

test('a malformed record file throws rather than silently vanishing', () => {
  const root = tmp();
  mkdirSync(join(root, 'd'), { recursive: true });
  writeFileSync(join(root, 'd', 'bad.json'), '{ not json');
  assert.throws(() => readCollection(root, 'd', 'legacy.json', 'items'), /bad\.json/);
});

test('write creates one file per record and reports its paths', () => {
  const root = tmp();
  const res = writeCollection(root, 'd', [{ slug: 'alpha' }, { slug: 'beta' }]);
  assert.deepEqual(res.written.sort(), ['d/alpha.json', 'd/beta.json']);
  assert.deepEqual(res.deleted, []);
  assert.deepEqual(readdirSync(join(root, 'd')).sort(), ['alpha.json', 'beta.json']);
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

test('writing an empty collection deletes every file', () => {
  const root = tmp();
  writeCollection(root, 'd', [{ slug: 'alpha' }]);
  const res = writeCollection(root, 'd', []);
  assert.deepEqual(res.deleted, ['d/alpha.json']);
  assert.deepEqual(readdirSync(join(root, 'd')), []);
});

test('record files round-trip byte-identically through read and write', () => {
  const root = tmp();
  const rec = { slug: 'alpha', project: 'A', sessions: 3, next: 'do the thing' };
  writeCollection(root, 'd', [rec]);
  assert.deepEqual(readCollection(root, 'd', 'legacy.json', 'items'), [rec]);
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

test('a path-traversing slug is refused', () => {
  assert.throws(() => writeCollection(tmp(), 'd', [{ slug: '../escape' }]), /slug/);
});
