import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCollection, writeCollection, slugCollision } from '../store.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'libcli-store-'));

test('a written collection reads back, one file per record, with a .gitkeep', () => {
  const root = tmp();
  const out = writeCollection(root, 'd', [{ slug: 'b', n: 2 }, { slug: 'a', n: 1 }]);
  assert.deepEqual(out.written.sort(), ['d/.gitkeep', 'd/a.json', 'd/b.json']);
  assert.deepEqual(readCollection(root, 'd'), [{ slug: 'a', n: 1 }, { slug: 'b', n: 2 }]);
});

test('errors carry the caller name, and store when none is given', () => {
  const root = tmp();
  assert.throws(() => writeCollection(root, 'd', [{ slug: '../x' }], { name: 'projects' }), /^Error: projects: record has an unusable slug/);
  assert.throws(() => writeCollection(root, 'd', [{ slug: 'A' }, { slug: 'a' }]), /^Error: store: slugs collide case-insensitively on "a"/);
  mkdirSync(join(root, 'e'));
  writeFileSync(join(root, 'e', 'bad.json'), '{');
  assert.throws(() => readCollection(root, 'e', { name: 'gtg' }), /^Error: gtg: cannot parse e\/bad\.json/);
});

test('a record this process never read is never deleted', () => {
  const root = tmp();
  writeCollection(root, 'd', [{ slug: 'a' }]);
  readCollection(root, 'd');
  writeFileSync(join(root, 'd', 'late.json'), '{"slug":"late"}\n');
  writeCollection(root, 'd', []);
  assert.deepEqual(readdirSync(join(root, 'd')).sort(), ['.gitkeep', 'late.json']);
});

test('slugCollision names the first case-insensitive repeat', () => {
  assert.equal(slugCollision([{ slug: 'x' }, { slug: 'Y' }, { slug: 'y' }]), 'y');
  assert.equal(slugCollision([{ slug: 'x' }]), null);
});
