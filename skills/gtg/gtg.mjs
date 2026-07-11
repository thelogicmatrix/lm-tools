#!/usr/bin/env node
// gtg — zero-model bookkeeping CLI for the gtg pause/resume skill.
// Storage root: GTG_HUB env var if set, else the current git repo's root.
// Unknown subcommands dispatch to <root>/.gtg/commands/<name>.mjs (see README).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

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
    execSync(`git add ${paths.map((x) => `"${x}"`).join(' ')}`, opts);
    execSync(`git commit -q -m "${message.replace(/"/g, "'")}"`, opts);
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
function nowIso() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}
function ago(iso) {
  const h = (Date.now() - Date.parse(iso)) / 3600000;
  if (!Number.isFinite(h)) return '?';
  return h < 48 ? `${Math.floor(h)}h ago` : `${Math.floor(h / 24)}d ago`;
}
function sortByProject(arr) { return [...arr].sort((a, b) => a.project.localeCompare(b.project)); }
// "<n>" resolves against the sorted order `list` displays; else slug exact, else fuzzy project
function resolveEntry(arr, t) {
  if (/^\d+$/.test(t)) return sortByProject(arr)[Number(t) - 1] ?? null;
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

// --- handoff / backlog park ---------------------------------------------------
function writeHandoff(argv, { storeRel, key, verb }) {
  const a = parseFlags(argv);
  const missing = ['project', 'slug', 'phase', 'tier', 'next'].filter((k) => !a[k]);
  if (missing.length) { console.error(`gtg ${verb}: missing --${missing.join(', --')}`); process.exit(2); }
  // slug becomes a filename and a git-add arg — constrain it so it can't traverse paths or inject shell.
  if (!/^[A-Za-z0-9_-]+$/.test(a.slug)) { console.error(`gtg ${verb}: --slug must match [A-Za-z0-9_-]`); process.exit(2); }
  const body = readFileSync(0, 'utf8').trim(); // stdin
  if (!body) { console.error(`gtg ${verb}: empty body on stdin`); process.exit(2); }
  let branch = a.branch;
  if (!branch) {
    try { branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
    catch { branch = '?'; }
  }
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const relFile = `docs/handoffs/${stamp}-${a.slug}.md`;
  const doc = `# Handoff: ${a.project}
Date: ${stamp.slice(0, 10)} ${p(d.getHours())}:${p(d.getMinutes())}
Phase: ${a.phase}
Worktree: ${a.worktree || 'repo root'}
Branch: ${branch}

${body}

## Resume Prompt
Say: "let's continue ${a.project}"
`;
  const entry = {
    project: a.project, slug: a.slug, phase: a.phase, tier: a.tier,
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
  commit([relFile, storeRel], `${verb}: ${a.project} — ${a.phase}`);
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
  commit([REL_ACTIVE, REL_BACKLOG], `gtg backlog: auto-park ${stale.length} stale (>7d) project(s)`);
  console.log(`Auto-shelved ${stale.length} project(s) idle >7d to backlog: ${stale.map((s) => s.project).join(', ')}`);
}

function list(argv) {
  autoShelf();
  const filter = argv.find((x) => !x.startsWith('--'));
  const allAct = sortByProject(entries(REL_ACTIVE, 'handoffs'));
  const blCount = entries(REL_BACKLOG, 'backlog').length;
  const shown = filter
    ? allAct.filter((e) => e.slug === filter || e.project.toLowerCase().includes(filter.toLowerCase()))
    : allAct;
  if (!shown.length) {
    console.log(`No active gtg projects${filter ? ` matching '${filter}'` : ''}.` +
      (blCount ? ` (+${blCount} backlogged — gtg backlog)` : ''));
    return;
  }
  console.log(`${shown.length} active gtg project${shown.length === 1 ? '' : 's'}${filter ? ` matching '${filter}'` : ''}:`);
  shown.forEach((e) => {
    // Number by position in the FULL sorted list, not the filtered subset, so
    // `gtg remove <n>` (resolveEntry runs over the full list) targets this same entry.
    const n = allAct.indexOf(e) + 1;
    console.log(`${n}. ${e.project} - ${e.phase} [${e.tier || '?'}] (${ago(e.updated)})`);
    console.log(`   next: ${e.next}`);
  });
  if (blCount) console.log(`+ ${blCount} backlogged - gtg backlog`);
}

function backlogList() {
  const bl = entries(REL_BACKLOG, 'backlog');
  if (!bl.length) {
    console.log("Backlog is empty. Shelf an active entry with 'gtg back <n>', or park an idea with 'gtg backlog --project ...'.");
    return;
  }
  console.log(`${bl.length} backlogged project${bl.length === 1 ? '' : 's'}:`);
  sortByProject(bl).forEach((e, i) => {
    console.log(`b${i + 1}. ${e.project} - ${e.phase} [${e.tier || '?'}] (parked ${ago(e.updated)})`);
    console.log(`    next: ${e.next}`);
  });
  console.log('Activate: gtg active <n>');
}

function help() {
  console.log(`gtg — pause/resume + backlog bookkeeping
  gtg handoff --project --slug --phase --tier --next [--worktree] [--branch] [--dry-run]   (body on stdin)
  gtg backlog [same flags]     park on the backlog shelf (body on stdin); bare = list the shelf
  gtg list [project]           active handoffs (+ 7-day auto-shelf sweep); optional filter
  gtg back <n|slug>            shelf an active entry to the backlog
  gtg active <n|slug>          reactivate a backlog entry
  gtg remove <n|slug>          drop an entry (active first, then backlog)
  gtg undo                     revert the last change to the active list
Storage root: GTG_HUB env var if set, else the enclosing git repo.
Unknown commands dispatch to <root>/.gtg/commands/<name>.mjs — see README "Extending gtg".`);
}

// --- back / active / remove / undo --------------------------------------------
function back(argv) {
  const t = argv[0];
  if (!t) { console.error("Usage: gtg back <number|slug>  (see 'gtg list')"); process.exit(2); }
  const act = entries(REL_ACTIVE, 'handoffs');
  const match = resolveEntry(act, t);
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
  const hint = sortByProject(act).indexOf(match) + 1;
  console.log(`Activated: ${match.project}. Shelve again: gtg back ${hint}`);
}

function remove(argv) {
  const t = argv[0];
  if (!t) { console.error("Usage: gtg remove <number|slug>  (see 'gtg list')"); process.exit(2); }
  const act = entries(REL_ACTIVE, 'handoffs');
  const match = resolveEntry(act, t);
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

// undo = restore _active.json from before its last-modifying commit; repeats to step further back
function undo() {
  let last;
  try { last = execSync(`git log -1 --format=%H -- "${REL_ACTIVE}"`, { cwd: ROOT }).toString().trim(); } catch { last = ''; }
  if (!last) { console.error('No gtg history to undo.'); process.exit(2); }
  const subject = execSync(`git log -1 --format=%s ${last}`, { cwd: ROOT }).toString().trim();
  let prev;
  try { prev = execSync(`git show "${last}^:${REL_ACTIVE}"`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
  catch { console.error(`Nothing before '${subject}' - can't undo further.`); process.exit(2); }
  writeFileSync(join(ROOT, REL_ACTIVE), prev);
  commit([REL_ACTIVE], `gtg undo: revert '${subject}'`);
  // Report what came back without re-running list() — list() calls autoShelf(),
  // which would immediately re-park a still-stale restored entry (and commit again).
  const restored = (() => { try { return JSON.parse(prev); } catch { return {}; } })();
  const names = Array.isArray(restored.handoffs) ? restored.handoffs.map((e) => e.project) : [];
  console.log(`Undone: ${subject}`);
  console.log(`Active entries now (${names.length}): ${names.join(', ') || '(none)'}`);
}

// --- dispatch -----------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
const builtins = {
  handoff, backlog, list, help, '--help': help, '-h': help,
  back, active: activate, remove, rm: remove, prune: remove, undo,
};
if (!cmd) { list([]); }
else if (builtins[cmd]) { await builtins[cmd](rest); }
else {
  // Extension dispatch: <root>/.gtg/commands/<name>.mjs, default export called as fn(ctx).
  // ctx is a STABILITY CONTRACT — additive-only post-v1; breaking changes = major version bump.
  const ext = join(ROOT, '.gtg', 'commands', `${cmd}.mjs`);
  if (existsSync(ext)) {
    const mod = await import(pathToFileURL(ext).href);
    await mod.default({ root: ROOT, args: rest, readStore, writeStore, commit });
  } else {
    console.error(`gtg: unknown command '${cmd}' — try 'gtg help'`);
    process.exit(2);
  }
}
