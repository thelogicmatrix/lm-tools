// ponytail: a near-copy of gtg/skills/gtg/lib/migrate.mjs, for the same reason its sibling
// store.mjs is one: the two plugins install and version independently through the plugin
// cache, so a cross-plugin import would break on a version skew. A change here probably
// belongs there too.
//
// One-way packed -> sharded conversion, safe to run any number of times on any machine.
// The guard is the DIRECTORY's existence, not a flag file: once the sharded store exists it
// is the truth, and re-reading the packed file would resurrect records the other machine
// deleted. This is the case that actually happens - Obelisk pulls a migrated tree and the
// migration runs again on the next command.
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
    throw new Error(`projects: cannot read ${legacyRel} to migrate it - ${e.message}`);
  }

  // DIVERGES from gtg's copy: nothing to move means nothing to do, and in particular no
  // directory is created. Creating an empty entries/ here would make the sharded store
  // authoritative (readCollection prefers the directory) over a packed file this function
  // could not interpret - `{"projects": {}}` reads as zero items and would silently become an
  // empty store, where leaving it alone lets readStore complain about it as it always did.
  if (!items.length) return { migrated: 0, skipped: false, paths: [] };

  const collision = slugCollision(items);
  if (collision) {
    throw new Error(`projects: ${legacyRel} has slugs that collide on "${collision}" - fix them before migrating`);
  }

  // Backup FIRST. This is a one-way transform on live data; the restore is a file copy back.
  const bak = `${legacy}.pre-shard`;
  if (!existsSync(bak)) copyFileSync(legacy, bak);

  const { written } = writeCollection(root, dir, items);

  // The packed file stays. Deleting it here would make a plugin rollback strand the data;
  // Task 7 removes it once the sharded store has been the only reader for a release.
  //
  // The `.pre-shard` backup is committed along with the records, the same call Task 3 made for
  // gtg: the second machine pulls an already-sharded tree and skips the migration, so a backup
  // that only ever existed locally would leave it no rollback copy.
  return { migrated: items.length, skipped: false, paths: [...written, `${legacyRel}.pre-shard`] };
}
