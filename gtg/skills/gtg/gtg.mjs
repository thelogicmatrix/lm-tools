#!/usr/bin/env node
// gtg — zero-model bookkeeping CLI for the gtg pause/resume skill.
// Storage root: GTG_HUB env var if set, else the current git repo's root.
// Unknown subcommands dispatch to <root>/.gtg/commands/<name>.mjs (see README).
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

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
const REL_ACTIVE = 'docs/handoffs/_active.json';
const REL_BACKLOG = 'docs/handoffs/_backlog.json';
// Directory of this CLI file — bundled extensions ship alongside it under extensions/.
const CLI_DIR = dirname(fileURLToPath(import.meta.url));

// --- color (TTY-gated, NO_COLOR-aware; raw ANSI, no dependency) ---------------
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));

// --- helpers (readStore/writeStore/commit are also the extension ctx) --------
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
  const opts = { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    execFileSync('git', ['add', ...paths], opts);
    // Name the paths on the COMMIT too, not just the add. A pathspec-less `git commit`
    // takes the WHOLE index, so anything a concurrent session staged between our add and
    // our commit rides along in ours — on 2026-07-27 a `gtg resume` swallowed an unrelated
    // spec file that another session had just staged. `--` keeps a path that starts with
    // a dash from being read as a flag.
    execFileSync('git', ['commit', '-q', '-m', message, '--', ...paths], opts);
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    if (/nothing to commit|no changes added/i.test(out)) return; // identical content — files already on disk
    // Don't let a real git failure masquerade as success: the files are written, but say so.
    console.error(`gtg: git commit failed, changes are on disk but uncommitted — ${(e.stderr || e.message || '').toString().trim().split('\n')[0]}`);
  }
}
function entries(rel, key) {
  const d = readStore(rel);
  return Array.isArray(d?.[key]) ? d[key].filter(Boolean) : [];
}
function saveEntries(rel, key, items) { writeStore(rel, { [key]: items }); }
// Local UTC-offset suffix e.g. "+08:00" for the given Date — shared by nowIso()
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
function sortByProject(arr) { return [...arr].sort((a, b) => a.project.localeCompare(b.project)); }
// The exact top-to-bottom order `list` renders active entries in: each family
// (parent) alphabetical, its members alphabetical within, then standalone. ONE
// canonical order so a number on screen, `gtg back <n>`, and the "gtg back <hint>"
// hints all mean the same row. (Backlog has no families — it stays sortByProject.)
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

// Handoff docs are named YYYY-MM-DD-HHMM-<slug>.md. They ARE the session record —
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

// Family grouping. The parent already exists as a docs/projects/ page — the
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
// one shared hub file — this handoff reads only ITS OWN session's start.
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

// --- handoff / backlog park ---------------------------------------------------
function writeHandoff(argv, { storeRel, key, verb }) {
  const a = parseFlags(argv);
  const missing = ['project', 'slug', 'next'].filter((k) => !a[k]);
  if (missing.length) { console.error(`gtg ${verb}: missing --${missing.join(', --')}`); process.exit(2); }
  // slug becomes a filename and a git-add arg — constrain it so it can't traverse paths or inject shell.
  if (!/^[A-Za-z0-9_-]+$/.test(a.slug)) { console.error(`gtg ${verb}: --slug must match [A-Za-z0-9_-]`); process.exit(2); }
  const body = readFileSync(0, 'utf8').trim(); // stdin
  if (!body) { console.error(`gtg ${verb}: empty body on stdin`); process.exit(2); }
  // ROOT is the storage hub, NOT the project. A project in its own worktree has
  // its own branch — detect there, or the hub's branch gets recorded for everyone.
  const worktree = a.worktree || 'repo root';
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
  const doc = `# Handoff: ${a.project}
Date: ${stamp.slice(0, 10)} ${p(d.getHours())}:${p(d.getMinutes())}
Worktree: ${worktree}
Branch: ${branch}

${body}

## Resume Prompt
Say: "let's continue ${a.project}"
`;
  const prior = [...entries(REL_ACTIVE, 'handoffs'), ...entries(REL_BACKLOG, 'backlog')]
    .find((e) => e.slug === a.slug);
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
    // sub-project -> atlas) — carry it forward when the flag is
    // omitted instead of silently dropping the project out of its family.
    parent: inferParent(a.slug, a.parent) ?? prior?.parent,
    duration_min: sessionDurationMin(),
    eta: a.eta || prior?.eta,
    next: String(a.next).slice(0, 150), file: relFile, updated: nowIso(),
  };
  if (a['dry-run']) {
    console.log(`--- DRY RUN: would write ${relFile} ---\n${doc}`);
    console.log(`--- ${storeRel} entry ---\n${JSON.stringify(entry, null, 2)}`);
    return;
  }
  mkdirSync(join(ROOT, 'docs/handoffs'), { recursive: true });
  writeFileSync(join(ROOT, relFile), doc);
  const items = entries(storeRel, key).filter((e) => e.slug !== a.slug); // dedupe by slug
  items.push(entry);
  saveEntries(storeRel, key, items);
  // 'backlog' here means "park a NEW idea" (writeHandoff's other caller) — distinct
  // from `back` (below), which SHELVES an already-active entry and keeps its own
  // 'gtg backlog: park <project>' subject unchanged; historical commits use that
  // one and must stay parsable.
  const subject = verb === 'backlog'
    ? `gtg backlog: new ${a.project} — session ${sessions}`
    : `${verb}: ${a.project} — session ${sessions}`;
  commit([relFile, storeRel], subject);
  console.log(relFile);
  console.log(verb === 'backlog'
    ? `PARKED on backlog: "${a.project}" — reactivate with 'gtg active <n>' or "let's continue ${a.project}"`
    : `RESUME: "let's continue ${a.project}"`);
}
const handoff = (argv) => writeHandoff(argv, { storeRel: REL_ACTIVE, key: 'handoffs', verb: 'handoff' });

// backlog: with --project it parks a new entry; bare it lists the shelf (Task 3)
function backlog(argv) {
  if (parseFlags(argv).project) return writeHandoff(argv, { storeRel: REL_BACKLOG, key: 'backlog', verb: 'backlog' });
  return backlogList();
}
// Active entries idle >7d silently move to the backlog when `list` runs.
// 'updated' is refreshed on every handoff/back/active, so only genuinely idle entries qualify.
function autoShelf() {
  const act = entries(REL_ACTIVE, 'handoffs');
  const cutoff = Date.now() - 7 * 86400000;
  const stale = act.filter((e) => e.updated && Date.parse(e.updated) <= cutoff);
  if (!stale.length) return;
  const fresh = act.filter((e) => !stale.includes(e));
  let bl = entries(REL_BACKLOG, 'backlog');
  for (const s of stale) {
    s.updated = nowIso(); // restamp = shelf date
    bl = bl.filter((e) => e.slug !== s.slug);
    bl.push(s);
  }
  saveEntries(REL_ACTIVE, 'handoffs', fresh);
  saveEntries(REL_BACKLOG, 'backlog', bl);
  commit([REL_ACTIVE, REL_BACKLOG], `gtg backlog: auto-park ${stale.length} stale (>7d): ${stale.map((s) => s.project).join(', ')}`);
  console.log(`Auto-shelved ${stale.length} project(s) idle >7d to backlog: ${stale.map((s) => s.project).join(', ')}`);
}

// Live uncommitted-file count for a worktree. A SessionEnd hook that recorded
// this was retired 2026-07-11 for MISSING dirty worktrees — it only fired on
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
// Where an entry's checkout actually lives — the hub itself for 'repo root'/legacy
// (undefined) entries, else the recorded worktree path. One definition, two call
// sites (dirty-count grouping and per-entry rendering) — they must stay identical.
function resolveDir(e) { return (!e.worktree || e.worktree === 'repo root') ? ROOT : e.worktree; }

// `list` = the 7-day shelf sweep THEN render. Split out so a move command can
// re-render (maybeAutoList) without re-running autoShelf — which would re-park a
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
  const allAct = displayOrder(entries(REL_ACTIVE, 'handoffs'));
  const blCount = entries(REL_BACKLOG, 'backlog').length;
  const shown = filter
    ? allAct.filter((e) => e.slug === filter || e.project.toLowerCase().includes(filter.toLowerCase()))
    : allAct;
  if (!shown.length) {
    console.log(`No active gtg projects${filter ? ` matching '${filter}'` : ''}.` +
      (blCount ? ` (+${blCount} backlogged — gtg backlog)` : ''));
    return;
  }

  const families = [...new Set(shown.map((e) => e.parent).filter(Boolean))].sort();
  console.log(`${shown.length} active gtg project${shown.length === 1 ? '' : 's'}` +
    `${families.length ? ` in ${families.length + (shown.some((e) => !e.parent) ? 1 : 0)} group(s)` : ''}` +
    `${filter ? ` matching '${filter}'` : ''}:`);

  // Only entries with an explicit worktree of their own get a dirty flag — a
  // 'repo root'/legacy-undefined entry resolves to the storage hub itself, which
  // in real use carries 150+ uncommitted files unrelated to any one project;
  // attributing that count to the entry would falsely implicate it.
  const hasOwnWorktree = (e) => !!e.worktree && e.worktree !== 'repo root';

  // One git call per distinct worktree, not per project — several projects
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
    const d = hasOwnWorktree(e) ? dirty.get(resolveDir(e)) : undefined;
    // null = worktree unreachable / dirtyCount failed — render the '?' the spec
    // promises, distinct from a genuinely clean (0) worktree, which renders nothing.
    const dirtyTag = d === null ? c('33', ' ● ? uncommitted') : d ? c('33', ` ● ${d} uncommitted`) : '';
    const loc = e.branch && e.branch !== '?' ? c('2', ` ${e.branch}`) : '';
    const idle = (Date.now() - Date.parse(e.updated)) / 86400000;
    const shelf = idle > 6 ? c('31', ` ⚠ shelves in ${Math.max(0, Math.round((7 - idle) * 24))}h`) : '';
    const sessions = e.sessions ?? countHandoffFiles(e.slug); // legacy entries predate the field
    console.log(`  ${c('1', n + '.')} ${c('1;36', e.project)} ${c('2', 's' + sessions)} [${c('32', e.eta || '?')}] ${c('2', '(' + ago(e.updated) + ')')}${loc}${dirtyTag}${shelf}`);
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
  // otherwise all collapse onto one '? @ repo root' key and falsely "collide" —
  // skip them, only entries with a real recorded location are compared.
  const byLocation = new Map();
  const BASE_BRANCHES = new Set(['master', 'main']);
  for (const e of shown) {
    if (!e.worktree) continue;
    // master/main @ repo root is the SANCTIONED shared home for docs/meta work
    // (home-repo doctrine — meta paths commit straight to master), not a tangle.
    // Only a real feature-branch collision (or a shared non-root worktree) warns.
    if (e.worktree === 'repo root' && BASE_BRANCHES.has(e.branch)) continue;
    const key = `${e.branch || '?'} @ ${e.worktree}`;
    byLocation.set(key, [...(byLocation.get(key) || []), e.project]);
  }
  for (const [key, names] of byLocation) {
    if (names.length > 1) console.log(`\n${c('33', `⚠ ${names.length} projects share ${key} — ${names.join(', ')}`)}`);
  }

  if (blCount) console.log(`\n+ ${blCount} backlogged - gtg backlog`);
}

function backlogList() {
  const bl = entries(REL_BACKLOG, 'backlog');
  if (!bl.length) {
    console.log("Backlog is empty. Shelf an active entry with 'gtg back <n>', or park an idea with 'gtg backlog --project ...'.");
    return;
  }
  console.log(`${bl.length} backlogged project${bl.length === 1 ? '' : 's'}:`);
  sortByProject(bl).forEach((e, i) => {
    console.log(`${c('33', 'b' + (i + 1) + '.')} ${c('1;36', e.project)} ${c('2', 's' + (e.sessions ?? countHandoffFiles(e.slug)))} [${c('32', e.eta || '?')}] ${c('2', '(parked ' + ago(e.updated) + ')')}`);
    console.log(`    next: ${e.next}`);
  });
  console.log('Activate: gtg active <n>');
}

function help() {
  console.log(`gtg — pause/resume + backlog bookkeeping
  gtg handoff --project --slug --next [--eta] [--parent] [--worktree] [--branch] [--dry-run]   (body on stdin)
  gtg backlog [same flags]     park on the backlog shelf (body on stdin); bare = list the shelf
  gtg list [project]           active handoffs (+ 7-day auto-shelf sweep); optional filter
  gtg back <n|slug>            shelf an active entry to the backlog
  gtg active <n|slug>          reactivate a backlog entry
  gtg remove <n|slug>          drop an entry (active first, then backlog)
  gtg resume <n|slug>          consume an entry on pick-up (NOT a ship)
  gtg rename <n|slug> <new>    change a slug, re-pointing any sub-projects. With a slug nothing
                               here carries, it repairs a stale parent reference instead
  gtg log [n|slug] [-n N]      what happened, read from git rather than a ledger
  gtg undo                     revert the last change to the active list
  gtg stats                    one-screen scoreboard: streak, ships, sessions, effort
  gtg report                   full report JSON -> docs/handoffs/_report.json
After a move (back/active/remove/resume/undo) the updated list auto-prints when
stdout is a terminal; it stays silent when piped (so an AI wastes no context).
Force either way with --list / --no-list.
Storage root: GTG_HUB env var if set, else the enclosing git repo.
stats/report ship bundled; unknown commands dispatch to <root>/.gtg/commands/<name>.mjs,
which overrides a bundled one of the same name — see README "Extending gtg".`);
}

// --- back / active / remove / undo --------------------------------------------
function back(argv) {
  const t = argv[0];
  if (!t) { console.error("Usage: gtg back <number|slug>  (see 'gtg list')"); process.exit(2); }
  const act = entries(REL_ACTIVE, 'handoffs');
  const match = resolveEntry(act, t, displayOrder);
  if (!match) { console.error(`No active project matching '${t}'. Try 'gtg list'.`); process.exit(2); }
  match.updated = nowIso(); // restamp = parked-at
  const bl = entries(REL_BACKLOG, 'backlog').filter((e) => e.slug !== match.slug);
  bl.push(match);
  saveEntries(REL_ACTIVE, 'handoffs', act.filter((e) => e !== match));
  saveEntries(REL_BACKLOG, 'backlog', bl);
  commit([REL_ACTIVE, REL_BACKLOG], `gtg backlog: park ${match.project}`);
  const hint = sortByProject(bl).indexOf(match) + 1;
  console.log(`Parked: ${match.project} -> backlog. Bring back: gtg active ${hint}`);
}

function activate(argv) {
  const t0 = argv[0];
  if (!t0) { console.error("Usage: gtg active <number|slug>  (see 'gtg backlog')"); process.exit(2); }
  const t = t0.replace(/^[bB](?=\d+$)/, ''); // accept the b<n> numbering `gtg backlog` shows
  const bl = entries(REL_BACKLOG, 'backlog');
  if (!bl.length) { console.error('Backlog is empty - nothing to activate.'); process.exit(2); }
  const match = resolveEntry(bl, t);
  if (!match) { console.error(`No backlog project matching '${t0}'. Try 'gtg backlog'.`); process.exit(2); }
  match.updated = nowIso();
  const act = entries(REL_ACTIVE, 'handoffs').filter((e) => e.slug !== match.slug);
  act.push(match);
  saveEntries(REL_BACKLOG, 'backlog', bl.filter((e) => e !== match));
  saveEntries(REL_ACTIVE, 'handoffs', act);
  commit([REL_ACTIVE, REL_BACKLOG], `gtg activate: ${match.project}`);
  const hint = displayOrder(act).indexOf(match) + 1; // active list is display-ordered
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
  const act = entries(REL_ACTIVE, 'handoffs');
  const bl = entries(REL_BACKLOG, 'backlog');
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
    saveEntries(REL_ACTIVE, 'handoffs', act);
    saveEntries(REL_BACKLOG, 'backlog', bl);
    commit([REL_ACTIVE, REL_BACKLOG], `gtg rename: parent ${from} to ${to}`);
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
  saveEntries(REL_ACTIVE, 'handoffs', act);
  saveEntries(REL_BACKLOG, 'backlog', bl);
  commit([REL_ACTIVE, REL_BACKLOG], `gtg rename: ${old} to ${to}`);
  console.log(`Renamed: ${match.project} (${old} -> ${to})${
    kids ? `, re-pointed ${kids} sub-project(s)` : ''}`);
  console.log(`The portfolio slug is separate. Match it with: projects rename ${old} ${to}`);
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
    const match = resolveEntry(entries(REL_ACTIVE, 'handoffs'), t, displayOrder)
      ?? resolveEntry(entries(REL_BACKLOG, 'backlog'), t);
    if (!match) { console.error(`No project matching '${t}'. Try 'gtg list'.`); process.exit(2); }
    // --fixed-strings: a project name is free text and can hold regex metacharacters.
    filter.push('--fixed-strings', '--grep', match.project);
  }
  let out = '';
  try {
    out = execFileSync('git', ['log', `-n${n}`, '--date=short', '--format=%h %ad %s',
      ...filter, '--', REL_ACTIVE, REL_BACKLOG],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch {
    console.error('gtg log: no git history here'); process.exit(1);
  }
  process.stdout.write(out || 'gtg log: nothing recorded yet\n');
}

function remove(argv) {
  const t = argv[0];
  if (!t) { console.error("Usage: gtg remove <number|slug>  (see 'gtg list')"); process.exit(2); }
  const act = entries(REL_ACTIVE, 'handoffs');
  const match = resolveEntry(act, t, displayOrder);
  if (match) {
    saveEntries(REL_ACTIVE, 'handoffs', act.filter((e) => e !== match));
    commit([REL_ACTIVE], `gtg prune: remove ${match.project} - confirmed done`);
    console.log(`Removed: ${match.project}`);
    return;
  }
  // not in active — try the backlog (lets resume-consume clear a pulled backlog item)
  const bl = entries(REL_BACKLOG, 'backlog');
  const blMatch = resolveEntry(bl, t.replace(/^[bB](?=\d+$)/, ''));
  if (blMatch) {
    saveEntries(REL_BACKLOG, 'backlog', bl.filter((e) => e !== blMatch));
    commit([REL_BACKLOG], `gtg prune: remove ${blMatch.project} from backlog - confirmed done`);
    console.log(`Removed from backlog: ${blMatch.project}`);
    return;
  }
  console.error(`No project matching '${t}'. Try 'gtg list' or 'gtg backlog'.`);
  process.exit(2);
}

// resume-consume: same removal as prune, DIFFERENT commit subject. Keeping these
// distinct is what lets history tell "shipped" apart from "picked back up".
function resumeConsume(argv) {
  const t = argv[0];
  if (!t) { console.error("Usage: gtg resume <number|slug>  (see 'gtg list')"); process.exit(2); }
  const act = entries(REL_ACTIVE, 'handoffs');
  const match = resolveEntry(act, t, displayOrder);
  if (match) {
    saveEntries(REL_ACTIVE, 'handoffs', act.filter((e) => e !== match));
    commit([REL_ACTIVE], `gtg resume: ${match.project} — handoff consumed`);
    console.log(`Consumed: ${match.project}`);
    return;
  }
  const bl = entries(REL_BACKLOG, 'backlog');
  const blMatch = resolveEntry(bl, t.replace(/^[bB](?=\d+$)/, ''));
  if (blMatch) {
    saveEntries(REL_BACKLOG, 'backlog', bl.filter((e) => e !== blMatch));
    commit([REL_BACKLOG], `gtg resume: ${blMatch.project} — backlog handoff consumed`);
    console.log(`Consumed from backlog: ${blMatch.project}`);
    return;
  }
  console.error(`No project matching '${t}'. Try 'gtg list' or 'gtg backlog'.`);
  process.exit(2);
}

// undo = restore BOTH stores from before the last commit that touched either one;
// repeats to step further back.
//
// Finding C1: the anchor commit used to be picked from _active.json alone. Two
// mutations write _backlog.json ONLY (`gtg backlog --project ...` parking a new
// idea, and `gtg resume <backlog-slug>`) — anchoring on _active.json skips right
// past those, lands on an unrelated older active-list commit, reverts THAT
// instead, and (since the restore code still ran against a mismatched parent)
// silently deleted the backlog. Fix: the anchor considers both paths, and each
// store is restored independently against ITS OWN state at `last^`, tolerating
// "didn't exist at last^" per file rather than assuming both existed.
function undo() {
  let last;
  try {
    last = execFileSync('git', ['log', '-1', '--format=%H', '--', REL_ACTIVE, REL_BACKLOG], { cwd: ROOT }).toString().trim();
  } catch { last = ''; }
  if (!last) { console.error('No gtg history to undo.'); process.exit(2); }
  const subject = execFileSync('git', ['log', '-1', '--format=%s', last], { cwd: ROOT }).toString().trim();

  // Restore one store from `${last}^`. Returns whether it changed anything.
  // If the file didn't exist at last^ but exists now, this commit created it —
  // undoing means removing it. (Undoing the very first-ever handoff commit is
  // exactly this case: _active.json had no `last^` at all, so it goes away
  // entirely — correct, not an error.)
  const restoreOne = (rel) => {
    const path = join(ROOT, rel);
    const existedBefore = existsSync(path);
    let prev = null;
    try { prev = execFileSync('git', ['show', `${last}^:${rel}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
    catch { /* absent at last^ — never existed yet at that point in history */ }
    if (prev !== null) { writeFileSync(path, prev); return true; }
    if (existedBefore) { rmSync(path); return true; }
    return false;
  };
  const activeTouched = restoreOne(REL_ACTIVE);
  const backlogTouched = restoreOne(REL_BACKLOG);
  if (!activeTouched && !backlogTouched) {
    console.error(`Nothing before '${subject}' - can't undo further.`);
    process.exit(2);
  }

  const paths = [...(activeTouched ? [REL_ACTIVE] : []), ...(backlogTouched ? [REL_BACKLOG] : [])];
  commit(paths, `gtg undo: revert '${subject}'`);
  // Report what came back without re-running list() — list() calls autoShelf(),
  // which would immediately re-park a still-stale restored entry (and commit again).
  const restored = readStore(REL_ACTIVE) ?? {};
  const names = Array.isArray(restored.handoffs) ? restored.handoffs.map((e) => e.project) : [];
  console.log(`Undone: ${subject}`);
  console.log(`Active entries now (${names.length}): ${names.join(', ') || '(none)'}`);
}

// After a move (back/active/remove/resume/undo) a HUMAN wants the updated list;
// an AI does not — gtg runs piped when a tool invokes it (stdout not a TTY), so
// TTY-gating suppresses the render for models with zero wasted context, no flag
// needed. --list / --no-list force it either way. renderList (not list) so undo's
// just-restored stale entry isn't immediately re-shelved by autoShelf.
function maybeAutoList(argv) {
  const a = parseFlags(argv);
  if (a['no-list']) return;
  if (a.list || process.stdout.isTTY) renderList([]);
}
const MOVE_CMDS = new Set(['back', 'active', 'remove', 'rm', 'prune', 'resume', 'undo', 'rename']);

// --- dispatch -----------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
const builtins = {
  handoff, backlog, list, help, '--help': help, '-h': help,
  back, active: activate, remove, rm: remove, prune: remove, resume: resumeConsume, undo,
  rename, log,
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
  // (bundled, ships active). cmd becomes a path segment — constrain it the same way
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
      await mod.default({ root: ROOT, args: rest, readStore, writeStore, commit, countHandoffFiles });
    } catch (e) {
      console.error(`gtg: extension '${cmd}' failed: ${(e?.message || String(e)).split('\n')[0]}`);
      process.exit(1);
    }
  } else {
    console.error(`gtg: unknown command '${cmd}' — try 'gtg help'`);
    process.exit(2);
  }
}
