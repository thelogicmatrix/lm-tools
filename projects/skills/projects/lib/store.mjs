// ponytail: a near-copy of gtg/skills/gtg/lib/store.mjs. The two plugins install and version
// independently, so a shared module would break on a version skew for the sake of 70 lines.
// A change here probably belongs there too.
//
// One file per record. A packed collection ({version, projects: [...]}) made every write rewrite
// the whole file, so two machines editing UNRELATED projects still collided on the same bytes
// and a JSON array conflict has no semantic merge. Per-record files make unrelated edits
// disjoint, and a same-project fork conflicts on one small file, which is correct.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const SLUG_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function slugFile(slug) {
  if (typeof slug !== 'string' || !SLUG_OK.test(slug)) {
    throw new Error(`projects: record has an unusable slug ${JSON.stringify(slug)} - cannot name its file`);
  }
  return `${slug}.json`;
}

// reborn is Windows (case-insensitive FS), Obelisk is Linux (case-sensitive). Two slugs
// differing only in case are two records on one machine and one clobbered record on the
// other. Refuse the write rather than lose a record on whichever machine syncs second.
export function slugCollision(items) {
  const seen = new Set();
  for (const it of items) {
    const k = String(it?.slug ?? '').toLowerCase();
    if (seen.has(k)) return k;
    seen.add(k);
  }
  return null;
}

// The directory is the ONLY store. This used to fall back to the packed file when the directory
// was absent, and the packed files are deleted now, so there is nothing left to fall back to.
// Absent therefore means what empty means: a store holding no records. That is a real state -
// everything archived - and the fallback was the thing that could turn it into a resurrection,
// by reading a frozen array on any checkout the directory had not reached.
//
// A rollback is `git show <pre-shard-commit>:<packed file>` plus the pre-shard plugin, not a
// code path here. See docs/runbooks/git-parity.md in the store's own repo.
export function readCollection(root, dir) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const f of readdirSync(abs).filter((f) => f.endsWith('.json')).sort()) {
    const p = join(abs, f);
    let rec;
    try {
      rec = JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      // NOT a silent skip. The packed store swallowed parse errors and returned null,
      // which cost nothing when it meant "no store". Here it would mean one record
      // silently disappearing from a list that otherwise looks complete.
      throw new Error(`projects: cannot parse ${dir}/${f} - ${e.message}`);
    }
    if (rec) out.push(rec);
  }
  return out;
}

// Returns repo-relative paths so the caller can hand them straight to commit(), which must
// name every path on BOTH `git add` and `git commit` - deletions included, or the removal
// stays in the working tree and the next session commits it as its own.
export function writeCollection(root, dir, items) {
  const collision = slugCollision(items);
  if (collision) {
    throw new Error(`projects: slugs collide case-insensitively on "${collision}" - one machine would lose a record`);
  }
  for (const it of items) slugFile(it?.slug); // validate all before touching disk

  const abs = join(root, dir);
  const before = existsSync(abs) ? readdirSync(abs).filter((f) => f.endsWith('.json')) : [];
  const keep = new Set(items.map((it) => slugFile(it.slug)));
  const stale = before.filter((f) => !keep.has(f));

  mkdirSync(abs, { recursive: true });

  const written = new Set();
  const deleted = new Set();

  // Git cannot track an empty directory. Without this file a collection that empties out - the
  // last active entry consumed, a prune, everything parked - simply does not exist in the other
  // machine's checkout. That used to be a silent resurrection: readCollection took the LEGACY
  // branch there and returned the frozen packed array, and migrateCollection re-sharded it. With
  // the packed files gone the failure is smaller but still wrong - the collection reads as a
  // store that was never created rather than as one deliberately emptied, and the first write on
  // that machine re-creates the directory as a fresh commit, forking history against this one.
  // Created once, beside the first write, and named in `written` so commit() adds it there.
  const gitkeep = join(abs, '.gitkeep');
  if (!existsSync(gitkeep)) {
    writeFileSync(gitkeep, '');
    written.add(`${dir}/.gitkeep`);
  }

  // A slug whose case changed (Alpha -> alpha) is TWO files on Obelisk and ONE on reborn.
  // Rename the old casing onto the new one BEFORE writing: on reborn the write would
  // otherwise land in the old file and the delete pass below would then remove the record
  // we just wrote. rename never leaves a hole, so a crash here cannot lose the record.
  for (const f of stale) {
    const target = [...keep].find((k) => k.toLowerCase() === f.toLowerCase());
    if (!target) continue;
    renameSync(join(abs, f), join(abs, target));
    deleted.add(`${dir}/${f}`);
    written.add(`${dir}/${target}`); // git must be told the new path even if the body matches
  }

  // Write everything first, delete last. A failure partway then leaves a SUPERSET of the
  // intended state (a stale extra record), which a re-run converges. Deleting first would
  // leave a hole, which nothing converges.
  for (const it of items) {
    const f = slugFile(it.slug);
    const body = JSON.stringify(it, null, 2) + '\n';
    const p = join(abs, f);
    if (existsSync(p) && readFileSync(p, 'utf8') === body) continue; // unchanged: leave it alone
    writeFileSync(p, body);
    written.add(`${dir}/${f}`);
  }

  for (const f of stale) {
    if (deleted.has(`${dir}/${f}`)) continue; // renamed onto a kept name above
    rmSync(join(abs, f));
    deleted.add(`${dir}/${f}`);
  }

  return { written: [...written], deleted: [...deleted] };
}
