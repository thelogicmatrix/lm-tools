// Where the portfolio lives and how it reaches disk and git: the root, the record store and its
// guard against rendering an empty index over a populated one, today's date, and the path-named
// commit. Split out of projects.mjs (#37), code unchanged.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readCollection, writeCollection } from './store.mjs';
import { runGit, firstMeaningfulLine } from './git.mjs';
import { REL_ENTRIES, REL_INDEX, parseIndex } from './render.mjs';

export function resolveRoot() {
  if (process.env.PROJECTS_ROOT) return process.env.PROJECTS_ROOT;
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    console.error('projects: not inside a git repository and PROJECTS_ROOT is not set');
    process.exit(2);
  }
}

// parseIndex already carries the header and separator guards, so it counts the rows here rather
// than a second parser written to the same shapes.
function indexRowCount(root) {
  const p = join(root, REL_INDEX);
  return existsSync(p) ? parseIndex(readFileSync(p, 'utf8')).projects.length : 0;
}

// No bypass parameter. `allowLegacy` existed for the one-shot migration, the only caller ever
// meant to read a table the store does not back yet. That migration has run and the file is
// deleted, so the parameter went with it: a documented way past this guard with no legitimate
// caller left is a hole waiting for an illegitimate one.
export function readStore(root) {
  // The directory is the store. It used to fall back to the packed file when the directory was
  // absent; the packed file is deleted, so an absent directory is a root with no projects
  // registered yet, which readCollection returns as []. The refusal below is what keeps that
  // from quietly wiping a populated INDEX.md.
  const store = { projects: readCollection(root, REL_ENTRIES) };
  // Refused HERE because every verb reads the store through this one function, so one guard covers
  // all of them and every verb added later. Without it, rows in INDEX.md with none in the store is a
  // loaded gun: this returns an empty list, saveAndRender renders a bare header over the table, and
  // commit commits it, all at exit 0. Measured on copies of the live tree: 33 rows and 10,642
  // characters became 617 before the migration, and 33 rows and 5,454 characters became 617 after
  // it with the store deleted. The second is the worse of the two, because from then on the rendered
  // index is the only human-readable copy of where, status and lastTouched.
  //
  // Rows-here-and-none-there, NOT the table's shape. A shape test caught the five-column table and
  // left its mirror image wide open, and it could not see a four-cell hand table still carrying a
  // Next column either. Read-only verbs are refused too: `sync` reporting "nothing to flag across
  // 0 projects" over an unmigrated table is a false clean bill of health.
  //
  // Thrown, not exited: this is an exported library function, and a process.exit here cannot be
  // caught by main's handler or by any programmatic caller. main maps the message to exit 2.
  if (!store.projects.length) {
    const rows = indexRowCount(root);
    if (rows) {
      // Names entries/ unconditionally now: it is the only store, so it is always the one that
      // was read. "Migrate it first" stays verbatim - main's exit-code classifier matches on
      // that phrase, and SKILL.md explains it to the model by name.
      throw new Error(`projects: ${REL_INDEX} carries ${rows} row(s) and ${REL_ENTRIES
        } has none. Migrate it first. Any verb here would render an empty index over it`);
    }
  }
  return store;
}

// parseStore went with the packed file in 1.3.0. It was readStore's fallback reader and had no
// other caller. The store-level `version` field went with it and has no replacement: nothing
// ever read it - parseStore synthesised it and writeStore echoed it back - and a per-record
// layout has nowhere for it to live.

// Returns the repo-relative paths it touched, INCLUDING deletions, because commit() must name
// every path on both `git add` and `git commit` or a removal is left in the working tree for
// whichever session commits next to pick up as its own.
export function writeStore(root, store) {
  const { written, deleted } = writeCollection(root, REL_ENTRIES, store.projects);
  return [...written, ...deleted];
}

// The LOCAL calendar date, which is the calendar every date in this file is in. The dates it is
// compared against are local too: git's --date=short renders a commit's own zone, and a human
// reading a page means the day it is where he is. A bare toISOString slice is UTC, so it named
// yesterday for the first hours of every local day east of Greenwich.
export function today() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// firstMeaningfulLine lives in lib/git.mjs beside runGit, one copy shared with gtg and learn.

export function commit(root, paths, message) {
  // No paths means nothing was asked for. Falling through would be the exact disaster
  // this function exists to prevent: a bare `git add` exits 0 ("Nothing specified" is a
  // hint, not an error), so the commit would run with nothing after `--`, which git
  // reads as NO pathspec, sweeping the whole shared index and taking other sessions'
  // staged work. Verified by experiment. Callers build `paths` conditionally, so [] is ordinary.
  if (!paths.length) return true;
  const opts = { cwd: root };
  try {
    // `--` on the add too: the slug regex permits a leading '-', so a path could parse as a flag.
    // runGit waits out another session's index.lock and times out a hung git.
    runGit(['add', '--', ...paths], opts);
    // Name the paths on the COMMIT too. A pathspec-less commit takes the WHOLE shared
    // index, so a concurrent session's staged work rides along in ours.
    runGit(['commit', '-q', '-m', message, '--', ...paths], opts);
    return true;
  } catch (e) {
    const out = `${e.stdout || ''}\n${e.stderr || ''}`;
    // Every wording git uses for "the commit was empty", which is success for us.
    // "nothing added to commit but untracked files present" is the one that bites:
    // a no-op re-render with any untracked file around hits it, and reporting that
    // as a failure would cry wolf on a completely healthy path.
    // Anchored to line start so a real failure that merely QUOTES one of these phrases
    // (a pre-commit hook echoing `git status`, say) is not swallowed as success.
    if (/^(nothing (added )?to commit|no changes added)/im.test(out)) return true;
    // `git add` is not atomic and may have staged some or all of the paths before the failure.
    // Unstage them, as learn does, so nothing is left ownerless in the shared index.
    try { runGit(['reset', '-q', '--', ...paths], opts); } catch { /* nothing staged */ }
    console.error(`projects: git commit failed, changes are on disk but uncommitted. ${firstMeaningfulLine(e)}`);
    // The `false` below is not enough on its own: saveAndRender discards it, and a batch
    // caller reads $? rather than our stderr. On 2026-08-11 a 39-call `projects set`
    // backfill hit a stale index.lock and ran to completion on warnings alone, ending with
    // 14 uncommitted rows and files staged ownerless in the shared checkout. Setting the
    // exit code here covers every caller, including the ones that drop the boolean.
    process.exitCode = 1;
    return false;
  }
}
