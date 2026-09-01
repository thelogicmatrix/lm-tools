// One-way packed -> sharded conversion, safe to run any number of times on any machine.
// The guard is the DIRECTORY's existence, not a flag file: once the sharded store exists it
// is the truth, and re-reading the packed file would resurrect records the other machine
// deleted. This is the case that actually happens - Obelisk pulls a migrated tree and the
// migration runs again on startup.
import { existsSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeCollection, slugCollision } from './store.mjs';

export function migrateCollection(root, dir, legacyRel, legacyKey) {
  if (existsSync(join(root, dir))) return { migrated: 0, skipped: true, paths: [] };

  const legacy = join(root, legacyRel);
  if (!existsSync(legacy)) return { migrated: 0, skipped: false, paths: [] };

  let items;
  try {
    const d = JSON.parse(readFileSync(legacy, 'utf8'));
    items = Array.isArray(d?.[legacyKey]) ? d[legacyKey].filter(Boolean) : [];
  } catch (e) {
    throw new Error(`gtg: cannot read ${legacyRel} to migrate it - ${e.message}`);
  }

  const collision = slugCollision(items);
  if (collision) {
    throw new Error(`gtg: ${legacyRel} has slugs that collide on "${collision}" - fix them before migrating`);
  }

  // Backup FIRST. This is a one-way transform on live data; the restore is a file copy back.
  const bak = `${legacy}.pre-shard`;
  if (!existsSync(bak)) copyFileSync(legacy, bak);

  const { written } = writeCollection(root, dir, items);

  // The packed file stays. Deleting it here would make a plugin rollback strand the data;
  // Task 7 removes it once the sharded store has been the only reader for a release.
  return { migrated: items.length, skipped: false, paths: [...written, `${legacyRel}.pre-shard`] };
}
