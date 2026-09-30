// lib-cli/store.mjs. Canonical in the logical-tools repo, vendored into each plugin that lists it in a
// .framework.json. Edit the canonical copy, run node scripts/sync-lib.mjs, commit both.
//
// A JSON collection store, one file per record. A packed file made every write rewrite the whole
// collection, so two machines editing unrelated records collided on the same bytes. One file per
// record makes unrelated edits disjoint, and a same-record fork conflicts on one small file.
// Every thrown message starts with the caller's `name` (gtg, projects), because callers print it
// as is and some classify it by that prefix.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const SLUG_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The record files this process last read or wrote, per directory. writeCollection deletes only
// files named here, so a record another session created after our read is never deleted.
// ponytail: per-process memory, so a caller that learns of records some other way (git show, a
// hand read) cannot delete them through here. Upgrade path: pass the seen set explicitly.
const SEEN = new Map();

// Write beside the target and rename over it, so a reader never meets a half-written record. The
// temp name ends in .tmp, never .json, so readCollection cannot list it. Windows refuses to replace
// a file another process is reading (EPERM, EACCES or EBUSY) for the milliseconds that read lasts,
// so the rename is retried briefly.
// ponytail: gives up after about 0.5 s and throws, leaving the old record whole.
function writeAtomic(p, body) {
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  for (let i = 0; ; i++) {
    try {
      return renameSync(tmp, p);
    } catch (e) {
      if (i >= 50 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) {
        rmSync(tmp, { force: true });
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function slugFile(slug, name) {
  if (typeof slug !== 'string' || !SLUG_OK.test(slug)) {
    throw new Error(`${name}: record has an unusable slug ${JSON.stringify(slug)} - cannot name its file`);
  }
  return `${slug}.json`;
}

// Windows is case-insensitive and Linux is not. Two slugs differing only in case are two records on
// one machine and one clobbered record on the other, so the write is refused.
export function slugCollision(items) {
  const seen = new Set();
  for (const it of items) {
    const k = String(it?.slug ?? '').toLowerCase();
    if (seen.has(k)) return k;
    seen.add(k);
  }
  return null;
}

// The directory is the whole store. Absent means empty: a store holding no records.
// A file that does not parse throws, naming it. A silent skip would make one record vanish from a
// list that otherwise looks complete.
export function readCollection(root, dir, { name = 'store' } = {}) {
  const abs = join(root, dir);
  if (!existsSync(abs)) {
    SEEN.set(abs, new Set());
    return [];
  }
  const out = [];
  const files = readdirSync(abs).filter((f) => f.endsWith('.json')).sort();
  for (const f of files) {
    const p = join(abs, f);
    let rec;
    try {
      rec = JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      throw new Error(`${name}: cannot parse ${dir}/${f} - ${e.message}`);
    }
    if (rec) out.push(rec);
  }
  SEEN.set(abs, new Set(files));
  return out;
}

// Returns repo-relative paths so the caller can hand them to its commit, which must name every path
// on both `git add` and `git commit`, deletions included.
export function writeCollection(root, dir, items, { name = 'store' } = {}) {
  const collision = slugCollision(items);
  if (collision) {
    throw new Error(`${name}: slugs collide case-insensitively on "${collision}" - one machine would lose a record`);
  }
  for (const it of items) slugFile(it?.slug, name); // validate all before touching disk

  const abs = join(root, dir);
  const before = existsSync(abs) ? readdirSync(abs).filter((f) => f.endsWith('.json')) : [];
  const keep = new Set(items.map((it) => slugFile(it.slug, name)));
  const seen = SEEN.get(abs) ?? new Set();
  const stale = before.filter((f) => !keep.has(f) && seen.has(f));

  mkdirSync(abs, { recursive: true });

  const written = new Set();
  const deleted = new Set();

  // Git cannot track an empty directory. Without this file a collection that empties out does not
  // exist in another machine's checkout, and the first write there forks history against this one.
  const gitkeep = join(abs, '.gitkeep');
  if (!existsSync(gitkeep)) {
    writeFileSync(gitkeep, '');
    written.add(`${dir}/.gitkeep`);
  }

  // A slug whose case changed (Alpha to alpha) is two files on Linux and one on Windows. Rename the
  // old casing onto the new one before writing, or on Windows the delete pass below would remove
  // the record just written.
  for (const f of stale) {
    const target = [...keep].find((k) => k.toLowerCase() === f.toLowerCase());
    if (!target) continue;
    renameSync(join(abs, f), join(abs, target));
    deleted.add(`${dir}/${f}`);
    written.add(`${dir}/${target}`);
  }

  // Write everything first, delete last. A failure partway leaves a superset of the intended state,
  // which a re-run converges. Deleting first would leave a hole.
  for (const it of items) {
    const f = slugFile(it.slug, name);
    const body = JSON.stringify(it, null, 2) + '\n';
    const p = join(abs, f);
    if (existsSync(p) && readFileSync(p, 'utf8') === body) continue; // unchanged: leave it alone
    writeAtomic(p, body);
    written.add(`${dir}/${f}`);
  }

  for (const f of stale) {
    if (deleted.has(`${dir}/${f}`)) continue; // renamed onto a kept name above
    rmSync(join(abs, f));
    deleted.add(`${dir}/${f}`);
  }

  SEEN.set(abs, keep);
  return { written: [...written], deleted: [...deleted] };
}
