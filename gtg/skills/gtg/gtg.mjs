#!/usr/bin/env node
// gtg - zero-model bookkeeping CLI for the gtg pause/resume skill.
// Storage root: GTG_HUB env var if set, else the current git repo's root.
// Unknown subcommands dispatch to <root>/.gtg/commands/<name>.mjs (see README).
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readCollection, writeCollection } from './lib/store.mjs';
import { migrateCollection } from './lib/migrate.mjs';

// --- storage root -----------------------------------------------------------
function resolveRoot() {
  if (process.env.GTG_HUB) return process.env.GTG_HUB;
  try {
    return execSync('git rev-parse --show-toplevel', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    console.error('gtg: not inside a git repository and GTG_HUB is not set');
    process.exit(2);
  }
}
const ROOT = resolveRoot();
const REL_ACTIVE = 'docs/handoffs/_active.json';   // legacy packed store, read-only after Task 2
const REL_BACKLOG = 'docs/handoffs/_backlog.json'; // legacy packed store, read-only after Task 2
const DIR_ACTIVE = 'docs/handoffs/active';
const DIR_BACKLOG = 'docs/handoffs/backlog';
const COLLECTIONS = {
  active: { dir: DIR_ACTIVE, legacyRel: REL_ACTIVE, legacyKey: 'handoffs' },
  backlog: { dir: DIR_BACKLOG, legacyRel: REL_BACKLOG, legacyKey: 'backlog' },
};
// Git-history pathspec for the stores: BOTH the legacy packed files and the sharded
// directories, because `log` and `undo` read HISTORY and history spans the migration.
// Dropping the packed paths would make every pre-shard commit invisible to `gtg log` and
// would leave `gtg undo` unable to see its own change (the whole store moved out from
// under the pathspec it anchors on).
const STORE_PATHSPEC = [REL_ACTIVE, REL_BACKLOG, DIR_ACTIVE, DIR_BACKLOG];
// Directory of this CLI file - bundled extensions ship alongside it under extensions/.
const CLI_DIR = dirname(fileURLToPath(import.meta.url));

// gtg add-ons come in two kinds. An EXTENSION owns entries in the handoff store and renders
// its own separated list, so its entries are excluded from `list` and `backlog`. A MOD owns
// no entries and only adds a view (stats, report), so mods are absent from this map.
//
// Command name -> the `parent` namespace it owns. Filtering is on the existing `parent` field
// and adds no new one on purpose: writeHandoff rebuilds every entry as a fresh literal and
// silently drops fields it does not know, so a marker field would survive exactly until the
// next wrap. Same constraint that put issue-package membership in the issue file.
//
// DUPLICATED OUTSIDE THIS REPO, and it has to be. Nathan's SessionStart banner hook at
// .claude/hooks/gtg-active-summary.mjs announces the active count and must exclude the same
// namespaces, or the banner disagrees with `gtg list` on the next line. A hook cannot import
// from a plugin, so it carries its own copy of these values. Adding a namespace here means
// adding it there too.
const EXTENSIONS = { issues: 'issues', learn: 'learning' };
const EXTENSION_PARENTS = new Set(Object.values(EXTENSIONS));
const isExtensionEntry = (e) => EXTENSION_PARENTS.has(e?.parent);
const userVisible = (arr) => arr.filter((e) => !isExtensionEntry(e));

// Who is mutating the store. Every gtg commit carries this as a trailer so `undo`
// can tell its own change from a concurrent session's - two sessions sharing one
// checkout is the normal setup, and undo used to revert whichever session
// committed last (2026-07-14: one session's undo silently reverted another's
// park). Must be stable ACROSS processes, since the mutation and the later undo
// are separate invocations, which is exactly what a harness session id gives us.
// GTG_SESSION_ID is the portable override for other harnesses and for tests.
const SESSION_ID = process.env.GTG_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || '';
const SESSION_TRAILER = 'gtg-session';
// Which harness is writing. Two agents share one store now (Claude Code and Codex, 2026-08-26),
// and a resume from the other side wants to know whose task-list conventions the handoff
// carries. Detected from the env the harness exports to its tools: Claude Code sets CLAUDECODE
// and a session id; Codex exports CODEX_* (CODEX_HOME, CODEX_MANAGED_BY_*, sandbox flags).
// --harness on the handoff overrides, undefined when nothing identifies the caller.
function detectHarness() {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_SESSION_ID) return 'claude';
  if (Object.keys(process.env).some((k) => k.startsWith('CODEX_'))) return 'codex';
  return undefined;
}

// --- color (TTY-gated, NO_COLOR-aware; raw ANSI, no dependency) ---------------
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));

// --- helpers (readStore/writeStore/commit are also the extension ctx) --------
// readStore is a WHOLE-FILE JSON reader and stays one: it is published on the extension ctx,
// and a caller indexes the wrapper key itself (`readStore('...')?.handoffs ?? []`), so handing
// it a bare array would yield [] with no error at all. Nothing inside gtg reads the record
// stores through it any more - that is `entries(which)` below - and since Task 4 no BUNDLED
// extension does either: extensions/lib/history.mjs used to, and buildReport now calls
// readCollection instead, because a whole-file reader cannot see a directory of records.
// The remaining internal callers read _session.json, which is a genuine single-object file.
//
// So the shape contract is real but has no bundled caller left to enforce it. A third-party
// extension in .gtg/commands/ is now the caller that depends on it, and test/gtg.test.mjs
// case 72 is what holds it - keep that case if you touch this function.
function readStore(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function writeStore(rel, data) {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}
function commit(paths, message) {
  // An EMPTY path list degrades to exactly the pathspec-less commit the block below exists
  // to prevent: `git commit -- ` with nothing after the `--` takes the whole shared index.
  // Callers now build their paths from what the store actually touched, so "touched nothing"
  // is reachable, and it is never a reason to commit everything.
  if (!paths.length) return;
  const opts = { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    execFileSync('git', ['add', ...paths], opts);
    // Name the paths on the COMMIT too, not just the add. A pathspec-less `git commit`
    // takes the WHOLE index, so anything a concurrent session staged between our add and
    // our commit rides along in ours - on 2026-07-27 a `gtg resume` swallowed an unrelated
    // spec file that another session had just staged. `--` keeps a path that starts with
    // a dash from being read as a flag.
    // The trailer goes in a second -m so it lands in the BODY, leaving the subject
    // (which history.mjs classifies on) byte-identical to what it always was.
    const msg = SESSION_ID ? ['-m', message, '-m', `${SESSION_TRAILER}: ${SESSION_ID}`] : ['-m', message];
    execFileSync('git', ['commit', '-q', ...msg, '--', ...paths], opts);
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    if (/nothing to commit|no changes added/i.test(out)) return; // identical content - files already on disk
    // Don't let a real git failure masquerade as success: the files are written, but say so.
    console.error(`gtg: git commit failed, changes are on disk but uncommitted - ${(e.stderr || e.message || '').toString().trim().split('\n')[0]}`);
    // NAME THE PATHS, because nothing else ever will. `git add` has already succeeded by the
    // time a commit failure lands here, so these records sit staged in the shared checkout -
    // and writeCollection skips byte-identical files, so a later gtg run recomputes the same
    // records, reports NO changed paths for them, and never names them again. The packed store
    // was immune to this by accident: its pathspec was two fixed filenames, so the next commit
    // re-added whatever was pending.
    //
    // Recovery is deliberately MANUAL - the user runs `git commit -- <the paths below>`. The
    // automatic fix would be to widen the pathspec to the whole keep-set, and that is exactly
    // what must not happen here: on one shared tree and index there is no way to tell our own
    // stranded record from another session's in-flight one, so committing the keep-set would
    // sweep their work into our commit. That is the 2026-07-27 incident with extra steps.
    // Labelled "uncommitted", not "staged": a stale index.lock (the 2026-08-11 cause) fails
    // the `git add` too, so on that path nothing is staged at all - verified, the tree shows
    // an unstaged ` D` and an untracked `??`. `git commit -- <paths>` recovers either way,
    // which is what the line is for, so the label states the thing that is always true.
    console.error(`  uncommitted: ${paths.join(' ')}`);
    // ...and say so in the EXIT CODE, not only on stderr. A batch caller reads $?, not our
    // warnings: on 2026-08-11 a 39-call backfill hit a stale index.lock and every call after
    // it warned, exited 0 and kept going, ending with 14 uncommitted rows and files left
    // staged and ownerless in the shared checkout. exitCode rather than a throw because the
    // store write already landed - this reports a partial success, it does not roll back.
    process.exitCode = 1;
  }
}
// `which` is 'active' | 'backlog'. Order is NOT stored: sortByProject/displayOrder recompute
// it at render, so a directory read (alphabetical by slug) renders identically to the packed
// array it replaces.
function entries(which) {
  const { dir, legacyRel, legacyKey } = COLLECTIONS[which];
  return readCollection(ROOT, dir, legacyRel, legacyKey);
}
// Returns the repo-relative paths touched, INCLUDING deletions, because commit() must name
// every path on both `git add` and `git commit` or a removal is left for another session to
// pick up as its own.
function saveEntries(which, items) {
  const { dir } = COLLECTIONS[which];
  const { written, deleted } = writeCollection(ROOT, dir, items);
  return [...written, ...deleted];
}

// Self-migrating: the first gtg command on a packed tree shards it. Guarded on the
// directory's existence, so this is a no-op on every subsequent run and on a tree that
// arrived already-migrated from the other machine.
//
// migrateCollection THROWS on a corrupt or slug-colliding packed file, and this loop runs
// before EVERY command, `help` and `log` included. Uncaught, one bad file would make gtg
// entirely unusable - a hard regression, because readCollection's legacy branch swallows the
// same parse error and reads as empty. So: catch PER COLLECTION (a corrupt backlog must not
// take the active list down with it), name the file on stderr, set a failing exit code, and
// carry on with the pre-shard behaviour. Nothing is destroyed on this path - the .pre-shard
// backup is made only after the parse succeeds and the packed file is never deleted - and the
// warning repeats on every invocation until the file is fixed, which is the diagnostic the old
// silent-empty read never gave.
//
// `migrated: 0, skipped: false` is also the shape for "no packed file ever existed" (a fresh
// hub), so only a real migration is allowed to say anything.
for (const [name, col] of Object.entries(COLLECTIONS)) {
  try {
    const r = migrateCollection(ROOT, col.dir, col.legacyRel, col.legacyKey);
    if (r.migrated) {
      // r.paths carries the `<packed>.pre-shard` backup as well as the record files, and it is
      // committed deliberately: the second machine pulls an already-sharded tree and skips the
      // migration, so a backup that only ever existed locally would leave it no rollback copy.
      commit(r.paths, `gtg: shard ${name} store into ${col.dir}/ (${r.migrated} records)`);
      // stderr, not stdout: the calling skill parses stdout, and a one-time notice must not
      // land in front of a resume body or a `--dry-run` dump.
      console.error(`gtg: sharded ${r.migrated} ${name} record(s) into ${col.dir}/`);
    }
  } catch (e) {
    console.error(`gtg: could not shard the ${name} store - ${(e?.message || String(e)).split('\n')[0]}`);
    console.error(`  Still reading ${col.legacyRel}. Fix that file and the next gtg command retries.`);
    process.exitCode = 1;
  }
}
// Local UTC-offset suffix e.g. "+08:00" for the given Date - shared by nowIso()
// and firstHandoffDate() so both emit the same aware-datetime format (a bare
// vs offset-suffixed stamp otherwise makes Python's fromisoformat raise when
// comparing them).
function localOffsetSuffix(d) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}
function nowIso() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${localOffsetSuffix(d)}`;
}
function ago(iso) {
  const h = (Date.now() - Date.parse(iso)) / 3600000;
  if (!Number.isFinite(h)) return '?';
  return h < 48 ? `${Math.floor(h)}h ago` : `${Math.floor(h / 24)}d ago`;
}
// Ordering doubles as numbering: `gtg back <n>` and `gtg active b<n>` resolve a number
// against the same order the rows were rendered in, so the extension exclusion belongs in
// this one shared ordering helper rather than at each console.log. A number on screen then
// cannot address a different entry than the one the user typed back. Slug and name lookups
// are untouched, so an extension entry stays reachable by slug.
//
// ponytail: filtered at render, NOT at read. `list` is the path that runs autoShelf, so
// filtering earlier would stop extension entries ever auto-shelving and silently empty
// `gtg learn`'s shelved section.
function sortByProject(arr) {
  return userVisible(arr).sort((a, b) => a.project.localeCompare(b.project));
}
// The exact top-to-bottom order `list` renders active entries in: each family
// (parent) alphabetical, its members alphabetical within, then standalone. ONE
// canonical order so a number on screen, `gtg back <n>`, and the "gtg back <hint>"
// hints all mean the same row. (Backlog has no families - it stays sortByProject.)
function displayOrder(arr) {
  const sorted = sortByProject(arr);
  const families = [...new Set(sorted.map((e) => e.parent).filter(Boolean))].sort();
  return [...families.flatMap((f) => sorted.filter((e) => e.parent === f)),
          ...sorted.filter((e) => !e.parent)];
}
// "<n>" resolves against the order the list was DISPLAYED in (pass displayOrder for
// the grouped active list, default sortByProject for the flat backlog); else slug
// exact, else fuzzy project.
function resolveEntry(arr, t, order = sortByProject) {
  if (/^\d+$/.test(t)) return order(arr)[Number(t) - 1] ?? null;
  return arr.find((e) => e.slug === t)
    ?? arr.find((e) => e.project.toLowerCase().includes(t.toLowerCase()))
    ?? null;
}
function parseFlags(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) a[k] = argv[++i];
    else a[k] = true;
  }
  return a;
}

// Handoff docs are named YYYY-MM-DD-HHMM-<slug>.md. They ARE the session record -
// counting files is why `sessions` needs no stored counter and backfills for
// projects that predate this field.
function handoffFilesFor(slug) {
  const dir = join(ROOT, 'docs/handoffs');
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-\\d{4}-${slug}\\.md$`);
  try { return readdirSync(dir).filter((f) => re.test(f)).sort(); } catch { return []; }
}
function countHandoffFiles(slug) { return handoffFilesFor(slug).length; }
// Earliest handoff filename's date, as a midnight ISO stamp. Null if none exist.
function firstHandoffDate(slug) {
  const f = handoffFilesFor(slug)[0];
  if (!f) return null;
  const datePart = f.slice(0, 10);
  const [y, m, day] = datePart.split('-').map(Number);
  return `${datePart}T00:00:00${localOffsetSuffix(new Date(y, m - 1, day))}`;
}

// Family grouping. The parent already exists as a docs/projects/ page - the
// projects skill owns that hierarchy, gtg only points at it.
// Resolution order: the flag the skill passes from session context, then a
// slug-prefix match against INDEX.md page slugs. Never asks; an unresolved
// parent just lists the project as standalone.
function inferParent(slug, explicit) {
  if (explicit) return explicit;
  const idx = join(ROOT, 'docs/projects/INDEX.md');
  if (!existsSync(idx)) return undefined;
  let text;
  try { text = readFileSync(idx, 'utf8'); } catch { return undefined; }
  const pages = new Set();
  for (const m of text.matchAll(/\[[^\]]+\]\(([^)]+)\.md\)/g)) pages.add(m[1]);
  // ponytail: longest match wins so 'widget-stats' picks 'widget' over any
  // shorter page slug that also prefixes it.
  let best;
  for (const page of pages) {
    if (slug !== page && !slug.startsWith(page + '-')) continue;
    if (!best || page.length > best.length) best = page;
  }
  return best;
}

// Session length. The SessionStart hook stamps docs/handoffs/_session.json as a
// per-cwd map { sessions: { <cwd>: ISO } }; git only knows when a handoff was
// WRITTEN, never how long the work took. Keying by cwd is what stops two
// concurrent worktree sessions from clobbering each other's clock through the
// one shared hub file - this handoff reads only ITS OWN session's start.
// A stale stamp (machine left on overnight) would report a 3-day session, so
// anything over 24h is discarded rather than believed.
// ponytail: a clear/compact mid-session restamps this cwd, so the duration is a
// lower bound (time since the last context reset), never an overcount. Fine.
function sessionDurationMin() {
  const s = readStore('docs/handoffs/_session.json');
  const started = Date.parse(s?.sessions?.[process.cwd()] ?? '');
  if (!Number.isFinite(started)) return undefined;
  const min = Math.round((Date.now() - started) / 60000);
  if (min < 0 || min > 24 * 60) return undefined;
  return min;
}

// ISO start of THIS session, from the same per-cwd stamp sessionDurationMin() reads.
function sessionStartIso() {
  const s = readStore('docs/handoffs/_session.json');
  const iso = s?.sessions?.[process.cwd()];
  return Number.isFinite(Date.parse(iso ?? '')) ? iso : undefined;
}
// Case-insensitive on Windows, where the hub env var and git's own path spelling differ.
function samePath(x, y) {
  const n = (s) => (process.platform === 'win32' ? resolve(s).toLowerCase() : resolve(s));
  return n(x) === n(y);
}
// The repo the caller stands in, unless that repo is the hub itself.
function inferWorktree() {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
    return top && !samePath(top, ROOT) ? top : 'repo root';
  } catch { return 'repo root'; }
}
// Body of one `## <heading>` section, '' when absent.
function sectionOf(body, heading) {
  const m = body.match(new RegExp(`^## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`, 'm'));
  return m ? m[1].trim() : '';
}
// The harness's task list, read from disk so the skill neither loads a task tool nor types
// the list into the body. Claude Code keeps <config dir>/tasks/<session id>/<n>.json; other
// harnesses get [] and the section is simply absent.
function readHarnessTasks() {
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  const cfg = process.env.CLAUDE_CONFIG_DIR || join(process.env.USERPROFILE || process.env.HOME || '', '.claude');
  if (!sid || !cfg) return [];
  const dir = join(cfg, 'tasks', sid);
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const f of readdirSync(dir)) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const t = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (t?.subject) rows.push({ id: Number(t.id ?? f), line: `- [${t.status || 'pending'}] ${t.subject}` });
    } catch { /* a half-written task file is not a reason to fail the handoff */ }
  }
  return rows.sort((x, y) => x.id - y.id).map((r) => r.line);
}
// Commits and files in a worktree since an ISO time. Empty on any git failure.
function gitSince(dir, sinceIso) {
  const opt = { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 };
  try {
    const commits = execFileSync('git', ['log', `--since=${sinceIso}`, '--format=%h %s'], opt)
      .toString().trim().split('\n').filter(Boolean);
    const files = [...new Set(execFileSync('git', ['log', `--since=${sinceIso}`, '--name-only', '--format='], opt)
      .toString().split('\n').map((s) => s.trim()).filter(Boolean))].sort();
    return { commits, files };
  } catch { return { commits: [], files: [] }; }
}

// --- handoff / backlog park ---------------------------------------------------
async function writeHandoff(argv, { which, verb }) {
  const a = parseFlags(argv);
  const body = readFileSync(0, 'utf8').trim(); // stdin
  // --next used to be typed twice, once as a flag and once as the body's Next Action section.
  // The section is the truth; the flag is now an override for a body without one (2.0.0).
  if (typeof a.next !== 'string') a.next = sectionOf(body, 'Next Action').split('\n').find((l) => l.trim()) || undefined;
  const missing = ['project', 'slug', 'next'].filter((k) => !a[k]);
  if (missing.length) { console.error(`gtg ${verb}: missing --${missing.join(', --')}${missing.includes('next') ? ' (or a ## Next Action section in the body)' : ''}`); process.exit(2); }
  // slug becomes a filename and a git-add arg - constrain it so it can't traverse paths or inject shell.
  if (!/^[A-Za-z0-9_-]+$/.test(a.slug)) { console.error(`gtg ${verb}: --slug must match [A-Za-z0-9_-]`); process.exit(2); }
  if (!body) { console.error(`gtg ${verb}: empty body on stdin`); process.exit(2); }
  // Slug reuse lives HERE, not in a `list <name>` probe the skill runs first (one tool turn per
  // departure, 2026-08-26). A fresh slug for a project that already has an entry mints a
  // duplicate beside it. An exact slug is taken as given; otherwise exactly one entry whose
  // project name contains --project (case-insensitive, the same predicate `list <filter>`
  // uses) lends its slug. Two or more matches: ambiguous, keep the given slug. --exact opts
  // out, for the `gtg [project]` override where the caller means the slug literally.
  const everything = [...entries('active'), ...entries('backlog')];
  if (!a.exact && !everything.some((e) => e.slug === a.slug)) {
    const name = String(a.project).toLowerCase();
    const near = everything.filter((e) => String(e.project).toLowerCase().includes(name));
    if (near.length === 1) {
      console.log(`slug: reusing ${near[0].slug} (matches "${near[0].project}")`);
      a.slug = near[0].slug;
    }
  }
  // ROOT is the storage hub, NOT the project. A project in its own worktree has
  // its own branch - detect there, or the hub's branch gets recorded for everyone.
  // Inferred from where the call is made when the flag is omitted: a session runs in its
  // worktree, so cwd's repo is the project unless that repo IS the hub.
  const worktree = a.worktree || inferWorktree();
  let branch = a.branch;
  if (!branch) {
    const gitDir = worktree === 'repo root' ? ROOT : worktree;
    try {
      branch = execFileSync('git', ['-C', gitDir, 'rev-parse', '--abbrev-ref', 'HEAD'],
        { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
    } catch { branch = '?'; }
  }
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const relFile = `docs/handoffs/${stamp}-${a.slug}.md`;
  const prior = everything.find((e) => e.slug === a.slug);
  const ownWorktree = worktree !== 'repo root' && !samePath(worktree, ROOT);
  // --wip: checkpoint the worktree's uncommitted work inside this same call, so the skill
  // spends no turn on status/add/commit. Worktree only: 'repo root' may be a checkout shared
  // with concurrent sessions, where a tree-wide add sweeps their work (see commit() above), so
  // there the caller names its own files. A clean tree is not an error. Runs BEFORE the
  // git-derived sections below so the checkpoint shows up in them.
  if (a.wip && ownWorktree && !a['dry-run']) {
    const wt = { cwd: worktree, stdio: ['ignore', 'pipe', 'pipe'] };
    try {
      execFileSync('git', ['add', '-A'], wt);
      execFileSync('git', ['commit', '-q', '-m', `wip: gtg checkpoint - ${a.project}`], wt);
      console.log('wip: committed');
    } catch (e) {
      const out = `${e.stdout || ''}${e.stderr || ''}`;
      if (!/nothing to commit|no changes added/i.test(out)) {
        console.error(`gtg: wip commit failed - ${out.trim().split('\n')[0]}`);
        process.exitCode = 1;
      }
    }
  }
  // Sections the model used to type that the machine already knows (2.0.0): the harness's
  // task list from disk, and this session's commits and files from the worktree's git log.
  // Only for a worktree of its own: the hub may be a checkout shared by concurrent sessions,
  // where "commits since I started" would be everyone's. Each is added only when the body
  // has not already got a section of that name, so a caller can still write its own.
  const auto = [];
  const tasks = readHarnessTasks();
  if (tasks.length && !sectionOf(body, 'Task list')) auto.push(`## Task list\n${tasks.join('\n')}`);
  if (ownWorktree && verb === 'handoff') {
    const since = sessionStartIso() || prior?.updated || new Date(Date.now() - 12 * 3600e3).toISOString();
    const { commits, files } = gitSince(worktree, since);
    if (commits.length && !sectionOf(body, 'Commits this session')) auto.push(`## Commits this session\n${commits.map((l) => `- ${l}`).join('\n')}`);
    if (files.length && !sectionOf(body, 'Files touched')) auto.push(`## Files touched\n${files.map((f) => `- ${f}`).join('\n')}`);
  }
  const fullBody = [body, ...auto].join('\n\n');
  const doc = `# Handoff: ${a.project}
Date: ${stamp.slice(0, 10)} ${p(d.getHours())}:${p(d.getMinutes())}
Worktree: ${worktree}
Branch: ${branch}

${fullBody}

## Resume Prompt
Say: "gtg ${a.slug}"
`;
  // Math.max guards the counter against going backwards: deleting old handoff
  // .md files (plain docs, fine to prune per the README) or two handoffs
  // landing in the same clock minute (one filename, one file on disk) would
  // otherwise drop the count below what `prior.sessions` already recorded.
  const sessions = Math.max(countHandoffFiles(a.slug) + 1, (prior?.sessions ?? 0) + 1);
  const entry = {
    project: a.project, slug: a.slug, sessions,
    created: prior?.created || firstHandoffDate(a.slug) || nowIso(),
    worktree, branch,
    // --parent is stable family metadata only the calling skill can know
    // (inferParent's slug-prefix fallback can't deduce e.g.
    // sub-project -> atlas) - carry it forward when the flag is
    // omitted instead of silently dropping the project out of its family.
    parent: inferParent(a.slug, a.parent) ?? prior?.parent,
    duration_min: sessionDurationMin(),
    harness: (typeof a.harness === 'string' ? a.harness : undefined) ?? detectHarness(),
    eta: a.eta || prior?.eta,
    next: String(a.next).slice(0, 150), file: relFile, updated: nowIso(),
  };
  if (a['dry-run']) {
    console.log(`--- DRY RUN: would write ${relFile} ---\n${doc}`);
    console.log(`--- ${COLLECTIONS[which].dir}/${a.slug}.json entry ---\n${JSON.stringify(entry, null, 2)}`);
    return;
  }
  mkdirSync(join(ROOT, 'docs/handoffs'), { recursive: true });
  writeFileSync(join(ROOT, relFile), doc);
  const items = entries(which).filter((e) => e.slug !== a.slug); // dedupe by slug
  items.push(entry);
  const paths = saveEntries(which, items);
  // The two stores PARTITION the work, in flight against shelved, which is what every other
  // mover already assumes: back, active, resume and autoShelf all MOVE an entry rather than
  // copy it. Deduping against only the store being written left the other copy sitting there,
  // and the two drive different renderers, so one project read as active or shelved depending
  // on which command you happened to run. `prior` above already spans both stores; the write
  // now does too, so writing a handoff for a shelved slug unparks it instead of forking it.
  const other = which === 'active' ? 'backlog' : 'active';
  const others = entries(other);
  const kept = others.filter((e) => e.slug !== a.slug);
  const unparked = kept.length !== others.length;
  if (unparked) paths.push(...saveEntries(other, kept));
  // 'backlog' here means "park a NEW idea" (writeHandoff's other caller) - distinct
  // from `back` (below), which SHELVES an already-active entry and keeps its own
  // 'gtg backlog: park <project>' subject unchanged; historical commits use that
  // one and must stay parsable.
  const subject = verb === 'backlog'
    ? `gtg backlog: new ${a.project} - session ${sessions}`
    : `${verb}: ${a.project} - session ${sessions}`;
  // relFile plus every record file the two saves touched, deletions included - the unpark
  // above REMOVES the slug's file from the other store, and an unnamed deletion stays in the
  // working tree for whichever session commits next.
  commit([relFile, ...paths], subject);
  console.log(relFile);
  // After-handoff hook: <root>/.gtg/after-handoff.mjs, default export fn(ctx), runs once the
  // handoff is committed. This is where the ceremony that used to be prose steps for the model
  // to perform (a docs/sessions entry, a portfolio-row flip) goes, so it costs no model tokens
  // and cannot be skipped in a hurry. ctx is additive-only, like the command ctx. A failing
  // hook is reported and sets the exit code; it never rolls the handoff back.
  const hook = join(ROOT, '.gtg', 'after-handoff.mjs');
  if (verb === 'handoff' && existsSync(hook)) {
    try {
      const mod = await import(pathToFileURL(hook).href);
      if (typeof mod.default !== 'function') throw new Error('no default export function');
      await mod.default({ root: ROOT, entry, file: relFile, body: fullBody, worktree, readStore, writeStore, commit });
    } catch (e) {
      console.error(`gtg: after-handoff hook failed - ${(e.stderr || e.message || String(e)).toString().trim().split('\n')[0]}`);
      process.exitCode = 1;
    }
  }
  console.log(verb === 'backlog'
    ? `PARKED on backlog: "${a.project}" - reactivate with 'gtg active <n>' or "gtg ${a.slug}"`
    : `RESUME: "gtg ${a.slug}"`);
}
const handoff = (argv) => writeHandoff(argv, { which: 'active', verb: 'handoff' });

// backlog: with --project it parks a new entry; bare it lists the shelf (Task 3)
function backlog(argv) {
  if (parseFlags(argv).project) return writeHandoff(argv, { which: 'backlog', verb: 'backlog' });
  return backlogList();
}
// Active entries idle >7d silently move to the backlog when `list` runs.
// 'updated' is refreshed on every handoff/back/active, so only genuinely idle entries qualify.
function autoShelf() {
  const act = entries('active');
  const cutoff = Date.now() - 7 * 86400000;
  const stale = act.filter((e) => e.updated && Date.parse(e.updated) <= cutoff);
  if (!stale.length) return;
  const fresh = act.filter((e) => !stale.includes(e));
  let bl = entries('backlog');
  for (const s of stale) {
    s.updated = nowIso(); // restamp = shelf date
    bl = bl.filter((e) => e.slug !== s.slug);
    bl.push(s);
  }
  const paths = [...saveEntries('active', fresh), ...saveEntries('backlog', bl)];
  commit(paths, `gtg backlog: auto-park ${stale.length} stale (>7d): ${stale.map((s) => s.project).join(', ')}`);
  console.log(`Auto-shelved ${stale.length} project(s) idle >7d to backlog: ${stale.map((s) => s.project).join(', ')}`);
}

// Live uncommitted-file count for a worktree. A SessionEnd hook that recorded
// this was retired 2026-07-11 for MISSING dirty worktrees - it only fired on
// exit behind narrow filters. Checking live at list time has neither flaw.
// ponytail: 2s timeout per distinct worktree; a slow or absent one renders '?'
// rather than hanging the list.
function dirtyCount(dir) {
  if (!dir || !existsSync(dir)) return null;
  try {
    const out = execFileSync('git', ['-C', dir, 'status', '--porcelain'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
    return out ? out.split('\n').length : 0;
  } catch { return null; }
}
// Where an entry's checkout actually lives - the hub itself for 'repo root'/legacy
// (undefined) entries, else the recorded worktree path. One definition, two call
// sites (dirty-count grouping and per-entry rendering) - they must stay identical.
function resolveDir(e) { return (!e.worktree || e.worktree === 'repo root') ? ROOT : e.worktree; }

// `list` = the 7-day shelf sweep THEN render. Split out so a move command can
// re-render (maybeAutoList) without re-running autoShelf - which would re-park a
// just-restored stale entry the moment `undo` brought it back.
function list(argv) {
  autoShelf();
  renderList(argv);
}

function renderList(argv) {
  const filter = argv.find((x) => !x.startsWith('--'));
  // displayOrder, not sortByProject: numbering must run 1..N top-to-bottom in the
  // order rows actually appear (see displayOrder), and `gtg back <n>` resolves
  // against this same order.
  const act = entries('active');
  const allAct = displayOrder(act);
  // userVisible, so the "+N backlogged" pointer counts the rows `gtg backlog` will show.
  const blCount = userVisible(entries('backlog')).length;
  // Decluttering is not lookup. The BARE listing hides extension entries, which is the whole
  // point, but an explicit query is the user naming the thing they want, so it searches every
  // entry (`act`, not `allAct`). SKILL.md's exit procedure probes with `list <candidate>` before
  // slugifying and reuses the matched entry's slug, so a blind probe would mint a second entry
  // beside a live issue package instead of updating it.
  const matches = (e) => e.slug === filter || e.project.toLowerCase().includes(filter.toLowerCase());
  const shown = filter
    ? act.filter(matches).sort((a, b) => a.project.localeCompare(b.project))
    : allAct;

  // A targeted query has to reach a SHELVED extension entry too, or the reuse probe above is
  // still blind. autoShelf parks anything idle over 7 days, which is normal for an issue
  // package (they sit between fix sessions), and `backlog` hides extension entries, so from
  // that moment no builtin listing shows it and a departure mints the duplicate anyway.
  // Rendered as its own line rather than as a row, because these are not active and the
  // header counts active work.
  // ponytail: extension entries only. A shelved NORMAL project is invisible to a query too,
  // but that predates the extension model and `list` is documented as never showing backlog
  // items, so widening it is a design call, not a fix. See README "Decluttering is not lookup".
  const shelvedHits = filter
    ? entries('backlog').filter((e) => isExtensionEntry(e) && matches(e))
    : [];
  const printShelved = () => {
    for (const e of shelvedHits) {
      console.log(`  ${c('33', 'shelved:')} ${c('1;36', e.project)} ${c('2', `(parked ${ago(e.updated)})`)}` +
        ` - gtg active ${e.slug}`);
    }
  };

  if (!shown.length) {
    console.log(`No active gtg projects${filter ? ` matching '${filter}'` : ''}.` +
      (blCount ? ` (+${blCount} backlogged - gtg backlog)` : ''));
    printShelved();
    return;
  }

  const families = [...new Set(shown.map((e) => e.parent).filter(Boolean))].sort();
  console.log(`${shown.length} active gtg project${shown.length === 1 ? '' : 's'}` +
    `${families.length ? ` in ${families.length + (shown.some((e) => !e.parent) ? 1 : 0)} group(s)` : ''}` +
    `${filter ? ` matching '${filter}'` : ''}:`);

  // Only entries with an explicit worktree of their own get a dirty flag - a
  // 'repo root'/legacy-undefined entry resolves to the storage hub itself, which
  // in real use carries 150+ uncommitted files unrelated to any one project;
  // attributing that count to the entry would falsely implicate it.
  const hasOwnWorktree = (e) => !!e.worktree && e.worktree !== 'repo root';

  // One git call per distinct worktree, not per project - several projects
  // commonly share one checkout, which is exactly what the warning below is for.
  const dirty = new Map();
  for (const e of shown) {
    if (!hasOwnWorktree(e)) continue;
    const dir = resolveDir(e);
    if (!dirty.has(dir)) dirty.set(dir, dirtyCount(dir));
  }

  const printEntry = (e) => {
    // Position in the FULL display-order list (allAct), so numbers run 1..N down
    // the screen and `gtg back <n>` (resolveEntry over displayOrder) targets this
    // same row even when a filter hides some entries.
    const n = allAct.indexOf(e) + 1;
    // A number is a position in the canonical list, and an extension entry has none: it only
    // ever appears here via an explicit query, and allAct excludes it, so indexOf gives -1 and
    // the `+ 1` above makes that a falsy 0. Label it with the slug that DOES address it rather
    // than a number that would address a different row. This is what keeps a queried listing
    // and `gtg back <n>` from ever disagreeing about what 3 means.
    const label = n ? c('1', n + '.') : c('2', e.slug + ':');
    const d = hasOwnWorktree(e) ? dirty.get(resolveDir(e)) : undefined;
    // null = worktree unreachable / dirtyCount failed - render the '?' the spec
    // promises, distinct from a genuinely clean (0) worktree, which renders nothing.
    const dirtyTag = d === null ? c('33', ' ● ? uncommitted') : d ? c('33', ` ● ${d} uncommitted`) : '';
    const loc = e.branch && e.branch !== '?' ? c('2', ` ${e.branch}`) : '';
    const idle = (Date.now() - Date.parse(e.updated)) / 86400000;
    const shelf = idle > 6 ? c('31', ` ⚠ shelves in ${Math.max(0, Math.round((7 - idle) * 24))}h`) : '';
    const sessions = e.sessions ?? countHandoffFiles(e.slug); // legacy entries predate the field
    const by = e.harness ? c('2', ` ·${e.harness}`) : ''; // who wrote the last handoff; absent on pre-1.11 entries
    console.log(`  ${label} ${c('1;36', e.project)} ${c('2', 's' + sessions)} [${c('32', e.eta || '?')}] ${c('2', '(' + ago(e.updated) + ')')}${by}${loc}${dirtyTag}${shelf}`);
    console.log(`     → ${e.next}`);
  };

  for (const fam of families) {
    const members = shown.filter((e) => e.parent === fam);
    console.log(`\n${c('1;35', '▸ ' + fam)}`);
    members.forEach(printEntry);
  }
  const solo = shown.filter((e) => !e.parent);
  if (solo.length) {
    if (families.length) console.log(`\n${c('1;35', '▸ standalone')}`);
    solo.forEach(printEntry);
  }

  // Several active projects in one checkout on one branch is how work gets
  // tangled. Nothing else in gtg could see this before worktree/branch existed.
  // Tolerant migration: entries with no `worktree` at all (pre-Task-4) would
  // otherwise all collapse onto one '? @ repo root' key and falsely "collide" -
  // skip them, only entries with a real recorded location are compared.
  const byLocation = new Map();
  const BASE_BRANCHES = new Set(['master', 'main']);
  for (const e of shown) {
    if (!e.worktree) continue;
    // master/main @ repo root is the SANCTIONED shared home for docs/meta work
    // (home-repo doctrine - meta paths commit straight to master), not a tangle.
    // Only a real feature-branch collision (or a shared non-root worktree) warns.
    if (e.worktree === 'repo root' && BASE_BRANCHES.has(e.branch)) continue;
    const key = `${e.branch || '?'} @ ${e.worktree}`;
    byLocation.set(key, [...(byLocation.get(key) || []), e.project]);
  }
  for (const [key, names] of byLocation) {
    if (names.length > 1) console.log(`\n${c('33', `⚠ ${names.length} projects share ${key} - ${names.join(', ')}`)}`);
  }

  // BOTH exits, not just the empty one. A query that matches active work AND a shelved extension
  // entry takes this path, and printing only on the empty branch silently dropped the shelved hit
  // exactly when the reuse probe is most likely to go wrong: SKILL.md reuses a slug only when
  // EXACTLY ONE entry matches, so a dropped hit turns two matches into one wrong one.
  if (shelvedHits.length) console.log('');
  printShelved();

  if (blCount) console.log(`\n+ ${blCount} backlogged - gtg backlog`);
}

function backlogList() {
  // Excluded up front, not just in the sortByProject call below, so the header count and the
  // empty-shelf message describe the rows actually rendered.
  const bl = userVisible(entries('backlog'));
  if (!bl.length) {
    console.log("Backlog is empty. Shelf an active entry with 'gtg back <n>', or park an idea with 'gtg backlog --project ...'.");
    return;
  }
  console.log(`${bl.length} backlogged project${bl.length === 1 ? '' : 's'}:`);
  sortByProject(bl).forEach((e, i) => {
    console.log(`${c('33', 'b' + (i + 1) + '.')} ${c('1;36', e.project)} ${c('2', 's' + (e.sessions ?? countHandoffFiles(e.slug)))} [${c('32', e.eta || '?')}] ${c('2', '(parked ' + ago(e.updated) + ')')}${e.harness ? c('2', ' ·' + e.harness) : ''}`);
    console.log(`    next: ${e.next}`);
  });
  console.log('Activate: gtg active <n>');
}

function help() {
  console.log(`gtg - pause/resume + backlog bookkeeping
  gtg handoff --project --slug [--next] [--eta] [--parent] [--worktree] [--branch] [--dry-run]   (body on stdin)
      --next defaults to the body's "## Next Action" first line; --worktree to the repo you run it from
      [--wip]      commit the worktree's uncommitted work first (worktree only, never the shared root)
      [--exact]    keep --slug literally; by default one name-matching entry lends its slug
      [--harness]  who wrote it (claude|codex|...); auto-detected from the environment
      appends "## Task list" (harness task store) and, in a worktree, "## Commits this session"
      and "## Files touched" (git log since the session started) unless the body has them;
      runs <root>/.gtg/after-handoff.mjs afterwards if present (default export fn(ctx))
  gtg backlog [same flags]     park on the backlog shelf (body on stdin); bare = list the shelf
  gtg list [project]           active handoffs (+ 7-day auto-shelf sweep); optional filter
  gtg back <n|slug>            shelf an active entry to the backlog
  gtg active <n|slug>          reactivate a backlog entry
  gtg remove <n|slug>          drop an entry (active first, then backlog)
  gtg resume [n|slug|name] [--keep]
                               the whole pick-up: fast-forwards the hub from obelisk-backup
                               (silent when offline or already current), prints the handoff,
                               consumes the entry (NOT a ship), runs
                               <root>/.gtg/after-resume.mjs if present. Bare = the
                               only active project, else the list. --keep reads without consuming
                               (issue packages). Exit 1 = choose from the candidates printed
  gtg supersede <n|slug> [--into <n|slug>]
                               rolled up or created in error (neither ship nor abandon)
  gtg rename <n|slug> <new>    change a slug, re-pointing any sub-projects. With a slug nothing
                               here carries, it repairs a stale parent reference instead
  gtg unparent <n|slug>        clear an entry's parent, so it lists as standalone
  gtg log [n|slug] [-n N]      what happened, read from git rather than a ledger
  gtg undo                     revert THIS SESSION'S last change to the stores
  gtg stats                    one-screen scoreboard: streak, ships, sessions, effort
  gtg report                   full report JSON -> docs/handoffs/_report.json
After a move (back/active/remove/resume/undo) the updated list auto-prints when
stdout is a terminal; it stays silent when piped (so an AI wastes no context).
Force either way with --list / --no-list.
Storage root: GTG_HUB env var if set, else the enclosing git repo.
stats/report ship bundled; unknown commands dispatch to <root>/.gtg/commands/<name>.mjs,
which overrides a bundled one of the same name - see README "Extending gtg".`);
}

// --- back / active / remove / undo --------------------------------------------
function back(argv) {
  const t = argv[0];
  if (!t) { console.error("Usage: gtg back <number|slug>  (see 'gtg list')"); process.exit(2); }
  const act = entries('active');
  const match = resolveEntry(act, t, displayOrder);
  if (!match) { console.error(`No active project matching '${t}'. Try 'gtg list'.`); process.exit(2); }
  match.updated = nowIso(); // restamp = parked-at
  const bl = entries('backlog').filter((e) => e.slug !== match.slug);
  bl.push(match);
  const paths = [...saveEntries('active', act.filter((e) => e !== match)),
                 ...saveEntries('backlog', bl)];
  commit(paths, `gtg backlog: park ${match.project}`);
  // `|| match.slug` for the same reason printEntry substitutes a slug label: an extension entry
  // has no position in the listing these numbers index, so indexOf is -1 and the hint would read
  // 'gtg active 0', which resolveEntry turns into arr[-1] and exits 2. Print what actually works.
  const hint = sortByProject(bl).indexOf(match) + 1 || match.slug;
  console.log(`Parked: ${match.project} -> backlog. Bring back: gtg active ${hint}`);
}

function activate(argv) {
  const t0 = argv[0];
  if (!t0) { console.error("Usage: gtg active <number|slug>  (see 'gtg backlog')"); process.exit(2); }
  const t = t0.replace(/^[bB](?=\d+$)/, ''); // accept the b<n> numbering `gtg backlog` shows
  const bl = entries('backlog');
  if (!bl.length) { console.error('Backlog is empty - nothing to activate.'); process.exit(2); }
  const match = resolveEntry(bl, t);
  if (!match) { console.error(`No backlog project matching '${t0}'. Try 'gtg backlog'.`); process.exit(2); }
  match.updated = nowIso();
  const act = entries('active').filter((e) => e.slug !== match.slug);
  act.push(match);
  const paths = [...saveEntries('backlog', bl.filter((e) => e !== match)),
                 ...saveEntries('active', act)];
  commit(paths, `gtg activate: ${match.project}`);
  // active list is display-ordered. `|| match.slug` is the mirror of the one in back(), and for
  // the same reason: an extension entry has no numbered row, so 'gtg back 0' would exit 2.
  const hint = displayOrder(act).indexOf(match) + 1 || match.slug;
  console.log(`Activated: ${match.project}. Shelve again: gtg back ${hint}`);
}

// The slug is what every other verb takes, and it is ALSO how a sub-project names its family
// via `parent`. So a rename has to re-point the children in the same operation, on both
// shelves, or the family silently splits into orphans that list as standalone.
//
// Handoff FILES keep the old slug in their names, deliberately. A past handoff records what the
// project was called at the time, and renaming those files would rewrite that record and break
// the `file` field every entry carries. gtg log still finds them: commit subjects carry the
// project NAME, which a slug rename does not touch.
function rename(argv) {
  const [from, to] = argv;
  if (!from || !to) { console.error('Usage: gtg rename <number|slug> <new-slug>'); process.exit(2); }
  // Same constraint --slug is held to, and for the same reason: a slug becomes a path segment.
  if (!/^[A-Za-z0-9_-]+$/.test(to)) {
    console.error('gtg rename: <new-slug> must match [A-Za-z0-9_-]'); process.exit(2);
  }
  const act = entries('active');
  const bl = entries('backlog');
  // Active wins a collision, the same precedence resume uses.
  const match = resolveEntry(act, from, displayOrder) ?? resolveEntry(bl, from);
  if (!match) {
    // No entry carries this slug, but `parent` names a slug in the PORTFOLIO, not here. So a
    // rename over there leaves references here pointing at something that no longer exists, and
    // repairing them is what `projects rename` tells the caller to run this for. Exact match
    // only, never resolveEntry's fuzzy name matching: a parent is always a slug.
    //
    // No collision check on `to` on this path. The new parent SHOULD normally be a slug that
    // already exists, which is the exact opposite of what the entry case requires.
    const kids = [...act, ...bl].filter((e) => e.parent === from);
    if (!kids.length) {
      console.error(`No project or parent reference matching '${from}'. Try 'gtg list'.`);
      process.exit(2);
    }
    for (const e of kids) e.parent = to;
    const paths = [...saveEntries('active', act), ...saveEntries('backlog', bl)];
    commit(paths, `gtg rename: parent ${from} to ${to}`);
    console.log(`Re-pointed ${kids.length} entr${kids.length === 1 ? 'y' : 'ies'} from parent '${
      from}' to '${to}'. Nothing here carries '${from}' as its own slug.`);
    return;
  }
  const old = match.slug;
  if (old === to) { console.error(`gtg rename: '${to}' is already its slug`); process.exit(2); }
  if ([...act, ...bl].some((e) => e.slug === to)) {
    console.error(`gtg rename: '${to}' is already used by another project`); process.exit(2);
  }
  match.slug = to;
  let kids = 0;
  for (const e of [...act, ...bl]) if (e.parent === old) { e.parent = to; kids++; }
  // Both stores every time. The entry sits on one shelf but a child can sit on the other.
  // The renamed entry's file MOVES (old.json -> to.json), so `deleted` carries the old name
  // and the commit has to name it or the removal is left staged for another session.
  const paths = [...saveEntries('active', act), ...saveEntries('backlog', bl)];
  commit(paths, `gtg rename: ${old} to ${to}`);
  console.log(`Renamed: ${match.project} (${old} -> ${to})${
    kids ? `, re-pointed ${kids} sub-project(s)` : ''}`);
  console.log(`The portfolio slug is separate. Match it with: projects rename ${old} ${to}`);
}

// The inverse of rename's parent path. rename can only re-POINT a parent, and its <new> is
// held to the slug regex, so there was no way to say "this entry belongs to no family".
// Re-pointing a dangling parent at its own project's slug just trades a dangling parent for a
// self-parent, which is the same defect in a different costume.
//
// A dangling parent and a self-parent both already list as standalone (see inferParent), so
// this fixes the stored record rather than today's behaviour: the value stops claiming a
// family that is not there, and a later reader stops having to know that.
//
// Entry-scoped, deliberately, unlike rename's second path which acts on every child of a
// parent at once. Clearing is the operation you want to watch happen one entry at a time.
function unparent(argv) {
  const t = argv[0];
  if (!t) { console.error("Usage: gtg unparent <number|slug>  (see 'gtg list')"); process.exit(2); }
  const act = entries('active');
  const bl = entries('backlog');
  // Active wins a collision, the same precedence rename and resume use.
  const match = resolveEntry(act, t, displayOrder) ?? resolveEntry(bl, t);
  if (!match) { console.error(`No project matching '${t}'. Try 'gtg list'.`); process.exit(2); }
  // Refused rather than passed over, the same call rename makes on a no-op rename. A silent
  // success here reads as "there was a parent and it is gone", which is a different fact.
  if (!match.parent) {
    console.error(`gtg unparent: '${match.slug}' has no parent`);
    process.exit(2);
  }
  const had = match.parent;
  // Deleted, not set to null or '': absent gets ONE representation, which is what every
  // reader here already branches on with a bare truthiness test.
  delete match.parent;
  // `updated` is NOT restamped. Bookkeeping is not work, the same rule rename follows, and
  // restamping would restart the 7-day idle clock `list` auto-shelves on.
  const paths = [...saveEntries('active', act), ...saveEntries('backlog', bl)];
  commit(paths, `gtg unparent: ${match.project}`);
  console.log(`Cleared parent '${had}' from ${match.project}. It now lists as standalone.`);
}

// The record IS git. Every verb here commits with a descriptive subject, so the two stores
// already carry the whole history and a written ledger would be a second, thinner copy of it.
// Subjects carry the project NAME rather than the slug, so filtering resolves the entry first.
function log(argv) {
  const t = argv.find((a) => !a.startsWith('-'));
  const i = argv.indexOf('-n');
  const n = i === -1 ? '20' : (argv[i + 1] ?? '20');
  const filter = [];
  if (t) {
    const match = resolveEntry(entries('active'), t, displayOrder)
      ?? resolveEntry(entries('backlog'), t);
    if (!match) { console.error(`No project matching '${t}'. Try 'gtg list'.`); process.exit(2); }
    // --fixed-strings: a project name is free text and can hold regex metacharacters.
    filter.push('--fixed-strings', '--grep', match.project);
  }
  let out = '';
  try {
    out = execFileSync('git', ['log', `-n${n}`, '--date=short', '--format=%h %ad %s',
      ...filter, '--', ...STORE_PATHSPEC],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch {
    console.error('gtg log: no git history here'); process.exit(1);
  }
  process.stdout.write(out || 'gtg log: nothing recorded yet\n');
}

function remove(argv) {
  const t = argv[0];
  if (!t) { console.error("Usage: gtg remove <number|slug>  (see 'gtg list')"); process.exit(2); }
  const act = entries('active');
  const match = resolveEntry(act, t, displayOrder);
  if (match) {
    commit(saveEntries('active', act.filter((e) => e !== match)),
      `gtg prune: remove ${match.project} - confirmed done`);
    console.log(`Removed: ${match.project}`);
    return;
  }
  // not in active - try the backlog (lets resume-consume clear a pulled backlog item)
  const bl = entries('backlog');
  const blMatch = resolveEntry(bl, t.replace(/^[bB](?=\d+$)/, ''));
  if (blMatch) {
    commit(saveEntries('backlog', bl.filter((e) => e !== blMatch)),
      `gtg prune: remove ${blMatch.project} from backlog - confirmed done`);
    console.log(`Removed from backlog: ${blMatch.project}`);
    return;
  }
  console.error(`No project matching '${t}'. Try 'gtg list' or 'gtg backlog'.`);
  process.exit(2);
}

// supersede = this entry was rolled up or created in error, NOT shipped and NOT
// given up on. `remove` writes a phantom ship and `back` reads as shelved-for-later,
// so consolidating N slices into one parent used to corrupt whichever stat you
// borrowed (2026-07-25: 7 slices reported as abandoned forever, 12 minutes after
// being consolidated into a live sub-project). Its own subject gives history.mjs a
// type to exclude from both ships and abandonments, and --into records which entry
// absorbed it rather than leaving the roll-up implicit.
function supersede(argv) {
  const [t, ...rest] = argv;
  if (!t) { console.error('Usage: gtg supersede <number|slug> [--into <number|slug>]'); process.exit(2); }
  const i = rest.indexOf('--into');
  if (i !== -1 && !rest[i + 1]) { console.error('gtg supersede: --into needs a target'); process.exit(2); }
  const intoArg = i === -1 ? null : rest[i + 1];

  const act = entries('active');
  const bl = entries('backlog');
  const stripB = (s) => s.replace(/^[bB](?=\d+$)/, '');
  // Active wins a collision, the same precedence resume and rename use.
  const match = resolveEntry(act, t, displayOrder) ?? resolveEntry(bl, stripB(t));
  if (!match) { console.error(`No project matching '${t}'. Try 'gtg list' or 'gtg backlog'.`); process.exit(2); }

  // The absorbing entry is usually a gtg entry, but it can equally be a docs/projects
  // page no entry exists for, so an unresolvable target passes through as text rather
  // than being rejected.
  let into = null;
  if (intoArg) {
    const target = resolveEntry(act, intoArg, displayOrder) ?? resolveEntry(bl, stripB(intoArg));
    if (target === match) { console.error('gtg supersede: an entry cannot supersede itself'); process.exit(2); }
    into = target ? target.project : intoArg;
  }

  const paths = [...saveEntries('active', act.filter((e) => e !== match)),
                 ...saveEntries('backlog', bl.filter((e) => e !== match))];
  commit(paths, `gtg supersede: ${match.project}${into ? ` into ${into}` : ''}`);
  console.log(`Superseded: ${match.project}${into ? ` -> ${into}` : ' (created in error)'}`);
}

// resume-consume: same removal as prune, DIFFERENT commit subject. Keeping these
// distinct is what lets history tell "shipped" apart from "picked back up".
// The whole resume in one call (3.0.0): resolve the name, print the handoff, consume the
// entry, run the after-resume hook. Before this the skill read both store files (25KB on a
// busy hub), then the handoff, then called consume, then probed for a markdown hook: five
// turns and the entire store in context to pick one entry out of it.
//
// Exit codes: 0 resumed, 1 a choice is needed (candidates printed on stdout), 2 nothing to
// resume. Output order is deliberate: the handoff text lands before the store write, so a
// consume failure still leaves the content on screen.
function commandFileFor(t) {
  if (!/^[A-Za-z0-9_-]+$/.test(t)) return false;
  return existsSync(join(ROOT, '.gtg', 'commands', `${t}.mjs`))
    || existsSync(join(CLI_DIR, 'extensions', 'commands', `${t}.mjs`));
}

// Fast-forward the hub from its mirror before anything reads the store. POSITION IS THE WHOLE
// POINT (2026-09-01): this shipped first inside .gtg/after-resume.mjs, which runs AFTER
// entries() has read, the handoff has printed and the consume has committed - so home was
// always one commit ahead and --ff-only aborted in exactly the case the sync exists for, a
// mirror carrying the other machine's work. A fetch after the read cannot change what the
// read returned. Handing entries between Obelisk and reborn is why this store is git at all.
// Background: docs/runbooks/git-parity.md.
//
// A convenience, NEVER a gate. Every git failure is swallowed and each call capped at 5s, so
// a resume offline, off Tailscale, in a repo with no such remote, or mid-rebase behaves
// exactly as it did before this existed. And stdout speaks only on a real fast-forward: a
// line on every resume is noise, and noise on the hot path is how a real one goes unread.
const SYNC_REMOTE = 'obelisk-backup'; // the hub's Forgejo mirror on Obelisk
const SYNC_BRANCH = 'master';         // home's one branch - every worktree is branched off it
function syncHub() {
  // stderr piped, not inherited: execFileSync forwards a child's stderr to ours otherwise,
  // and git narrates a refused fast-forward in nine hint: lines - five of git's own above every
  // line of ours. The after-resume hook piped it for the same reason before this moved here.
  const git = (...args) => execFileSync('git', args,
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).toString().trim();
  let before;
  try {
    // Branch-gated. gtg runs from feature worktrees too (GTG_HUB usually points them back at
    // home, but not always), and fast-forwarding a feature branch onto master's tip merely
    // because it happens to be an ancestor would rewrite what the caller is standing on.
    // A detached HEAD reports as 'HEAD' and skips, which is the right answer there too.
    if (git('rev-parse', '--abbrev-ref', 'HEAD') !== SYNC_BRANCH) return;
    before = git('rev-parse', 'HEAD');
    git('fetch', '--quiet', SYNC_REMOTE, SYNC_BRANCH);
  } catch { return; } // no remote, host down, offline, not a repo: local state stands, silently
  try {
    git('merge', '--ff-only', '--quiet', `${SYNC_REMOTE}/${SYNC_BRANCH}`);
  } catch {
    // The fetch landed and the fast-forward was refused. Home being AHEAD of the mirror is the
    // normal state and says nothing. The mirror holding commits home does not have means a
    // genuine fork or a dirty tree in the way, and resolving either is Nathan's call, not a
    // resume's - auto-merging a divergence is what caused the 2026-08-02 fork. On stderr, so
    // "stdout speaks only on a real fast-forward" still holds.
    try { git('merge-base', '--is-ancestor', `${SYNC_REMOTE}/${SYNC_BRANCH}`, 'HEAD'); } catch {
      console.error(`gtg: ${SYNC_REMOTE}/${SYNC_BRANCH} will not fast-forward (diverged, or local changes in the way) - resuming from local state`);
    }
    return;
  }
  try {
    const after = git('rev-parse', 'HEAD');
    if (after !== before) console.log(`Synced ${SYNC_REMOTE}/${SYNC_BRANCH}: fast-forwarded to ${after.slice(0, 7)}`);
  } catch { /* the merge already succeeded; failing to name it is not worth a word */ }
}

async function resumeConsume(argv) {
  const a = parseFlags(argv);
  const t = argv.find((x) => !x.startsWith('--'));
  // Before the two reads below, deliberately. See syncHub: after them it is decoration.
  syncHub();
  const act = entries('active');
  const bl = entries('backlog');
  let match = null;
  let fromBacklog = false;
  if (!t) {
    // Bare `gtg` at session start: one open project is not a choice, several are.
    const vis = userVisible(act);
    if (vis.length === 1) match = vis[0];
    else {
      renderList([]);
      console.log(vis.length ? '\nWhich? gtg <project>' : '\nNothing to resume.');
      process.exit(vis.length ? 1 : 2);
    }
  } else {
    match = resolveEntry(act, t, displayOrder);
    // A name fragment that fits several projects is a question, not a guess. A number or an
    // exact slug is never ambiguous.
    const nameHits = act.filter((e) => e.project.toLowerCase().includes(t.toLowerCase()));
    if (match && !/^\d+$/.test(t) && match.slug !== t && nameHits.length > 1) {
      console.log(`'${t}' matches ${nameHits.length} active projects:`);
      nameHits.forEach((e, i) => console.log(`  ${i + 1}. ${e.project} (${e.slug}) - ${e.next}`));
      console.log('Which? gtg <slug>');
      process.exit(1);
    }
    if (!match) {
      match = resolveEntry(bl, t.replace(/^[bB](?=\d+$)/, ''));
      fromBacklog = !!match;
    }
    if (!match) {
      console.error(commandFileFor(t)
        ? `No project matching '${t}'; '${t}' is a command - run gtg ${t}.`
        : `No project matching '${t}'. Try 'gtg list' or 'gtg backlog'.`);
      process.exit(2);
    }
    // Session-start collision: a project AND a command share the token (a project called
    // `issues`, say). Both are real; picking silently made one of them unreachable.
    if (!/^\d+$/.test(t) && commandFileFor(t)) {
      console.log(`'${t}' is both a project and a command:`);
      console.log(`  1. ${match.project} (${match.slug}) - ${match.next}`);
      console.log(`  2. run the \`${t}\` command`);
      console.log('Which?');
      process.exit(1);
    }
  }
  const file = match.file ? join(ROOT, match.file) : null;
  const body = file && existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
  const when = typeof match.updated === 'string' ? match.updated.slice(0, 16).replace('T', ' ') : '?';
  console.log(`RESUME: "${match.project}" - handoff of ${when}${match.file ? ` (${match.file})` : ''}`);
  console.log(body ?? `(no handoff file at ${match.file ?? 'none'}; the entry's next action is all there is: ${match.next})`);
  if (a.keep) {
    console.log(`Kept: ${match.project} (not consumed)`);
  } else if (fromBacklog) {
    commit(saveEntries('backlog', bl.filter((e) => e !== match)),
      `gtg resume: ${match.project} - backlog handoff consumed`);
    console.log(`Consumed from backlog: ${match.project}`);
  } else {
    commit(saveEntries('active', act.filter((e) => e !== match)),
      `gtg resume: ${match.project} - handoff consumed`);
    console.log(`Consumed: ${match.project}`);
  }
  // After-resume hook: <root>/.gtg/after-resume.mjs, the resume-side twin of after-handoff.
  // Replaces the markdown on-resume.md the model used to probe for and read.
  const hook = join(ROOT, '.gtg', 'after-resume.mjs');
  if (existsSync(hook)) {
    try {
      const mod = await import(pathToFileURL(hook).href);
      if (typeof mod.default !== 'function') throw new Error('no default export function');
      await mod.default({ root: ROOT, entry: match, file: match.file ?? null, body: body ?? '', kept: !!a.keep, readStore, writeStore, commit });
    } catch (e) {
      console.error(`gtg: after-resume hook failed - ${(e.stderr || e.message || String(e)).toString().trim().split('\n')[0]}`);
      process.exitCode = 1;
    }
  }
}

// undo = restore BOTH stores from before THIS SESSION'S last commit that touched
// either one; repeats to step further back. Two refusals guard the concurrent case,
// both of them loud: no change of ours to undo, and our change no longer being the
// tip. Before 2026-08-04 undo took whatever commit was last and reverted it.
//
// Finding C1, and the rule it left behind: the anchor must span BOTH collections.
// It was once picked from the active store alone, but two mutations touch the
// backlog ONLY (`gtg backlog --project ...` parking a new idea, and
// `gtg resume <backlog-slug>`), so an active-only anchor skipped right past those,
// landed on an unrelated older active-list commit, reverted THAT instead, and
// silently deleted the backlog. STORE_PATHSPEC is what keeps that fixed now: it
// names both sharded directories, so a backlog-only commit is still the anchor,
// and it keeps the legacy packed files too so undoing a pre-shard commit works.
//
// The restore below is per PATH rather than per store. A sharded collection is
// many files and a commit usually touches one or two of them, so rewinding a
// whole directory would discard records the commit never mentioned - the same
// class of over-reach C1 was about, one level down.
function undo() {
  const storeLog = (extra = []) => {
    try {
      return execFileSync('git', ['log', '-1', '--format=%H%x1f%s%x1f%ar', ...extra, '--', ...STORE_PATHSPEC],
        { cwd: ROOT }).toString().trim();
    } catch { return ''; }
  };
  const parse = (line) => { const [sha, subject, age] = line.split('\x1f'); return { sha, subject, age }; };

  const tipLine = storeLog();
  if (!tipLine) { console.error('No gtg history to undo.'); process.exit(2); }
  const tip = parse(tipLine);

  // Undo means "revert MY last change", which is how it has always been advertised.
  // Without a session id there is no way to tell whose change is whose, so refuse
  // rather than revert a stranger's (see SESSION_ID above).
  if (!SESSION_ID) {
    console.error('gtg undo: no session id, so gtg cannot tell your change from another session\'s.');
    console.error(`  Last store commit: '${tip.subject}' (${tip.age}, ${tip.sha.slice(0, 8)})`);
    console.error('  Set GTG_SESSION_ID to scope undo, or revert that commit by hand if it is yours.');
    process.exit(2);
  }
  const mineLine = storeLog(['-F', '--grep', `${SESSION_TRAILER}: ${SESSION_ID}`]);
  if (!mineLine) {
    console.error('gtg undo: no change from this session to undo.');
    console.error(`  Last store commit: '${tip.subject}' (${tip.age}, ${tip.sha.slice(0, 8)}) - not this session's.`);
    process.exit(2);
  }
  const mine = parse(mineLine);

  // Scoping the ANCHOR is not enough on its own: the restore below rewinds each
  // store to the anchor's PARENT, which would also throw away anything committed
  // after it. So the change being undone has to still be the tip of store history.
  if (mine.sha !== tip.sha) {
    console.error(`gtg undo: another session changed the store after yours - undoing would discard their work.`);
    console.error(`  Yours:  '${mine.subject}' (${mine.age})`);
    console.error(`  Theirs: '${tip.subject}' (${tip.age}, ${tip.sha.slice(0, 8)})`);
    process.exit(2);
  }

  const last = mine.sha;
  const subject = mine.subject;

  // Rewind every path the anchor commit touched to its state at `${last}^`. The packed store
  // made this two whole files; a sharded store is many, so the unit is now "the paths this
  // commit changed" and git names them for us. STORE_PATHSPEC covers the packed files too, so
  // an undo of a pre-shard commit still works exactly as it used to. `--root` keeps the
  // very-first-commit case working (no parent to diff against).
  //
  // A path absent at `last^` was CREATED by this commit, so undoing it means removing it -
  // the same rule the packed version followed, and the reason a deletion has to be in the
  // commit path list below rather than left in the working tree.
  let changed = [];
  try {
    changed = execFileSync('git', ['diff-tree', '-r', '--root', '--no-commit-id', '--name-only',
      last, '--', ...STORE_PATHSPEC], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { /* the empty check below reports it */ }

  const paths = [];
  for (const rel of changed) {
    const abs = join(ROOT, rel);
    let prev = null;
    try { prev = execFileSync('git', ['show', `${last}^:${rel}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
    catch { /* absent at last^ - this commit created it */ }
    if (prev !== null) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, prev); }
    else if (existsSync(abs)) rmSync(abs);
    else continue; // created by the commit and already gone - nothing to undo for this path
    paths.push(rel);
  }
  if (!paths.length) {
    console.error(`Nothing before '${subject}' - can't undo further.`);
    process.exit(2);
  }

  commit(paths, `gtg undo: revert '${subject}'`);
  // Report what came back without re-running list() - list() calls autoShelf(),
  // which would immediately re-park a still-stale restored entry (and commit again).
  const names = entries('active').map((e) => e.project);
  console.log(`Undone: ${subject}`);
  console.log(`Active entries now (${names.length}): ${names.join(', ') || '(none)'}`);
}

// After a move (back/active/remove/resume/undo) a HUMAN wants the updated list;
// an AI does not - gtg runs piped when a tool invokes it (stdout not a TTY), so
// TTY-gating suppresses the render for models with zero wasted context, no flag
// needed. --list / --no-list force it either way. renderList (not list) so undo's
// just-restored stale entry isn't immediately re-shelved by autoShelf.
function maybeAutoList(argv) {
  const a = parseFlags(argv);
  if (a['no-list']) return;
  if (a.list || process.stdout.isTTY) renderList([]);
}
const MOVE_CMDS = new Set(['back', 'active', 'remove', 'rm', 'prune', 'resume', 'undo', 'rename', 'supersede']);

// --- dispatch -----------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
const builtins = {
  handoff, backlog, list, help, '--help': help, '-h': help,
  back, active: activate, remove, rm: remove, prune: remove, resume: resumeConsume, undo,
  rename, unparent, log, supersede,
};
if (!cmd) { list([]); }
// hasOwn, not truthiness: every inherited Object key resolved here, so `gtg constructor` and
// `gtg toString` called something that is not a verb instead of falling through to the
// extension lookup and then the unknown-command error.
else if (Object.hasOwn(builtins, cmd)) {
  await builtins[cmd](rest);
  if (MOVE_CMDS.has(cmd)) maybeAutoList(rest);
}
else {
  // Extension dispatch, in resolution order: user <root>/.gtg/commands/<cmd>.mjs FIRST
  // (user overrides bundled), then the plugin's own extensions/commands/<cmd>.mjs
  // (bundled, ships active). cmd becomes a path segment - constrain it the same way
  // --slug is, so it can't traverse paths. ctx is a STABILITY CONTRACT (additive-only).
  const safe = /^[A-Za-z0-9_-]+$/.test(cmd);
  const userExt = safe ? join(ROOT, '.gtg', 'commands', `${cmd}.mjs`) : null;
  const bundledExt = safe ? join(CLI_DIR, 'extensions', 'commands', `${cmd}.mjs`) : null;
  const ext = (userExt && existsSync(userExt)) ? userExt
    : (bundledExt && existsSync(bundledExt)) ? bundledExt
    : null;
  if (ext) {
    try {
      const mod = await import(pathToFileURL(ext).href);
      if (typeof mod.default !== 'function') throw new Error('no default export function');
      const ownParent = EXTENSIONS[cmd] ?? null;
      // Both stores, always. An entry idle over 7 days is auto-shelved onto the backlog by
      // `list`, so an active-only read reports a live package as missing.
      //
      // Through `entries`, NOT `readStore`: readStore keeps its packed shape for the published
      // extension context, so reading the store through it here would serve issues.mjs and
      // learn.mjs the frozen pre-shard file and report every entry written since as missing.
      const ownEntries = () => {
        const grab = (which) => (ownParent ? entries(which).filter((e) => e.parent === ownParent) : []);
        return { active: grab('active'), shelved: grab('backlog') };
      };
      // ownParent rides the ctx as well as being closed over by ownEntries: an extension that
      // WRITES an entry needs the same namespace its reader filters on, and deriving it a
      // second time on the writer side is exactly the drift class this closes.
      await mod.default({ root: ROOT, args: rest, readStore, writeStore, commit, countHandoffFiles, ownEntries, ownParent });
    } catch (e) {
      console.error(`gtg: extension '${cmd}' failed: ${(e?.message || String(e)).split('\n')[0]}`);
      process.exit(1);
    }
  } else {
    console.error(`gtg: unknown command '${cmd}' - try 'gtg help'`);
    process.exit(2);
  }
}
