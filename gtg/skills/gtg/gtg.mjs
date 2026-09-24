#!/usr/bin/env node
// gtg - zero-model bookkeeping CLI for the gtg pause/resume skill.
// Storage root: GTG_HUB env var if set, else the current git repo's root.
// Unknown subcommands dispatch to <root>/.gtg/commands/<name>.mjs (see README).
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readCollection, writeCollection } from './lib/store.mjs';
import { forgeConfig, openForge } from './lib/forge.mjs';
import { readProgress, renderProgress, renderProgressTaskList } from './lib/progress.mjs';

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
const DIR_ACTIVE = 'docs/handoffs/active';
const DIR_BACKLOG = 'docs/handoffs/backlog';
// `which` -> the directory that holds its records. One file per record, and the directory is the
// whole store: the packed files these replaced are deleted as of 3.3.0, and nothing reads them.
const COLLECTIONS = { active: DIR_ACTIVE, backlog: DIR_BACKLOG };
// The packed stores, DELETED in 3.3.0 and named here for git HISTORY only. They are not read
// from disk anywhere - readCollection lost its fallback with them - but `log` and `undo` read
// history, and history spans the migration. Dropping these two paths would make every pre-shard
// commit invisible to `gtg log` and would leave `gtg undo` on a pre-shard commit unable to see
// its own change (the whole store moved out from under the pathspec it anchors on). A pathspec
// naming a path that no longer exists in the worktree is legal and matches its old commits.
const PACKED_ACTIVE = 'docs/handoffs/_active.json';
const PACKED_BACKLOG = 'docs/handoffs/_backlog.json';
const STORE_PATHSPEC = [PACKED_ACTIVE, PACKED_BACKLOG, DIR_ACTIVE, DIR_BACKLOG];
const SLUG_OK = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
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
// Progress also records Codex's native task/session identity. Keep this separate from undo's
// established identity contract: progress attribution is history, not process ownership.
const PROGRESS_SESSION_ID = process.env.GTG_SESSION_ID
  || process.env.CODEX_THREAD_ID
  || process.env.CODEX_SESSION_ID
  || process.env.CLAUDE_CODE_SESSION_ID
  || '';
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
// The one line of a child-process failure that actually says what went wrong. Three traps, each
// of which has printed a useless message here:
//   - `e.stderr` under stdio:'pipe' is a BUFFER, and an EMPTY buffer is TRUTHY, so the usual
//     `e.stderr || e.message` shadows the message entirely - a timeout kill printed a bare dash.
//   - git leads with "warning: LF will be replaced by CRLF" on a Windows checkout, so the first
//     line is git's line-ending advice rather than the cause.
//   - a refused fast-forward leads with nine `hint:` lines.
// So: coerce, prefer stderr only when it has content, and take the first line that is neither
// blank nor advice. Falls back to the first line of whatever there is rather than to ''.
function firstMeaningfulLine(e) {
  const raw = `${e?.stderr ?? ''}`.trim() || `${e?.message ?? ''}`.trim() || String(e ?? '');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => !/^(warning|hint):/i.test(l)) || lines[0] || '';
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
    console.error(`gtg: git commit failed, changes are on disk but uncommitted - ${firstMeaningfulLine(e)}`);
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
//
// With <root>/.gtg/forge.json the records live on a forge instead (lib/forge.mjs). FORGE holds them
// in memory for this one process, and the dispatcher flushes the difference when the command ends.
let FORGE = null;
function entries(which) {
  if (FORGE) return FORGE.entries(which);
  return readCollection(ROOT, COLLECTIONS[which]);
}
// Returns the repo-relative paths touched, INCLUDING deletions, because commit() must name
// every path on both `git add` and `git commit` or a removal is left for another session to
// pick up as its own.
function saveEntries(which, items) {
  if (FORGE) return FORGE.save(which, items);
  const { written, deleted } = writeCollection(ROOT, COLLECTIONS[which], items);
  return [...written, ...deleted];
}

// Fallback sync target, used only when the branch has no upstream - the reasoning lives at
// syncTarget() below, beside the code that consults it. DECLARED HERE because the resume-path
// sync a few lines down runs at import time: syncHub is a hoisted function declaration and can be
// called before its definition, but a `const` still in its temporal dead zone would throw the
// moment syncTarget reached its fallback.
const SYNC_REMOTE = 'obelisk-backup'; // fallback only: home's Forgejo mirror on Obelisk
const SYNC_BRANCH = 'master';         // fallback only: the branch that mirror carries
// syncHub runs once per process, called from resumeConsume. The memo outlived the second caller
// that needed it - an import-time sync ahead of the self-migration, removed in 3.3.0 with the
// migration itself - and is kept because it is what makes the call idempotent for any future
// caller: a second fetch costs another 5-second timeout with the hub unreachable.
let synced = false;

// NO import-time migration since 3.3.0. It read the packed stores and sharded them, and both
// packed files are deleted, so there is nothing to migrate from: a tree with no record
// directory is a fresh hub, and the first write creates it. What went with the migration:
//   - the `RESUME_PATH && MIGRATION_PENDING` sync that had to run BEFORE the shard commit, or
//     the two machines each committed their own shard over the same records and every later
//     cross-machine handoff needed a human to resolve the fork. The sync that matters is still
//     there, in resumeConsume, ahead of every read - see syncHub() and gtg.test.mjs case 73.
//   - the per-collection catch that kept a corrupt packed file from taking gtg down entirely.
//     readCollection now throws per RECORD instead, which is the same protection one level
//     down: one unparseable record names itself rather than emptying a list.
// A pre-shard tree needs the pre-shard plugin. docs/runbooks/git-parity.md has the rollback.
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
// ponytail: filtered at render, NOT at read. Extensions still need slug lookup and explicit
// shelving even when their entries stay out of the default project list.
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

// Legacy handoff docs are named YYYY-MM-DD-HHMM-<slug>.md. New work uses one
// docs/handoffs/current/<slug>.md file whose git history carries each checkpoint.
// File counts remain only a migration fallback for records that predate the
// stored `sessions` counter; they are not a count of current-file revisions.
function legacyHandoffFilesFor(slug) {
  const dir = join(ROOT, 'docs/handoffs');
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-\\d{4}-${slug}\\.md$`);
  try { return readdirSync(dir).filter((f) => re.test(f)).sort(); } catch { return []; }
}
function canonicalHandoffPath(slug) { return `docs/handoffs/current/${slug}.md`; }
function countHandoffFiles(slug) {
  return legacyHandoffFilesFor(slug).length + (existsSync(join(ROOT, canonicalHandoffPath(slug))) ? 1 : 0);
}
// Reuse only paths generated by a GTG handoff writer and still present on disk.
// The filename slug may differ after `rename`; retaining that safe path preserves
// the line's history. Anything outside these two shapes falls back to the current path.
function reusableHandoffPath(rel) {
  if (typeof rel !== 'string') return null;
  const safe = isHandoffDocPath(rel);
  return safe && existsSync(join(ROOT, rel)) ? rel : null;
}
function isHandoffDocPath(rel) {
  return typeof rel === 'string'
    && /^docs\/handoffs\/(?:\d{4}-\d{2}-\d{2}-\d{4}-[A-Za-z0-9][A-Za-z0-9_-]*|current\/[A-Za-z0-9][A-Za-z0-9_-]*)\.md$/.test(rel);
}
function sameHandoffPath(a, b) {
  return typeof a === 'string' && typeof b === 'string'
    && a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase();
}
function progressSlugOnDisk(slug) {
  const dir = join(ROOT, 'docs/handoffs/progress');
  if (!existsSync(dir)) return null;
  const wanted = `${slug}.json`.toLowerCase();
  const file = readdirSync(dir).find((name) => name.toLowerCase() === wanted);
  return file ? file.slice(0, -'.json'.length) : null;
}
// Earliest handoff filename's date, as a midnight ISO stamp. Null if none exist.
function firstHandoffDate(slug) {
  const f = legacyHandoffFilesFor(slug)[0];
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
//
// `$(?![\s\S])`, not a bare `$`. The `m` flag is needed for the `^## ` anchor - a heading is
// almost never at offset 0 - but under `m` a bare `$` also matches at EVERY line end, and the
// capture is lazy: with `## Next Action\n\nDo the thing` the group tries empty first, the
// position right after the heading's newline is a line end, `$` matches there, and the section
// reads as ''. A well-formed handoff was then refused for "missing --next", `Task list` read as
// absent and got appended twice, and the home after-handoff hook wrote an empty session entry.
// The negative lookahead makes `$` mean end of STRING while `^` keeps its per-line meaning.
function sectionOf(body, heading) {
  const m = body.match(new RegExp(`^## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$(?![\\s\\S]))`, 'm'));
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
  // slug becomes a filename and a git-add arg - constrain it so it can't traverse paths or inject
  // shell. At least as strict as lib/store.mjs's own SLUG_OK, which requires an alphanumeric FIRST
  // character: a leading '-' reads as a flag to git and to argv parsing. Refused here rather than
  // inside the store because writeHandoff writes the .md to disk before it saves the entry, and
  // that no-orphan-file guarantee only holds while nothing after that write can still refuse -
  // `--slug _foo` used to pass here, land the markdown, and then throw inside writeCollection,
  // leaving an untracked .md, no entry, and a body that came from stdin and is therefore gone.
  if (!SLUG_OK.test(a.slug)) { console.error(`gtg ${verb}: --slug must start with a letter or digit and match [A-Za-z0-9_-]`); process.exit(2); }
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
  // Progress is durable state scoped by the same stable slug. Read it before any handoff or
  // --wip mutation so a corrupt matching record fails loudly without leaving half a handoff.
  const progress = readProgress(ROOT, a.slug, { optional: true });
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
  const prior = everything.find((e) => e.slug === a.slug);
  const relFile = reusableHandoffPath(prior?.file) || canonicalHandoffPath(a.slug);
  const pathOwner = everything.find((e) => e !== prior && sameHandoffPath(e.file, relFile));
  if (pathOwner) {
    console.error(`gtg ${verb}: handoff path '${relFile}' is already owned by '${pathOwner.slug}'`);
    process.exit(2);
  }
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
  if (!sectionOf(body, 'Task list')) {
    const progressTasks = progress ? renderProgressTaskList(progress) : '';
    const harnessTasks = progress ? [] : readHarnessTasks();
    if (progress) auto.push(`## Task list\n${progressTasks || '(no tasks)'}`);
    else if (harnessTasks.length) auto.push(`## Task list\n${harnessTasks.join('\n')}`);
  }
  if (progress && !sectionOf(body, 'Progress')) {
    auto.push(`## Progress (snapshot revision ${progress.revision}, updated ${progress.updatedAt})\n${renderProgress(progress)}`);
  }
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
  // `sessions` now counts checkpoint events. New records begin at one; legacy
  // records without the field seed it from the handoff files still on disk.
  // Every real handoff call bumps the record, so even an identical body produces
  // a committed checkpoint event without inventing revisions from file counts.
  const priorSessions = Number.isInteger(prior?.sessions) && prior.sessions >= 0
    ? prior.sessions
    : countHandoffFiles(a.slug);
  const sessions = priorSessions + 1;
  const entry = {
    project: a.project, slug: a.slug, sessions,
    created: prior?.created || firstHandoffDate(a.slug) || nowIso(),
    worktree, branch,
    // --parent is stable family metadata only the calling skill can know
    // (inferParent's slug-prefix fallback can't deduce e.g.
    // sub-project -> atlas) - carry it forward when the flag is
    // omitted instead of silently dropping the project out of its family.
    parent: inferParent(a.slug, a.parent) ?? prior?.parent,
    // Former display names, set by `rename --name`. A checkpoint rebuilds the entry field by
    // field, so anything not carried here is dropped on the next one.
    aka: prior?.aka,
    // A checkpoint can happen several times in one native session. Recording
    // the cumulative clock on each would make history sum 10+20+30 minutes for
    // 30 minutes of work. Only the final/departure handoff records duration.
    duration_min: a.checkpoint ? undefined : sessionDurationMin(),
    harness: (typeof a.harness === 'string' ? a.harness : undefined) ?? detectHarness(),
    eta: a.eta || prior?.eta,
    // On the forge store the body is a comment, not a file, so there is no path to record.
    next: String(a.next).slice(0, 150), file: FORGE ? undefined : relFile, updated: nowIso(),
  };
  if (a['dry-run']) {
    console.log(`--- DRY RUN: would write ${relFile} ---\n${doc}`);
    console.log(`--- ${COLLECTIONS[which]}/${a.slug}.json entry ---\n${JSON.stringify(entry, null, 2)}`);
    return;
  }
  if (FORGE) FORGE.queueHandoff(a.slug, doc);
  else {
    mkdirSync(dirname(join(ROOT, relFile)), { recursive: true });
    writeFileSync(join(ROOT, relFile), doc);
  }
  const items = entries(which).filter((e) => e.slug !== a.slug); // dedupe by slug
  items.push(entry);
  const paths = saveEntries(which, items);
  // The two stores PARTITION the work, in flight against shelved, which is what every other
  // mover already assumes: back and active MOVE an entry rather than
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
  if (FORGE) {
    // Flushed here rather than at dispatch end, so the hook below runs on a handoff that has landed.
    // The body came from stdin, so a failed write must not lose it: it goes to the file it would
    // have had on the file store, uncommitted, and the command fails.
    try {
      console.log((await FORGE.flush(verb))[0] ?? '(forge: no comment posted)');
    } catch (e) {
      mkdirSync(dirname(join(ROOT, relFile)), { recursive: true });
      writeFileSync(join(ROOT, relFile), doc);
      console.error(`gtg ${verb}: forge write failed - ${firstMeaningfulLine(e)}`);
      console.error(`  the handoff body is saved, uncommitted, at ${relFile}`);
      // exitCode, not process.exit: on Windows (Node 24) exiting right after a fetch POST trips a
      // libuv assertion and the process dies with 0xC0000409 instead of the code asked for.
      process.exitCode = 1;
      return;
    }
  } else {
    commit([relFile, ...paths], subject);
    console.log(relFile);
  }
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
      // --checkpoint keeps the handoff write identical while allowing the home
      // hook to skip departure-only ceremony for an in-session milestone update.
      await mod.default({ root: ROOT, entry, file: FORGE ? null : relFile, body: fullBody, worktree, checkpoint: !!a.checkpoint, readStore, writeStore, commit });
    } catch (e) {
      console.error(`gtg: after-handoff hook failed - ${firstMeaningfulLine(e)}`);
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

// Listing is observational. Work remains active until an explicit `back`,
// `complete`/`remove`, or `supersede` command changes its state.
function list(argv) { renderList(argv); }

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
  // still blind. Explicit shelving is normal for an issue package between fix sessions, and
  // `backlog` hides extension entries, so from
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
    const sessions = e.sessions ?? countHandoffFiles(e.slug); // legacy entries predate the field
    const by = e.harness ? c('2', ` ·${e.harness}`) : ''; // who wrote the last handoff; absent on pre-1.11 entries
    console.log(`  ${label} ${c('1;36', e.project)} ${c('2', 's' + sessions)} [${c('32', e.eta || '?')}] ${c('2', '(' + ago(e.updated) + ')')}${by}${loc}${dirtyTag}`);
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
      [--checkpoint] refresh the current handoff and set hook ctx.checkpoint without departure ceremony
      appends "## Task list" (harness task store) and, in a worktree, "## Commits this session"
      and "## Files touched" (git log since the session started) unless the body has them;
      runs <root>/.gtg/after-handoff.mjs afterwards if present (default export fn(ctx))
  gtg backlog [same flags]     park on the backlog shelf (body on stdin); bare = list the shelf
  gtg list [project]           active handoffs; read-only, with optional filter
  gtg back <n|slug> [--wake YYYY-MM-DD]
                               shelf an active entry to the backlog, optionally until a date
  gtg keep <slug> [--wake YYYY-MM-DD]
                               answer a REVIEW line with "still live": restarts its review clock
  gtg active <n|slug>          reactivate a backlog entry
  gtg complete <n|slug>        explicitly finish and clear an entry (active first, then backlog)
  gtg remove <n|slug>          drop an entry (active first, then backlog)
  gtg resume [n|slug|name] [--keep]
                               the whole pick-up: fast-forwards the hub from its upstream
                               (silent when offline or already current), prints the handoff,
                               retains the current entry, runs
                               <root>/.gtg/after-resume.mjs if present. Bare = the
                               only active project, else the list. --keep remains a compatible
                               read-only hint for hooks. Exit 1 = choose from the candidates printed
  gtg supersede <n|slug> [--into <n|slug>]
                               rolled up or created in error (neither ship nor abandon)
  gtg rename <n|slug> <new> [--name "<Display Name>"]
                               change a slug, re-pointing any sub-projects. With a slug nothing
                               here carries, it repairs a stale parent reference instead.
                               --name also moves the listed title, keeping the old one so
                               gtg log still finds history written under it
  gtg unparent <n|slug>        clear an entry's parent, so it lists as standalone
  gtg log [n|slug] [-n N]      what happened, read from git rather than a ledger
  gtg undo                     revert THIS SESSION'S last change to the stores
  gtg stats                    one-screen scoreboard: streak, ships, sessions, effort
  gtg report                   full report JSON -> docs/handoffs/_report.json
  gtg progress <verb>          persistent task progress: init, add, show, list, update
After a move (back/active/remove/resume/undo) the updated list auto-prints when
stdout is a terminal; it stays silent when piped (so an AI wastes no context).
Force either way with --list / --no-list.
Storage root: GTG_HUB env var if set, else the enclosing git repo.
With <root>/.gtg/forge.json the store is Forgejo/Gitea milestones instead of files
(skills/gtg/references/forge-store.md). log, undo, stats and report need the file store.
stats/report ship bundled; unknown commands dispatch to <root>/.gtg/commands/<name>.mjs,
which overrides a bundled one of the same name - see README "Extending gtg".`);
}

// --- review: one completion question per command ------------------------------
// Entries persist until an explicit complete, so finished work nobody completed lingers, and
// a parked entry never comes back by itself. Every command that reads or moves entries ends
// with at most ONE question, so the check rides on gtg use in any harness rather than on a
// session-start banner, which T3 Code and IDE threads never reliably see. `keep` answers
// "still live" and restarts that entry's clock without pretending it was worked on.
const REVIEW_ACTIVE_DAYS = 5;
const REVIEW_BACKLOG_DAYS = 14;
const REVIEW_CMDS = new Set(['handoff', 'list', 'backlog', 'resume', 'back', 'active', 'complete', 'remove', 'rm', 'prune', 'keep', 'supersede']);
let reviewSkip = null; // the entry this command is working on, never the one asked about

function wakeFlag(v) {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    console.error(`gtg: --wake takes a date as YYYY-MM-DD, got '${v}'`);
    process.exit(2);
  }
  return v;
}

// Priority: a backlog entry whose wake date has come, then the stalest active entry, then the
// stalest undated backlog entry. A future wake date keeps an entry out of the review entirely.
function reviewCandidate(now = Date.now()) {
  const seen = (e) => Math.max(Date.parse(e.updated) || 0, Date.parse(e.reviewed) || 0);
  const age = (e) => Math.floor((now - seen(e)) / 864e5);
  const oldest = (arr) => arr.sort((x, y) => seen(x) - seen(y))[0];
  const today = nowIso().slice(0, 10);
  const bl = userVisible(entries('backlog')).filter((e) => e.slug !== reviewSkip);
  const act = userVisible(entries('active')).filter((e) => e.slug !== reviewSkip);
  const woke = bl.filter((e) => e.wake && e.wake <= today).sort((x, y) => x.wake.localeCompare(y.wake))[0];
  if (woke) return `REVIEW: ${woke.project} [${woke.slug}] was parked until ${woke.wake}. Ask the user: pick it up (gtg active ${woke.slug}), done (gtg complete ${woke.slug}), or park again (gtg keep ${woke.slug} --wake YYYY-MM-DD).`;
  const a = oldest(act.filter((e) => age(e) >= REVIEW_ACTIVE_DAYS));
  if (a) return `REVIEW: ${a.project} [${a.slug}] untouched ${age(a)}d. Ask the user: done (gtg complete ${a.slug}), shelve (gtg back ${a.slug} [--wake YYYY-MM-DD]), or still live (gtg keep ${a.slug}).`;
  const b = oldest(bl.filter((e) => !e.wake && age(e) >= REVIEW_BACKLOG_DAYS));
  if (b) return `REVIEW: ${b.project} [${b.slug}] parked ${age(b)}d. Ask the user: done (gtg complete ${b.slug}), or still wanted (gtg keep ${b.slug} [--wake YYYY-MM-DD]).`;
  return null;
}

// Quiet for a filtered list (SKILL.md's slug-reuse probe) and for an in-session checkpoint.
function printReview(cmd, argv) {
  const a = parseFlags(argv);
  if (cmd === 'list' && argv.some((x) => !x.startsWith('--'))) return;
  if (cmd === 'handoff' && a.checkpoint) return;
  try {
    const line = reviewCandidate();
    if (line) console.log(line);
  } catch (e) {
    console.error(`gtg: review skipped - ${firstMeaningfulLine(e)}`); // never fails the command it rides on
  }
}

function keep(argv) {
  const t = argv.find((x) => !x.startsWith('--'));
  if (!t) { console.error('Usage: gtg keep <slug> [--wake YYYY-MM-DD]'); process.exit(2); }
  const wake = wakeFlag(parseFlags(argv).wake);
  let which = 'active';
  let arr = entries('active');
  let match = resolveEntry(arr, t, displayOrder);
  if (!match) {
    which = 'backlog';
    arr = entries('backlog');
    match = resolveEntry(arr, t.replace(/^[bB](?=\d+$)/, ''));
  }
  if (!match) { console.error(`No project matching '${t}'. Try 'gtg list' or 'gtg backlog'.`); process.exit(2); }
  if (which === 'active' && wake) {
    console.error(`gtg: --wake is for shelved work. Shelve it with: gtg back ${match.slug} --wake ${wake}`);
    process.exit(2);
  }
  match.reviewed = nowIso(); // not `updated`: nobody worked on it, and list's "Nd ago" stays true
  if (which === 'backlog') { if (wake) match.wake = wake; else delete match.wake; }
  commit(saveEntries(which, arr), `gtg keep: ${match.project}`);
  const quiet = wake ? `until ${wake}` : `for ${which === 'active' ? REVIEW_ACTIVE_DAYS : REVIEW_BACKLOG_DAYS} days`;
  console.log(`Kept: ${match.project}. Not asked about again ${quiet}.`);
}

// --- back / active / remove / undo --------------------------------------------
function back(argv) {
  const t = argv[0];
  if (!t) { console.error("Usage: gtg back <number|slug> [--wake YYYY-MM-DD]  (see 'gtg list')"); process.exit(2); }
  const wake = wakeFlag(parseFlags(argv.slice(1)).wake);
  const act = entries('active');
  const match = resolveEntry(act, t, displayOrder);
  if (!match) { console.error(`No active project matching '${t}'. Try 'gtg list'.`); process.exit(2); }
  match.updated = nowIso(); // restamp = parked-at
  delete match.reviewed;
  if (wake) match.wake = wake; else delete match.wake;
  const bl = entries('backlog').filter((e) => e.slug !== match.slug);
  bl.push(match);
  const paths = [...saveEntries('active', act.filter((e) => e !== match)),
                 ...saveEntries('backlog', bl)];
  commit(paths, `gtg backlog: park ${match.project}`);
  // `|| match.slug` for the same reason printEntry substitutes a slug label: an extension entry
  // has no position in the listing these numbers index, so indexOf is -1 and the hint would read
  // 'gtg active 0', which resolveEntry turns into arr[-1] and exits 2. Print what actually works.
  const hint = sortByProject(bl).indexOf(match) + 1 || match.slug;
  console.log(`Parked: ${match.project} -> backlog${wake ? ` until ${wake}` : ''}. Bring back: gtg active ${hint}`);
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
  delete match.wake; // picked up, so the date it was waiting for no longer applies
  delete match.reviewed;
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
// Legacy dated handoff files keep the old slug deliberately. A canonical current file moves
// with its live entry so reusing the old slug cannot make two lines point at one writable body.
function rename(argv) {
  // Positionals come before any flag, so --name's value can hold spaces without being read as one.
  const cut = argv.findIndex((x) => x.startsWith('--'));
  const [from, to] = cut === -1 ? argv : argv.slice(0, cut);
  const flags = parseFlags(argv);
  if (!from || !to) { console.error('Usage: gtg rename <number|slug> <new-slug> [--name "<Display Name>"]'); process.exit(2); }
  // `--name` with nothing after it parses as true. Renaming a project to the string "true" is
  // never what was meant, and an empty name would leave the entry unlistable.
  if (flags.name !== undefined && typeof flags.name !== 'string') {
    console.error('gtg rename: --name needs a display name'); process.exit(2);
  }
  // Same constraint --slug is held to, and for the same reason: a slug becomes a path segment.
  if (!SLUG_OK.test(to)) {
    console.error('gtg rename: <new-slug> must start with a letter or digit and match [A-Za-z0-9_-]'); process.exit(2);
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
  // A name-only rename passes the slug it already has. That is the common case once entries
  // outlive the session that named them: the slug is still right and the title is not.
  const sameSlug = old === to;
  if (sameSlug && !flags.name) { console.error(`gtg rename: '${to}' is already its slug`); process.exit(2); }
  if ([...act, ...bl].some((e) => e !== match && e.slug.toLowerCase() === to.toLowerCase())) {
    console.error(`gtg rename: '${to}' is already used by another project`); process.exit(2);
  }
  // Progress is a separate durable record keyed by the same stable slug. Silently moving only
  // the handoff would orphan its tasks, while moving both needs its own revision-aware contract.
  // Fail closed before any file/store mutation until that operation exists.
  let progressCollision;
  try { progressCollision = progressSlugOnDisk(old) ?? progressSlugOnDisk(to); }
  catch (e) {
    console.error(`gtg rename: cannot inspect progress records - ${firstMeaningfulLine(e)}`);
    process.exit(2);
  }
  if (progressCollision) {
    console.error(`gtg rename: progress '${progressCollision}' is bound to this identity; cannot rename this line of work`);
    process.exit(2);
  }
  const oldCurrent = canonicalHandoffPath(old);
  const newCurrent = canonicalHandoffPath(to);
  const handoffPaths = [];
  if (!sameSlug && sameHandoffPath(match.file, oldCurrent) && existsSync(join(ROOT, oldCurrent))) {
    if (existsSync(join(ROOT, newCurrent))
      || [...act, ...bl].some((e) => e !== match && sameHandoffPath(e.file, newCurrent))) {
      console.error(`gtg rename: handoff path '${newCurrent}' is already in use`);
      process.exit(2);
    }
    mkdirSync(dirname(join(ROOT, newCurrent)), { recursive: true });
    renameSync(join(ROOT, oldCurrent), join(ROOT, newCurrent));
    match.file = newCurrent;
    handoffPaths.push(oldCurrent, newCurrent);
  }
  match.slug = to;
  // The display name moves only when asked. It cannot be derived from the slug: a slug is
  // lowercase and hyphenated, and inferring "Runbook Memory Router" from one would overwrite
  // whatever capitalisation and wording the project actually chose.
  const oldName = match.project;
  if (flags.name && flags.name !== oldName) {
    // `log <slug>` greps commit SUBJECTS for the project name, and every subject written before
    // now carries the old one. Dropping it would blind the filtered log to the project's whole
    // history at the moment its name stops describing it, which is exactly when it gets renamed.
    match.aka = [...new Set([...(match.aka ?? []), oldName])];
    match.project = flags.name;
  }
  let kids = 0;
  for (const e of [...act, ...bl]) if (e.parent === old) { e.parent = to; kids++; }
  // Both stores every time. The entry sits on one shelf but a child can sit on the other.
  // The renamed entry's file MOVES (old.json -> to.json), so `deleted` carries the old name
  // and the commit has to name it or the removal is left staged for another session.
  const paths = [...saveEntries('active', act), ...saveEntries('backlog', bl)];
  commit([...paths, ...handoffPaths],
    sameSlug ? `gtg rename: ${oldName} to ${match.project}` : `gtg rename: ${old} to ${to}`);
  const named = match.project === oldName ? match.project : `${oldName} -> ${match.project}`;
  console.log(`Renamed: ${named} (${sameSlug ? to : `${old} -> ${to}`})${
    kids ? `, re-pointed ${kids} sub-project(s)` : ''}`);
  // Only a slug has a portfolio half. A title that moved on its own leaves nothing to match.
  if (!sameSlug) console.log(`The portfolio slug is separate. Match it with: projects rename ${old} ${to}`);
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
  // restamping would falsely report bookkeeping as project activity.
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
    // Every name it has been called, because several --grep terms OR together and the subjects
    // under a former name are the same project's history.
    filter.push('--fixed-strings');
    for (const n of [match.project, ...(match.aka ?? [])]) filter.push('--grep', n);
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

function remove(argv, { completed = false } = {}) {
  const t = argv[0];
  if (!t) { console.error(`Usage: gtg ${completed ? 'complete' : 'remove'} <number|slug>  (see 'gtg list')`); process.exit(2); }
  const act = entries('active');
  const match = resolveEntry(act, t, displayOrder);
  if (match) {
    commit(saveEntries('active', act.filter((e) => e !== match)),
      `gtg prune: remove ${match.project} - confirmed done`);
    console.log(`${completed ? 'Completed' : 'Removed'}: ${match.project}`);
    return;
  }
  // not in active - try the backlog (lets resume-consume clear a pulled backlog item)
  const bl = entries('backlog');
  const blMatch = resolveEntry(bl, t.replace(/^[bB](?=\d+$)/, ''));
  if (blMatch) {
    commit(saveEntries('backlog', bl.filter((e) => e !== blMatch)),
      `gtg prune: remove ${blMatch.project} from backlog - confirmed done`);
    console.log(`${completed ? 'Completed' : 'Removed'} from backlog: ${blMatch.project}`);
    return;
  }
  console.error(`No project matching '${t}'. Try 'gtg list' or 'gtg backlog'.`);
  process.exit(2);
}
const complete = (argv) => remove(argv, { completed: true });

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

// Resume resolves the name, prints the current handoff and runs the after-resume
// hook without mutating the store. Before 3.0.0 the skill read both store files (25KB on a
// busy hub), then the handoff, then called consume, then probed for a markdown hook: five
// turns and the entire store in context to pick one entry out of it.
//
// Exit codes: 0 resumed, 1 a choice is needed (candidates printed on stdout), 2 nothing to
// resume.
function commandFileFor(t) {
  if (!/^[A-Za-z0-9_-]+$/.test(t)) return false;
  return existsSync(join(ROOT, '.gtg', 'commands', `${t}.mjs`))
    || existsSync(join(CLI_DIR, 'extensions', 'commands', `${t}.mjs`));
}

// Fast-forward the hub from whatever it tracks before anything reads the store. POSITION IS THE WHOLE
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
// WHERE to sync from is resolved per branch, not named (2026-09-01 fix round). The first cut
// hardcoded obelisk-backup/master, which made the feature one-directional: Obelisk's clone calls
// the same repo `origin` and may sit on `main`, so its every resume fetched nothing and said
// nothing - half of the two-machine handoff this plan exists for was simply not implemented.
//
// branch.<b>.remote + branch.<b>.merge rather than `rev-parse @{u}`: @{u} answers with
// "<remote>/<branch>" as ONE string, and either half may itself contain a slash, so splitting it
// guesses. The config keys hold the two halves already separated.
//
// No upstream falls back to the named pair, which is home's own situation today (nothing there
// sets branch.*.remote) - and only on the branch that mirror carries. A feature branch with no
// upstream must never be moved, gtg runs from feature worktrees, and a detached HEAD (mid-rebase,
// mid-bisect) reports 'HEAD' and skips. Where an upstream DOES exist it is always the right
// target, so the lookup carries the guard the branch comparison used to.
// SYNC_REMOTE / SYNC_BRANCH are declared up beside the migration block, which calls syncHub()
// at import time and would otherwise hit them in their temporal dead zone.
function syncTarget(git) {
  let branch;
  try { branch = git('rev-parse', '--abbrev-ref', 'HEAD'); } catch { return null; }
  if (!branch || branch === 'HEAD') return null;
  try {
    const remote = git('config', '--get', `branch.${branch}.remote`);
    const merge = git('config', '--get', `branch.${branch}.merge`);
    // Anchored: branch.<b>.merge is a full ref, so the prefix is only ever at the START. Unanchored,
    // a branch legitimately named `x/refs/heads/y` gets mangled into `x/y`.
    if (remote && merge) return { remote, branch: merge.replace(/^refs\/heads\//, '') };
  } catch { /* --get exits 1 when unset: no upstream, try the fallback below */ }
  return branch === SYNC_BRANCH ? { remote: SYNC_REMOTE, branch: SYNC_BRANCH } : null;
}
function syncHub() {
  if (synced) return; // once per process - see `synced` up by the migration block
  synced = true;
  if (process.env.GTG_NO_SYNC) return; // isolated tests and explicit offline callers
  // stderr piped, not inherited: execFileSync forwards a child's stderr to ours otherwise,
  // and git narrates a refused fast-forward in nine hint: lines - five of git's own above every
  // line of ours. The after-resume hook piped it for the same reason before this moved here.
  const git = (...args) => execFileSync('git', args,
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).toString().trim();
  const target = syncTarget(git);
  if (!target) return; // detached, or a branch with neither an upstream nor the fallback's name
  const name = `${target.remote}/${target.branch}`;
  let before;
  try {
    before = git('rev-parse', 'HEAD');
    git('fetch', '--quiet', target.remote, target.branch);
  } catch { return; } // no remote, host down, offline, not a repo: local state stands, silently
  try {
    // FETCH_HEAD, not <remote>/<branch>: the fetch above just set it to exactly what came down,
    // so nothing here rests on the remote's refspec having updated a tracking ref - and a
    // branch.<b>.remote holding a URL rather than a name has no tracking ref at all.
    git('merge', '--ff-only', '--quiet', 'FETCH_HEAD');
  } catch {
    // The fetch landed and the fast-forward was refused. Home being AHEAD of the mirror is the
    // normal state and says nothing. The mirror holding commits home does not have means a
    // genuine fork or a dirty tree in the way, and resolving either is Nathan's call, not a
    // resume's - auto-merging a divergence is what caused the 2026-08-02 fork. On stderr, so
    // "stdout speaks only on a real fast-forward" still holds.
    try { git('merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'); } catch {
      console.error(`gtg: ${name} will not fast-forward (diverged, or local changes in the way) - resuming from local state`);
    }
    return;
  }
  try {
    const after = git('rev-parse', 'HEAD');
    if (after !== before) console.log(`Synced ${name}: fast-forwarded to ${after.slice(0, 7)}`);
  } catch { /* the merge already succeeded; failing to name it is not worth a word */ }
}

async function resumeConsume(argv) {
  const a = parseFlags(argv);
  const t = argv.find((x) => !x.startsWith('--'));
  // Before the two reads below, deliberately. See syncHub: after them it is decoration.
  // Not on the forge store, which is already the one shared copy.
  if (!FORGE) syncHub();
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
  reviewSkip = match.slug;
  const file = match.file ? join(ROOT, match.file) : null;
  const body = FORGE ? await FORGE.latestHandoff(match)
    : file && existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
  const progress = readProgress(ROOT, match.slug, { optional: true });
  const when = typeof match.updated === 'string' ? match.updated.slice(0, 16).replace('T', ' ') : '?';
  const where = FORGE ? `tracking issue #${FORGE.issueOf(match)}` : match.file;
  console.log(`RESUME: "${match.project}" - handoff of ${when}${where ? ` (${where})` : ''}`);
  if (progress) {
    console.log(`CURRENT PROGRESS (supersedes handoff snapshot)\n${renderProgress(progress)}`);
  }
  console.log(body ?? `(no handoff ${FORGE ? 'comment on' : 'file at'} ${where ?? 'none'}; the entry's next action is all there is: ${match.next})`);
  if (FORGE) {
    const tasks = await FORGE.openTasks(match);
    if (tasks.length) console.log(`Open issues in this milestone:\n${tasks.join('\n')}`);
  }
  console.log(fromBacklog
    ? `Kept on backlog: ${match.project} (current handoff retained)`
    : `Kept: ${match.project} (current handoff retained)`);
  // After-resume hook: <root>/.gtg/after-resume.mjs, the resume-side twin of after-handoff.
  // Replaces the markdown on-resume.md the model used to probe for and read.
  const hook = join(ROOT, '.gtg', 'after-resume.mjs');
  if (existsSync(hook)) {
    try {
      const mod = await import(pathToFileURL(hook).href);
      if (typeof mod.default !== 'function') throw new Error('no default export function');
      // `kept` is now always true because resume never consumes. `resumed`
      // preserves the old distinction hooks need: normal pickup versus an
      // explicit --keep read that should not run pickup side effects.
      await mod.default({ root: ROOT, entry: match, file: match.file ?? null, body: body ?? '', kept: true, resumed: !a.keep, readStore, writeStore, commit });
    } catch (e) {
      console.error(`gtg: after-resume hook failed - ${firstMeaningfulLine(e)}`);
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
// backlog ONLY (`gtg backlog --project ...` parking a new idea, and explicit
// completion of backlog work), so an active-only anchor skipped right past those,
// landed on an unrelated older active-list commit, reverted THAT instead, and
// silently deleted the backlog. STORE_PATHSPEC is what keeps that fixed now: it
// names both sharded directories, so a backlog-only commit is still the anchor,
// and it keeps the deleted packed files too so undoing a pre-shard commit works.
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

  // Rewind every store or handoff-body path the anchor commit touched to its state at
  // `${last}^`. Persistent handoffs overwrite one current body, so restoring only
  // the record would pair a session-1 entry with session-2 prose. The packed store
  // made this two whole files; a sharded store is many, so the unit is now "the paths this
  // commit changed" and git names them for us. STORE_PATHSPEC covers the packed files too, so
  // an undo of a pre-shard commit still works exactly as it used to. `--root` keeps the
  // very-first-commit case working (no parent to diff against).
  //
  // A path absent at `last^` was CREATED by this commit, so undoing it means removing it -
  // the same rule the packed version followed, and the reason a deletion has to be in the
  // commit path list below rather than left in the working tree.
  const isStorePath = (rel) => STORE_PATHSPEC.some((path) => rel === path || rel.startsWith(path + '/'));
  let changed = [];
  try {
    changed = execFileSync('git', ['diff-tree', '-r', '--root', '--no-commit-id', '--name-only',
      last, '--', 'docs/handoffs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split('\n').map((s) => s.trim())
      .filter((rel) => rel && (isStorePath(rel) || isHandoffDocPath(rel)));
  } catch { /* the empty check below reports it */ }

  // Refuse before restoring any store path if a handoff body has uncommitted edits.
  // The anchor proves ownership of its own committed body change, not of a later
  // body-only commit or later working-tree prose.
  for (const rel of changed.filter(isHandoffDocPath)) {
    try {
      const bodyTip = execFileSync('git', ['log', '-1', '--format=%H', '--', rel],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (bodyTip !== last) {
        console.error(`gtg undo: handoff body changed after the store commit: ${rel}`);
        process.exit(2);
      }
      const dirty = execFileSync('git', ['status', '--porcelain', '--', rel],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (dirty) {
        console.error(`gtg undo: handoff body has uncommitted changes: ${rel}`);
        process.exit(2);
      }
    } catch (e) {
      console.error(`gtg undo: cannot verify handoff body before restore - ${firstMeaningfulLine(e)}`);
      process.exit(2);
    }
  }

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
  // Report what came back without a second full render.
  const names = entries('active').map((e) => e.project);
  console.log(`Undone: ${subject}`);
  console.log(`Active entries now (${names.length}): ${names.join(', ') || '(none)'}`);
}

// After a move (back/active/remove/resume/undo) a HUMAN wants the updated list;
// an AI does not - gtg runs piped when a tool invokes it (stdout not a TTY), so
// TTY-gating suppresses the render for models with zero wasted context, no flag
// needed. --list / --no-list force it either way. renderList (not list) so undo's
// without another command dispatch.
function maybeAutoList(argv) {
  const a = parseFlags(argv);
  if (a['no-list']) return;
  if (a.list || process.stdout.isTTY) renderList([]);
}
const MOVE_CMDS = new Set(['back', 'active', 'complete', 'remove', 'rm', 'prune', 'resume', 'undo', 'rename', 'supersede', 'keep']);

// --- dispatch -----------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
const builtins = {
  handoff, backlog, list, help, '--help': help, '-h': help,
  back, active: activate, complete, remove, rm: remove, prune: remove, resume: resumeConsume, undo,
  rename, unparent, log, supersede, keep,
};
// Forge store: load before the command, flush after it. Commands that never read the records skip
// the network. The refused ones read git history of the file store, which the forge store does
// not write, so on a forge they would report an empty history as if it were the truth.
const NO_STORE = new Set(['help', '--help', '-h', 'progress']);
const FORGE_REFUSED = new Set(['log', 'undo', 'stats', 'report']);
if (!NO_STORE.has(cmd)) {
  let cfg;
  try { cfg = forgeConfig(ROOT); } catch (e) { console.error(`gtg: ${e.message}`); process.exit(2); }
  if (cfg && FORGE_REFUSED.has(cmd)) {
    console.error(`gtg ${cmd}: not available on the forge store. The history is the milestone and issue timeline on ${cfg.repo}.`);
    process.exit(2);
  }
  if (cfg) {
    try { FORGE = await openForge(cfg); } catch (e) {
      console.error(`gtg: cannot read the forge store - ${firstMeaningfulLine(e)}`);
      process.exit(1);
    }
  }
}
const flushForge = async () => {
  if (!FORGE) return;
  try { await FORGE.flush(cmd); } catch (e) {
    console.error(`gtg: forge write failed partway, re-run the command - ${firstMeaningfulLine(e)}`);
    process.exitCode = 1; // not process.exit, see writeHandoff's forge branch
  }
};
if (!cmd) { list([]); printReview('list', []); }
// hasOwn, not truthiness: every inherited Object key resolved here, so `gtg constructor` and
// `gtg toString` called something that is not a verb instead of falling through to the
// extension lookup and then the unknown-command error.
else if (Object.hasOwn(builtins, cmd)) {
  await builtins[cmd](rest);
  await flushForge();
  if (MOVE_CMDS.has(cmd)) maybeAutoList(rest);
  if (REVIEW_CMDS.has(cmd)) printReview(cmd, rest);
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
      // Through `entries`, NOT `readStore`: readStore is a whole-file JSON reader, kept at its
      // packed shape for the published extension context, so reading records through it here
      // would name a file that no longer exists and serve issues.mjs and learn.mjs a silent
      // empty list - every live entry reported as missing, at exit 0.
      const ownEntries = () => {
        const grab = (which) => (ownParent ? entries(which).filter((e) => e.parent === ownParent) : []);
        return { active: grab('active'), shelved: grab('backlog') };
      };
      // ownParent rides the ctx as well as being closed over by ownEntries: an extension that
      // WRITES an entry needs the same namespace its reader filters on, and deriving it a
      // second time on the writer side is exactly the drift class this closes.
      await mod.default({
        root: ROOT, args: rest, readStore, writeStore, commit, countHandoffFiles,
        ownEntries, ownParent, sessionId: PROGRESS_SESSION_ID || undefined,
      });
      await flushForge();
    } catch (e) {
      console.error(`gtg: extension '${cmd}' failed: ${(e?.message || String(e)).split('\n')[0]}`);
      process.exit(1);
    }
  } else {
    console.error(`gtg: unknown command '${cmd}' - try 'gtg help'`);
    process.exit(2);
  }
}
