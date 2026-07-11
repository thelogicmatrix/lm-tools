#!/usr/bin/env node
// gtg — zero-model bookkeeping CLI for the gtg pause/resume skill.
// Storage root: GTG_HUB env var if set, else the current git repo's root.
// Unknown subcommands dispatch to <root>/.gtg/commands/<name>.mjs (see README).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

// --- storage root -----------------------------------------------------------
function resolveRoot() {
  if (process.env.GTG_HUB) return process.env.GTG_HUB;
  try {
    // GIT_CEILING_DIRECTORIES bounds the upward repo search at the OS temp
    // root, so a scratch dir under tmpdir() never accidentally resolves to
    // some ancestor repo that happens to enclose the temp directory (e.g. a
    // home directory that is itself a git mirror). Correct on Windows/POSIX.
    return execSync('git rev-parse --show-toplevel', {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() },
    }).toString().trim();
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
  try {
    execSync(`git add ${paths.map((x) => `"${x}"`).join(' ')}`, { cwd: ROOT });
    execSync(`git commit -q -m "${message.replace(/"/g, "'")}"`, { cwd: ROOT });
  } catch { /* nothing staged or identical content — files are on disk regardless */ }
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
function backlogList() { console.log('gtg backlog: list not implemented yet'); } // replaced in Task 3

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

// --- dispatch -----------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
const builtins = { handoff, backlog, help, '--help': help, '-h': help };
if (!cmd) { builtins.list ? builtins.list([]) : help(); }
else if (builtins[cmd]) { await builtins[cmd](rest); }
else {
  console.error(`gtg: unknown command '${cmd}' — try 'gtg help'`);
  process.exit(2);
}
