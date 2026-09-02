import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateCollection } from '../skills/gtg/lib/migrate.mjs';
import { readCollection } from '../skills/gtg/lib/store.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'gtg-mig-'));
// Record files only: writeCollection also drops a .gitkeep in every collection directory, which
// is what keeps an emptied collection alive in git and is not a record.
const records = (root) => readdirSync(join(root, 'docs/shard')).filter((f) => f.endsWith('.json')).sort();
const seed = (root, items) => {
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/packed.json'), JSON.stringify({ items }, null, 2) + '\n');
};

test('every record survives: count in equals count out', () => {
  const root = tmp();
  const items = Array.from({ length: 48 }, (_, i) => ({ slug: `p${i}`, project: `P${i}`, n: i }));
  seed(root, items);
  const res = migrateCollection(root, 'docs/shard', 'docs/packed.json', 'items');
  assert.equal(res.migrated, 48);
  assert.equal(res.skipped, false);
  assert.equal(records(root).length, 48);
  assert.ok(res.paths.includes('docs/shard/.gitkeep'),
    'the migration must COMMIT the keeper too, or the directory only exists on this machine');
});

test('record content is preserved field for field', () => {
  const root = tmp();
  const rec = { slug: 'a', project: 'A', sessions: 3, worktree: 'C:/dev/a', next: 'ship it' };
  seed(root, [rec]);
  migrateCollection(root, 'docs/shard', 'docs/packed.json', 'items');
  assert.deepEqual(readCollection(root, 'docs/shard', 'docs/packed.json', 'items'), [rec]);
});

test('a second run is a no-op and does not duplicate or wipe', () => {
  const root = tmp();
  seed(root, [{ slug: 'a' }, { slug: 'b' }]);
  migrateCollection(root, 'docs/shard', 'docs/packed.json', 'items');
  const again = migrateCollection(root, 'docs/shard', 'docs/packed.json', 'items');
  assert.equal(again.skipped, true);
  assert.equal(again.migrated, 0);
  assert.equal(records(root).length, 2);
});

test('a run on an already-migrated tree does not resurrect deleted records', () => {
  const root = tmp();
  seed(root, [{ slug: 'a' }, { slug: 'b' }]);
  migrateCollection(root, 'docs/shard', 'docs/packed.json', 'items');
  // simulate: the other machine parked "b", removing its file, then synced
  rmSync(join(root, 'docs/shard/b.json'));
  const again = migrateCollection(root, 'docs/shard', 'docs/packed.json', 'items');
  assert.equal(again.skipped, true);
  assert.deepEqual(records(root), ['a.json']);
});

test('a backup of the packed file is written before anything else', () => {
  const root = tmp();
  seed(root, [{ slug: 'a' }]);
  migrateCollection(root, 'docs/shard', 'docs/packed.json', 'items');
  const bak = join(root, 'docs/packed.json.pre-shard');
  assert.equal(existsSync(bak), true);
  assert.deepEqual(JSON.parse(readFileSync(bak, 'utf8')).items, [{ slug: 'a' }]);
});

test('the packed file is left in place - contraction is a separate step', () => {
  const root = tmp();
  seed(root, [{ slug: 'a' }]);
  migrateCollection(root, 'docs/shard', 'docs/packed.json', 'items');
  assert.equal(existsSync(join(root, 'docs/packed.json')), true);
});

test('nothing to migrate when the packed file is absent', () => {
  const root = tmp();
  const res = migrateCollection(root, 'docs/shard', 'docs/packed.json', 'items');
  assert.equal(res.migrated, 0);
  assert.equal(existsSync(join(root, 'docs/shard')), false);
});

test('a case collision in the source aborts before any file is written', () => {
  const root = tmp();
  seed(root, [{ slug: 'Alpha' }, { slug: 'alpha' }]);
  assert.throws(() => migrateCollection(root, 'docs/shard', 'docs/packed.json', 'items'), /collide/i);
  assert.equal(existsSync(join(root, 'docs/shard')), false);
});

// Not in the brief's list: the `if (!existsSync(bak))` guard is the only untested branch,
// and it is on the data-preservation path. Reachable when the shard dir is rolled back and
// the packed file has been written to since - the pristine backup must not be clobbered.
test('a re-migrate after a rollback keeps the original backup', () => {
  const root = tmp();
  seed(root, [{ slug: 'a' }]);
  migrateCollection(root, 'docs/shard', 'docs/packed.json', 'items');
  rmSync(join(root, 'docs/shard'), { recursive: true });
  seed(root, [{ slug: 'b' }]); // old plugin rewrote the packed file
  migrateCollection(root, 'docs/shard', 'docs/packed.json', 'items');
  const bak = JSON.parse(readFileSync(join(root, 'docs/packed.json.pre-shard'), 'utf8'));
  assert.deepEqual(bak.items, [{ slug: 'a' }]);
});
