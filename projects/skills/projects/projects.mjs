#!/usr/bin/env node
// projects: zero-model bookkeeping CLI for the projects portfolio skill.
// Storage root: PROJECTS_ROOT if set, else the current git repo's root.
// _projects.json is truth for mechanical fields. INDEX.md is RENDERED from it.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';

export const STATUSES = {
  active: '🟢 active',
  ops: '🔵 ops',
  paused: '🟡 paused',
  done: '✅ done',
};
export const STATUS_ORDER = ['active', 'ops', 'paused', 'done'];
// Themes partition the index into readable sections. Six members chosen against the real
// 39 rows, not invented: fewer and citsim's worldbuilding rows sit somewhere that does not
// describe them, more and a section holds one project.
export const THEMES = {
  work: 'Work',
  'job-search': 'Job search',
  tooling: 'Tooling',
  homelab: 'Homelab',
  worldbuilding: 'Worldbuilding',
  personal: 'Personal',
};
// Derived, never a second list: a hand-maintained order drifts from the enum the first time
// a theme is added and the drift is silent.
export const THEME_ORDER = Object.keys(THEMES);
// The section a row with no theme lands in. Not a seventh theme: nothing can be SET to it,
// and with every row themed the section renders on no row and never appears.
export const UNTHEMED = 'Unthemed';
export const PROJECTS_DIR = 'docs/projects';
export const REL_STORE = `${PROJECTS_DIR}/_projects.json`;
export const REL_INDEX = `${PROJECTS_DIR}/INDEX.md`;
const SLUG_RE = /^[A-Za-z0-9_-]+$/;

export function resolveRoot() {
  if (process.env.PROJECTS_ROOT) return process.env.PROJECTS_ROOT;
  try {
    return execSync('git rev-parse --show-toplevel', { stdio: ['ignore', 'pipe', 'ignore'] })
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
  const p = join(root, REL_STORE);
  const store = existsSync(p) ? parseStore(p) : { version: 1, projects: [] };
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
      throw new Error(`projects: ${REL_INDEX} carries ${rows} row(s) and ${REL_STORE
        } has none. Migrate it first. Any verb here would render an empty index over it`);
    }
  }
  return store;
}

function parseStore(p) {
  try {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    return { version: d.version ?? 1, projects: d.projects ?? [] };
  } catch (e) {
    // ponytail: still an exit rather than a throw, unlike the refusal above. Pre-existing Task 1
    // behaviour with no test on it, and resolveRoot does the same. Convert both together if a
    // programmatic caller ever needs to survive a corrupt store.
    console.error(`projects: ${REL_STORE} is not valid JSON. ${e.message}`);
    process.exit(2);
  }
}

export function writeStore(root, store) {
  const p = join(root, REL_STORE);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2) + '\n');
}

export function validateStatus(s) {
  if (!Object.prototype.hasOwnProperty.call(STATUSES, s)) {
    throw new Error(`unknown status "${s}", expected one of ${STATUS_ORDER.join(', ')}`);
  }
  return s;
}

// No `projects: ` prefix, matching validateStatus and validateSlug. DELIBERATE below keys
// off that, and main maps this message to exit 2: a bad theme is bad input, not a bug here.
export function validateTheme(t) {
  if (!Object.prototype.hasOwnProperty.call(THEMES, t)) {
    throw new Error(`unknown theme "${t}", expected one of ${THEME_ORDER.join(', ')}`);
  }
  return t;
}

export function validateSlug(s) {
  if (typeof s !== 'string' || !SLUG_RE.test(s)) throw new Error(`invalid slug "${s}"`);
  return s;
}

// _projects.json is hand-editable, so every field here tolerates junk: an unrecognised
// status ranks last rather than -1 (which would sort a typo AHEAD of active), and a
// missing lastTouched/slug sorts last rather than throwing on undefined.localeCompare.
const rank = (s) => (STATUS_ORDER.includes(s) ? STATUS_ORDER.indexOf(s) : STATUS_ORDER.length);

export function sortProjects(list) {
  return [...list].sort((a, b) =>
    rank(a.status) - rank(b.status) ||
    (b.lastTouched || '').localeCompare(a.lastTouched || '') ||
    (a.slug || '').localeCompare(b.slug || ''));
}

const INDEX_HEADER = `# Projects: Portfolio Index

*Generated by the \`projects\` CLI from \`_projects.json\`.
Do not hand-edit this file.*

One row per active effort. Each project links to its narrative
page in this folder, which is where its \`## Current state\` lives.
This table carries pointers only. Work projects carry name and
status only, never customer data or work content.

Change a row with \`projects status <slug> <status>\`, or its other
fields with \`projects set <slug> --where W --repo R\`. Rename one with
\`projects rename <old> <new>\`. Change what a project is *doing* with
\`projects current <slug>\`, which writes to its page.
A hand-edit here is overwritten on the next render.
`;

const INDEX_COLUMNS = '| Project | Status | Where | Last touched |';

// A pipe splits the cell and shifts every column after it. A newline does worse, it ends the
// row early and the tail becomes a phantom project on parse. Refuse both loudly rather than
// write a corrupt table. Covers `page` too: it lands inside the link target.
const UNRENDERABLE = /[|\r\n]/;
export function assertRenderable(p) {
  const fields = [p.name, ...(p.where || []), p.lastTouched || '', p.page || ''];
  for (const f of fields) {
    if (UNRENDERABLE.test(String(f))) {
      throw new Error(`projects: pipe or line break in a rendered field ("${f}")`);
    }
  }
  return p;
}

// The label a section is titled with. A known theme gets its display name. An unrecognised
// one gets its own raw value, so a typo names itself in the index instead of being absorbed
// into a real section. A row with none gets UNTHEMED.
export function themeLabel(theme) {
  if (!theme) return UNTHEMED;
  return THEMES[theme] ?? theme;
}

// Insertion-ordered: every enum label first so an empty theme still holds its position, then
// any unrecognised label as encountered, then UNTHEMED last however it got in. Empty sections
// are dropped by the caller, not here, so renderList and renderIndex agree on the order.
export function groupByTheme(rows) {
  const sections = new Map(THEME_ORDER.map((t) => [THEMES[t], []]));
  for (const p of rows) {
    const label = themeLabel(p.theme);
    if (!sections.has(label)) sections.set(label, []);
    sections.get(label).push(p);
  }
  if (sections.has(UNTHEMED)) {
    const last = sections.get(UNTHEMED);
    sections.delete(UNTHEMED);
    sections.set(UNTHEMED, last);
  }
  return sections;
}

// Extracted from the map below so renderIndex reads as grouping rather than as row building.
// The try/catch stays here, at the one place that has the slug, for the reason below.
function renderRow(p) {
  // Both throws name the offending value and neither knows which row it came from, and one
  // bad row refuses every mutating verb, including a verb touching only healthy rows. So the
  // slug is added here.
  try {
    assertRenderable(p);
    const label = p.page ? `[${p.name}](${p.page})` : p.name;
    // `|| ''` on the date: Task 1 tolerates a missing lastTouched, and without this the cell
    // renders the literal string "undefined" and round-trips into the store as that string.
    return `| ${label} | ${STATUSES[validateStatus(p.status)]} | ${(p.where || []).join(' · ')} | ${p.lastTouched || ''} |`;
  } catch (e) {
    throw new Error(`${(e && e.message) || e} on project "${p.slug}"`);
  }
}

// One section per non-empty theme. Sorting is unchanged and applies WITHIN a section, so a
// row's neighbours change but its rank against them does not.
export function renderIndex(store) {
  const parts = [INDEX_HEADER];
  for (const [label, rows] of groupByTheme(sortProjects(store.projects))) {
    if (!rows.length) continue;
    parts.push(`## ${label}`, '', INDEX_COLUMNS, '|---|---|---|---|', ...rows.map(renderRow), '');
  }
  // The join leaves exactly one trailing newline because every section ends with ''. The
  // replace is belt and braces for a store with no projects at all, where parts is just the
  // header and the file must still end in a single newline.
  return parts.join('\n').replace(/\n*$/, '\n');
}

const RENDERED_TO_WORD = Object.fromEntries(
  Object.entries(STATUSES).map(([word, rendered]) => [rendered, word]));

const RENDERED_TO_THEME = Object.fromEntries(
  Object.entries(THEMES).map(([key, label]) => [label, key]));

// The inverse of renderIndex, for the one-off migration of the hand-typed INDEX.md and for
// the round-trip test. The slug is DERIVED here. The store's own slug stays authoritative.
export function parseIndex(text) {
  const projects = [];
  let theme;
  for (const line of text.split('\n')) {
    // Theme is the first store field that decides WHERE a row renders, so parseIndex has to
    // recover it or the byte-stable round trip breaks and every row re-renders as Unthemed.
    // Three cases, one expression, and it is a true inverse of themeLabel: a known label maps
    // back to its key, UNTHEMED maps back to no theme, and an unrecognised heading maps back
    // to itself so a typo section survives a round trip instead of being relabelled.
    const heading = line.match(/^## (.+)$/);
    if (heading) {
      const label = heading[1].trim();
      theme = RENDERED_TO_THEME[label] ?? (label === UNTHEMED ? undefined : label);
      continue;
    }
    if (!line.startsWith('| ')) continue;
    const c = line.split('|').map((s) => s.trim());
    if (c.at(-1) === '') c.pop(); // trailing pipe
    // c[0] is '' (leading pipe): name, status, where, ..., lastTouched
    // A short row would alias label and c.at(-1) to the same cell and parse a project with
    // status undefined. An all-dashes row is the separator in its spaced `| --- | --- |` form,
    // which would otherwise parse as a project named "---". One guard each, same loop.
    if (c.length < 5 || c.slice(1).every((cell) => /^:?-+:?$/.test(cell))) continue;
    const [, label, status, where] = c;
    // Skip the header ROW, not every row that merely STARTS with "Project": a pageless project
    // named "Project Atlas" renders as `| Project Atlas | 🟢 active | … |` and a startsWith
    // test dropped it silently. Both header shapes, the 4-column rendered one and the legacy
    // 5-column hand-typed one, carry the literal cells Project/Status, which no data row can:
    // a rendered status always carries its emoji.
    if (label === 'Project' && status === 'Status') continue;
    // The date comes from the LAST cell, not position 4: the hand-typed table this replaces
    // had a 5th `Next` column BEFORE Last touched (verified, all 21 rows), so reading
    // position 4 would migrate the Next prose in as lastTouched and drop the date.
    const lastTouched = c.at(-1);
    const link = label.match(/^\[(.+)\]\((.+)\)$/);
    projects.push({
      slug: (link ? link[2].replace(/\.md$/, '') : label).toLowerCase().replace(/[^a-z0-9_-]+/g, '-'),
      name: link ? link[1] : label,
      status: RENDERED_TO_WORD[status] ?? status,
      ...(theme ? { theme } : {}),
      where: where ? where.split(' · ') : [],
      page: link ? link[2] : null,
      lastTouched,
    });
  }
  return { version: 1, projects };
}

// ── The Current state block ──────────────────────────────────────────────────────────
// The only place this CLI writes into a hand-written page. Everything around the block is
// prose a human wrote and cannot get back, so two rules hold everywhere below:
//   1. Delete only text between a matched pair of markers, plus the block's own heading
//      when that heading is provably ours.
//   2. On any page shape where the boundary would have to be guessed, throw and write
//      nothing. A refused write costs a minute. A wrong cut costs the narrative.
export const CS_START = '<!-- projects:current-state:start -->';
export const CS_END = '<!-- projects:current-state:end -->';
export const NARRATIVE_UNWRITTEN = '<!-- projects:narrative-unwritten -->';

// sync reads the heading back with /^## Current state \((\d{4}-\d\d-\d\d)\)/m, so a date in
// any other shape writes a block that is permanently invisible to it. Catches the caller who
// forgets the argument too, which would otherwise head the block with "(undefined)".
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const countOf = (text, needle) => text.split(needle).length - 1;

const AMBIGUOUS = 'Fix the page by hand. This tool will not guess where the block ends.';

// Returns {s, e} for one clean pair, null when the page carries no block at all, and throws
// for every other shape: an unclosed block, a stray end, a reversed pair, a duplicated or
// nested pair. Each of those has some cut that looks plausible, and each of those cuts eats
// narrative. indexOf alone would take the first of each marker and slice straight through.
function locateBlock(pageText) {
  // Checked here rather than in each caller: every read and every write routes through this
  // one predicate, and without it a non-string page dies inside countOf with "Cannot read
  // properties of undefined (reading 'split')", which names neither the argument nor the page.
  if (typeof pageText !== 'string') {
    throw new TypeError(`projects: page text must be a string, got ${typeof pageText}`);
  }
  const starts = countOf(pageText, CS_START);
  const ends = countOf(pageText, CS_END);
  if (starts === 0 && ends === 0) return null;
  if (starts !== 1 || ends !== 1) {
    throw new Error(`projects: page carries ${starts} Current state start marker(s) and ${
      ends} end marker(s), expected exactly one of each. ${AMBIGUOUS}`);
  }
  const s = pageText.indexOf(CS_START);
  const e = pageText.indexOf(CS_END);
  if (e < s) {
    throw new Error(`projects: the Current state end marker comes before the start marker. ${AMBIGUOUS}`);
  }
  return { s, e };
}

// A heading is absorbed into the replacement only when it is a `## Current state` line
// sitting above the start marker with nothing but blank space between. Cutting back to the
// nearest `## ` instead, which is the obvious implementation, deletes an unrelated section
// heading and the narrative under it on any page whose block heading was hand-removed.
//
// Two details earn their keep. `[ \t\r\n]*` tolerates blank lines between the heading and the
// marker: any markdown formatter that separates block elements, or a human tidying the page,
// inserts one, and demanding the heading be the LAST thing before the marker means the match
// fails, the old heading survives, and a second heading is written below it. sync then reads
// the first heading forever and reports a date that never moves. Only whitespace intervening
// still proves the heading is ours. `\b` keeps the match from being a bare prefix, so an
// unrelated `## Current statement of work` above an orphaned marker is left alone while a
// renamed `## Current state and next steps` is still recognised as ours and absorbed.
const OWN_HEADING = /(?:^|\n)(## Current state\b[^\n]*\n[ \t\r\n]*)$/;

export function setCurrentState(pageText, body, date) {
  if (!ISO_DATE.test(date)) {
    throw new Error(`projects: the Current state heading needs a YYYY-MM-DD date, got "${date}"`);
  }
  // A non-string body collapses to the same refusal, so an undefined argument can never
  // reach the page as the literal text "undefined".
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (!trimmed) {
    throw new Error('projects: refusing to write an empty body into the Current state block');
  }
  // A body that smuggles in a marker makes the NEXT write see three markers, and from then
  // on the page can only be repaired by hand. Refuse where the corruption enters.
  if (trimmed.includes(CS_START) || trimmed.includes(CS_END)) {
    throw new Error('projects: the body carries a Current state marker, which would break every later replacement');
  }
  const block = `## Current state (${date})\n${CS_START}\n${trimmed}\n${CS_END}`;
  const at = locateBlock(pageText);
  if (at) {
    // Keyed on the markers rather than on the next `## `, which is what lets a body carry
    // its own subheadings without the following write cutting the block short.
    const before = pageText.slice(0, at.s);
    const own = before.match(OWN_HEADING);
    const from = own ? before.length - own[1].length : at.s;
    return pageText.slice(0, from) + block + pageText.slice(at.e + CS_END.length);
  }
  const fd = pageText.indexOf('\n## Future Directions');
  if (fd !== -1) return `${pageText.slice(0, fd + 1)}${block}\n\n${pageText.slice(fd + 1)}`;
  const narrative = pageText.trimEnd();
  return narrative ? `${narrative}\n\n${block}\n` : `${block}\n`;
}

export function getCurrentState(pageText) {
  const at = locateBlock(pageText);
  if (!at) return null;
  return pageText.slice(at.s + CS_START.length, at.e).trim();
}

export function currentStateFirstLine(pageText) {
  const body = getCurrentState(pageText);
  if (!body) return null;
  const first = body.split('\n').map((l) => l.trim()).filter(Boolean)[0];
  if (!first) return null;
  return first.replace(/^[-*]\s+/, '').replace(/\*\*/g, '').replace(/^#+\s*/, '');
}

// ── renderList: the no-args print ────────────────────────────────────────────────────
// One numbered row per project, status order, each tailed by its page's Current state
// opening line. Read-only: nothing here is written to disk, so a bad page must degrade
// its own row, never the command. Each row's read is its own try/catch, one per project and
// not one around the loop, so a single malformed page cannot blank out every row after it.
export function renderList(root, store) {
  if (!store.projects.length) return 'No registered projects.\n';
  return sortProjects(store.projects).map((p, i) => {
    let tail = '(no page)';
    if (p.page) {
      try {
        // pagePath, not a bare join: `page` comes out of hand-editable _projects.json, so
        // `page: "../../.ssh/config"` would otherwise make the no-args list READ a file
        // outside docs/projects. Inside the try on purpose, so the refusal degrades this one
        // row to MALFORMED like any other unreadable page and every other row still prints.
        const path = pagePath(root, p.page);
        tail = existsSync(path)
          ? currentStateFirstLine(readFileSync(path, 'utf8')) ?? '(no current state)'
          : '(page missing)';
      } catch {
        // currentStateFirstLine throws on markers that are missing-but-stray, reversed, or
        // duplicated, a deliberate refusal to guess (see locateBlock), and pagePath throws on
        // a page name that escapes the folder. A read must never lie about what is on disk,
        // so the row says MALFORMED rather than guessing or being dropped.
        tail = 'MALFORMED';
      }
    }
    // The slug is in the row because every mutating verb takes it and the skill is forbidden to
    // read the store to find it. Squashed once on the ASSEMBLED row, the same shape as the sync
    // report's join: the row interpolates raw store fields, and a line break in any of them
    // printed an extra numbered row carrying whatever tokens the author of the store chose.
    // Squashing the whole row rather than each field leaves no later field to remember.
    // `\s` covers every character /m treats as a line start, not just \n.
    return `${i + 1}. ${p.name} [${p.slug}] (${p.status}): ${tail}`.replace(/\s+/g, ' ');
  }).join('\n') + '\n';
}

// The LOCAL calendar date, which is the calendar every date in this file is in. The dates it is
// compared against are local too: git's --date=short renders a commit's own zone, and a human
// reading a page means the day it is where he is. A bare toISOString slice is UTC, so it named
// yesterday for the first hours of every local day east of Greenwich.
export function today() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function commit(root, paths, message) {
  // No paths means nothing was asked for. Falling through would be the exact disaster
  // this function exists to prevent: a bare `git add` exits 0 ("Nothing specified" is a
  // hint, not an error), so the commit would run with nothing after `--`, which git
  // reads as NO pathspec, sweeping the whole shared index and taking other sessions'
  // staged work. Verified by experiment. Callers build `paths` conditionally, so [] is ordinary.
  if (!paths.length) return true;
  const opts = { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    // `--` on the add too: the slug regex permits a leading '-', so a path could parse as a flag.
    execFileSync('git', ['add', '--', ...paths], opts);
    // Name the paths on the COMMIT too. A pathspec-less commit takes the WHOLE shared
    // index, so a concurrent session's staged work rides along in ours.
    execFileSync('git', ['commit', '-q', '-m', message, '--', ...paths], opts);
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
    console.error(`projects: git commit failed, changes are on disk but uncommitted. ${
      (e.stderr || e.message || '').toString().trim().split('\n')[0]}`);
    return false;
  }
}

// ── The mutating verbs ───────────────────────────────────────────────────────────────
// Everything below reaches disk, and two of them reach git. Three habits are load-bearing:
// the slug is validated before any path.join, the index is RENDERED before anything is
// written so a row that cannot render never lands in the store, and every read and write
// names 'utf8' because the `where` join is byte-exact on U+00B7.

export function findProject(store, slug) {
  return store.projects.find((p) => p.slug === slug);
}

// `page` comes out of hand-editable _projects.json, so it is exactly as untrusted as a slug.
// One guard at the single choke point covers every verb: this is the only way any of them
// names a page file. Without it `page: "../../secrets.md"` lets cmdCurrent overwrite and
// cmdArchive MOVE a file anywhere in the tree.
function pagePath(root, page) {
  if (typeof page !== 'string' || !/^[A-Za-z0-9_.-]+\.md$/.test(page) || page.includes('..')) {
    throw new Error(`projects: refusing a page path outside ${PROJECTS_DIR} ("${page}")`);
  }
  return join(root, PROJECTS_DIR, page);
}

function saveAndRender(root, store, extraPaths, message, opts) {
  // Rendered FIRST. assertRenderable throws on a pipe or a line break in any rendered field,
  // and if the store were written before that throw it would hold a row no render can emit,
  // which fails every later status, current and render call until someone edits the JSON.
  const index = renderIndex(store);
  writeStore(root, store);
  writeFileSync(join(root, REL_INDEX), index, 'utf8');
  console.log('RENDERED');
  if (opts.commit !== false) commit(root, [REL_STORE, REL_INDEX, ...extraPaths], message);
}

export function cmdCurrent(root, args, body, opts = {}) {
  const slug = validateSlug(args[0]);
  const date = opts.date || today();
  if (!body || !body.trim()) throw new Error('projects: empty body, nothing to write');
  const store = readStore(root);
  const p = findProject(store, slug);
  if (!p) throw new Error(`projects: unknown project "${slug}"`);
  if (!p.page) throw new Error(`projects: "${slug}" has no page. Run projects register first`);
  const path = pagePath(root, p.page);
  if (!existsSync(path)) throw new Error(`projects: page ${p.page} is missing`);
  // setCurrentState runs INSIDE the writeFileSync argument on purpose: it refuses a page whose
  // markers it cannot bound, and that refusal has to leave the file byte-identical on disk.
  writeFileSync(path, setCurrentState(readFileSync(path, 'utf8'), body, date), 'utf8');
  p.lastTouched = date;
  saveAndRender(root, store, [`${PROJECTS_DIR}/${p.page}`], `projects: current state for ${slug}`, opts);
}

export function cmdStatus(root, args, opts = {}) {
  const slug = validateSlug(args[0]);
  const status = validateStatus(args[1]);
  const store = readStore(root);
  const p = findProject(store, slug);
  if (!p) throw new Error(`projects: unknown project "${slug}"`);
  p.status = status;
  p.lastTouched = opts.date || today();
  saveAndRender(root, store, [], `projects: ${slug} → ${status}`, opts);
}

// The mechanical fields other than status and slug, which have their own verbs. Before this, a
// row's `where` and `repo` could only be set at register time, so a project that moved worktree
// had no path at all once the store became the source and hand-editing it was denied. `where`
// changes often here, because worktrees come and go.
//
// `repo` is what lets sync check a project against reality: STALE compares its stated state to
// that repo's last commit, and MISSING-REPO fires when the path is gone. A row with no repo is
// invisible to both, which is correct for a docs-only or Notion-only project and a silent gap
// for one that has its own checkout.
export function cmdSet(root, args, opts = {}) {
  const slug = validateSlug(args[0]);
  const store = readStore(root);
  const p = findProject(store, slug);
  if (!p) throw new Error(`projects: unknown project "${slug}"`);
  const name = flag(args, '--name');
  const repo = flag(args, '--repo');
  const where = flag(args, '--where');
  const themeArg = flag(args, '--theme');
  if (name === null && repo === null && where === null && themeArg === null) {
    throw new Error('projects: nothing to set, pass at least one of --name, --where, --repo, --theme');
  }
  // Validated BEFORE any assignment below, alongside assertRenderable, so a bad theme in a
  // multi-flag call leaves the row exactly as it was rather than half-updated.
  const theme = themeArg === null ? null : validateTheme(themeArg);
  // Rendered fields go through the same gate register uses, and BEFORE anything is assigned: a
  // pipe or a line break here would corrupt the table or forge a row.
  assertRenderable({ name: name ?? p.name, where: where !== null ? [where] : (p.where || []),
    lastTouched: p.lastTouched || '', page: p.page || '' });
  if (name !== null) p.name = name;
  if (where !== null) p.where = [where];
  // Unlike --repo below, an empty string does NOT clear it: every row has a theme, and a cleared
  // one renders into a section it does not belong to. '' reaches validateTheme and is refused.
  if (theme !== null) p.theme = theme;
  // An empty string CLEARS repo, for a project whose own checkout has gone away. The key is
  // deleted rather than set to '', so absent has one representation, which is what every reader
  // already branches on.
  if (repo !== null) { if (repo === '') delete p.repo; else p.repo = repo; }
  // lastTouched is not bumped, for the same reason rename does not bump it.
  console.log('SET');
  saveAndRender(root, store, [], `projects: set ${slug}`, opts);
}

// Refused rather than accepted, because the next argv element is taken whatever it is: a typo'd
// `register x --name --status active` registered a project literally named "--status" at exit 0,
// and the name is the field a human reads in the index afterwards.
function flag(args, name, fallback = null) {
  const i = args.indexOf(name);
  if (i === -1 || i === args.length - 1) return fallback;
  const value = args[i + 1];
  if (value.startsWith('--')) {
    throw new Error(`projects: ${name} was given ${value}, which is another flag. Quote the value if it really starts with --`);
  }
  return value;
}

export function cmdRegister(root, args, opts = {}) {
  const slug = validateSlug(args[0]);
  const store = readStore(root);
  if (findProject(store, slug)) throw new Error(`projects: "${slug}" is already registered`);
  const name = flag(args, '--name', slug);
  const status = validateStatus(flag(args, '--status', 'active'));
  // Required, not defaulted. A default would pool every new row in one theme silently, and
  // the whole reason this field exists is that the layer's failure mode is things nobody
  // remembers to do. Read here, with the other flags, so it throws before the page is written
  // and a refusal leaves no orphan page behind, the same guarantee assertRenderable has below.
  const themeArg = flag(args, '--theme');
  if (themeArg === null) {
    throw new Error(`projects: --theme is required, expected one of ${THEME_ORDER.join(', ')}`);
  }
  const theme = validateTheme(themeArg);
  const where = flag(args, '--where');
  const repo = flag(args, '--repo');
  const date = opts.date || today();
  const page = `${slug}.md`;
  const path = pagePath(root, page);
  // register is the only verb taking free text from argv into a rendered field, so it is the
  // only door a pipe can come through. Checked here, before the skeleton is written, so a
  // refusal leaves no orphan page behind either.
  assertRenderable({ name, where: where ? [where] : [], lastTouched: date, page });
  // Only when the page is absent. An existing page is ADOPTED, never overwritten: a hand
  // written narrative that predates the row is the whole reason this tool does not author prose.
  // `last verified never`, never a date: a skeleton's narrative is unwritten, so stamping today
  // claims a review that did not happen, and it would suppress sync's UNVERIFIED sentinel for
  // the whole staleness window on exactly the pages that most need it. The field is still
  // PRESENT, so no reader downstream needs a missing-field branch.
  //
  // No status in the header. Only the store carries the status, because `status` rewrites the
  // store and never the page, so a status written here would be the registration status forever
  // and no sync check compares the two. The list row carries the status instead.
  if (!existsSync(path)) {
    // A fresh repo has no docs/projects yet, and without this the write is a bare ENOENT.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `# ${name}\n*last verified never · docs: none*\n\n`
      + `${NARRATIVE_UNWRITTEN}\n\n`
      + `## Current state (${date})\n${CS_START}\nRegistered ${date}. No status written yet.\n${CS_END}\n\n`
      + `## Future Directions\n\n## Docs map\n`, 'utf8');
  }
  store.projects.push({ slug, name, status, theme, where: where ? [where] : [],
    ...(repo ? { repo } : {}), page, lastTouched: date });
  saveAndRender(root, store, [`${PROJECTS_DIR}/${page}`], `projects: register ${slug}`, opts);
}

export function cmdArchive(root, args, opts = {}) {
  const slug = validateSlug(args[0]);
  const store = readStore(root);
  const p = findProject(store, slug);
  if (!p) throw new Error(`projects: unknown project "${slug}"`);
  const moved = [];
  if (p.page && existsSync(pagePath(root, p.page))) {
    const dest = join(root, PROJECTS_DIR, 'archive', p.page);
    // renameSync replaces the destination without a word. A second project reusing a retired
    // slug would silently destroy the first one's archived narrative, so refuse and keep both.
    if (existsSync(dest)) {
      throw new Error(`projects: there is already an archived page at ${
        PROJECTS_DIR}/archive/${p.page}. Move it aside first`);
    }
    mkdirSync(join(root, PROJECTS_DIR, 'archive'), { recursive: true });
    renameSync(pagePath(root, p.page), dest);
    moved.push(`${PROJECTS_DIR}/${p.page}`, `${PROJECTS_DIR}/archive/${p.page}`);
  }
  store.projects = store.projects.filter((x) => x.slug !== slug);
  console.log('ARCHIVED');
  saveAndRender(root, store, moved, `projects: archive ${slug}`, opts);
}

export function cmdRename(root, args, opts = {}) {
  const from = validateSlug(args[0]);
  const to = validateSlug(args[1]);
  const store = readStore(root);
  const p = findProject(store, from);
  if (!p) throw new Error(`projects: unknown project "${from}"`);
  if (from === to) throw new Error(`projects: "${from}" is already its own slug`);
  if (findProject(store, to)) throw new Error(`projects: "${to}" is already registered`);
  const moved = [];
  // The page moves only when its basename IS the old slug. A page whose name had already
  // diverged was named that way on purpose, and renaming it here would be a second change
  // nobody asked for. The row keeps pointing at it either way.
  if (p.page === `${from}.md`) {
    const dest = `${to}.md`;
    // Same refusal as archive, for the same reason: renameSync replaces a destination without
    // a word, so an unrelated page already sitting at the new name would be destroyed.
    if (existsSync(pagePath(root, dest))) {
      throw new Error(`projects: there is already a page at ${PROJECTS_DIR}/${dest}. Move it aside first`);
    }
    if (existsSync(pagePath(root, p.page))) {
      renameSync(pagePath(root, p.page), pagePath(root, dest));
      // BOTH paths, so git records a rename rather than a delete plus an untracked add.
      moved.push(`${PROJECTS_DIR}/${p.page}`, `${PROJECTS_DIR}/${dest}`);
    }
    p.page = dest;
  }
  p.slug = to;
  // lastTouched is deliberately NOT bumped. A rename is bookkeeping, not work on the project,
  // and bumping it would restart sync's staleness window on something nobody touched.
  console.log('RENAMED');
  saveAndRender(root, store, moved, `projects: rename ${from} to ${to}`, opts);
  warnDanglingParents(root, from, to);
}

// gtg entries name the family they belong to by a PORTFOLIO slug, in their own `parent` field.
// So a rename here can dangle a reference held in a store this CLI does not own, and the cost is
// silent: an unresolved parent just lists that project as standalone. Read gtg's stores to say
// so, and never write them, which is the boundary that keeps two separately-versioned tools from
// depending on each other's data format. A missing or unreadable store means gtg is not installed
// against this root, which is not a problem worth a word.
function warnDanglingParents(root, from, to) {
  const hits = [];
  for (const [rel, key] of [['docs/handoffs/_active.json', 'handoffs'],
    ['docs/handoffs/_backlog.json', 'backlog']]) {
    try {
      const d = JSON.parse(readFileSync(join(root, rel), 'utf8'));
      for (const e of (d?.[key] || [])) if (e && e.parent === from) hits.push(e.slug);
    } catch { /* not installed, or not readable. Either way there is nothing to report. */ }
  }
  if (!hits.length) return;
  // Named remedy, not just a warning. `gtg rename` re-points a parent reference even when no
  // entry carries the old slug itself, which is exactly this case.
  console.log(`NOTE: ${hits.length} gtg entr${hits.length === 1 ? 'y' : 'ies'} still name "${
    from}" as their parent (${hits.join(', ')}). Re-point with: gtg rename ${from} ${to}`);
}

// The mutation log IS git. Every verb here commits with a descriptive subject, so the store and
// INDEX.md already carry the whole history including the hand-edited era before this CLI existed.
// A written ledger would be a second, thinner copy of a record git keeps for free.
export function cmdLog(root, args, opts = {}) {
  // A leading flag is not a slug. The slug pattern permits a leading '-', so `-n` would
  // otherwise validate as one and then be looked up as a project.
  const slug = args[0] && !args[0].startsWith('-') ? validateSlug(args[0]) : null;
  const n = flag(args, '-n', '20');
  let paths = [REL_STORE, REL_INDEX];
  const follow = [];
  if (slug) {
    const p = findProject(readStore(root), slug);
    if (!p) throw new Error(`projects: unknown project "${slug}"`);
    // --follow takes exactly one path, and tracking a page across renames is the whole reason
    // to ask per project: the store's own history cannot show it. A row with no page falls
    // back to the store, which is still that project's history, just coarser.
    if (p.page) { paths = [`${PROJECTS_DIR}/${p.page}`]; follow.push('--follow'); }
  }
  let out = '';
  try {
    out = execFileSync('git', ['log', `-n${n}`, '--date=short', '--format=%h %ad %s',
      ...follow, '--', ...paths], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch {
    // No repo, or no commits yet. Neither is a failure of the request.
    throw new Error('projects: no git history here');
  }
  process.stdout.write(out || 'projects: nothing recorded yet\n');
}

// ── sync: the reality check ──────────────────────────────────────────────────────────
// Reports, never rewrites: on a contradiction between a page and reality you arbitrate.
// The three dates stay distinct here, which is the whole point of the verb. The Current state
// heading says when the STATUS was rewritten, `last verified` says when a model last checked
// the NARRATIVE, and the repo's last commit says what the code actually did. STALE compares
// the first against the third, UNVERIFIED the second against the first, and neither ever
// reads `lastTouched`, which only records that some `projects` write happened.
//
// Every flag line is `TOKEN <what>: <why>`. The token is the machine surface the skill greps,
// so it is one uppercase word from the fixed vocabulary and never prose.

// One source for the heading shape, in both the "read the date" and "count them" forms. A
// global regex is safe to reuse: String.match ignores lastIndex and returns every match.
const CS_HEADING = /^## Current state \((\d{4}-\d\d-\d\d)\)/m;
const CS_HEADING_ALL = /^## Current state \(\d{4}-\d\d-\d\d\)/gm;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Both sides are parsed with an explicit Z, so the answer is a whole number of days whatever the
// machine's zone and whatever DST does between the two dates. Measured, not assumed: 2026-03-07
// to 2026-03-09 is 2 in a UTC process and 2 in a UTC+8 one.
//
// The page dates reaching here have been through isRealDate. `commitDate` has NOT: it comes from
// git's own --date=short, which cannot emit a day that does not exist, or from the commitDateFor
// seam a test injects. A junk value from that seam yields NaN, and NaN > 0 is false, so the
// result is no STALE line rather than a wrong one.
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// `\d\d` is a digit test, not a calendar: 2026-13-45 matches both date regexes below, and
// Date.parse then returns NaN, so `behind > 0` is false and the page reports clean while being
// months out. 2026-02-30 is worse, because V8 rolls it forward to 2026-03-02 and hands back a
// plausible WRONG number of days. Round-tripping through Date is the whole check: a date that
// is not the date it claims to be comes back as a different string.
function isRealDate(d) {
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
}

export function currentStateDate(pageText) {
  return (pageText.match(CS_HEADING) || [])[1] ?? null;
}

// Read from the page header only, the text above the first `## ` heading and above the block,
// which is where register writes the stamp. Nothing written into the Current state block can be
// mistaken for it. Anchoring to a line start was not enough on its own: setCurrentState writes
// the body line-initial under CS_START, so a status line reading `*last verified <date>` sat
// exactly where the anchored read looked, and since register stamps the header `never` and no
// verb ever writes a date there, the CLI could produce its own false pass. `never` deliberately
// does not match: null here means "no verified date", which is what UNVERIFIED reports.
// Bounded to the FIRST line-initial `last verified` line in that region, not to any of them.
// Scanning the region for a line that carries a date skipped straight past the skeleton's own
// `never` and read a date out of the narrative prose below it, so a page could report clean on a
// stamp a human never moved. The first such line is the stamp, and if it says `never` the answer
// is "no verified date", which is what UNVERIFIED reports. Erring toward UNVERIFIED is the safe
// direction: it asks for a read that already happened, where the other way hides one that never did.
export function lastVerifiedDate(pageText) {
  const header = pageText.split(CS_START)[0].split(/^## /m)[0];
  const stamp = header.match(/^\*last verified [^\n]*/m);
  return ((stamp && stamp[0].match(/^\*last verified (\d{4}-\d\d-\d\d)/)) || [])[1] ?? null;
}

// `-- .` is load-bearing. Without a pathspec, `git -C <dir> log -1` walks UP to whatever repo
// contains <dir>, so a `repo` field naming a plain folder inside a bigger repo reported that
// repo's newest commit, made by any session working anywhere in it, while a genuinely dormant
// folder read as 0 days behind. With it, a folder inside a repo that has no commits of its own
// exits 0 with empty output, and a real subdirectory reports its own dates. A folder in no repo
// at all is the other shape and it does not come back empty, it makes git fail with "not a git
// repository", which the catch turns into the same null. All three mean "no commit date to
// compare against", and the absent directory is reported separately as MISSING-REPO.
export function lastCommitDate(repo) {
  try {
    return execFileSync('git',
      ['-C', repo, 'log', '-1', '--format=%ad', '--date=short', '--', '.'],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch { return null; }
}

export function cmdSync(root, _args, opts = {}) {
  const date = opts.date || today();
  const commitDateFor = opts.commitDateFor || lastCommitDate;
  const store = readStore(root);
  const flags = [];
  const pagesInUse = new Set();

  for (const p of sortProjects(store.projects)) {
    if (!p.page) { flags.push(`NO-PAGE ${p.slug}: the row has nowhere to keep a status`); continue; }
    pagesInUse.add(p.page);
    // `block`, not `body`: the report's own assembled body is a separate `body` further down.
    let text, block;
    // One try per row, not one around the loop: a single unreadable page must cost its own
    // numbers and nobody else's. The read is what throws, so only the read is in here.
    try {
      // pagePath, not a bare join. sync READS every page named in the store, and `page` comes
      // out of hand-editable _projects.json, so `page: "../../.ssh/config"` would otherwise get
      // that file scanned and quoted back in a flag.
      const path = pagePath(root, p.page);
      if (!existsSync(path)) {
        flags.push(`NO-PAGE ${p.slug}: the row points at ${p.page}, which is not on disk`);
        continue;
      }
      text = readFileSync(path, 'utf8');
      // Throws on a marker shape `current` would also refuse to write into, so sync surfaces it
      // while it is still cheap to fix. Returns null when the page carries no block at all, which
      // is checked below, and the block's own text when there is one.
      block = getCurrentState(text);
    } catch (e) {
      // MALFORMED is "sync has no block it can use here", NO-CURRENT-STATE is "there is no block
      // at all", and the two are never collapsed. Names the file, a human has to go open it.
      // This line quotes a page name back from a pagePath refusal, so it carries hand-editable
      // text. No squash of its own: the report is squashed once where the flags are joined.
      flags.push(`MALFORMED ${p.slug}: ${p.page} cannot be read. ${
        String((e && e.message) || e).replace(/^projects: /, '')}`);
      continue;
    }

    if (text.includes(NARRATIVE_UNWRITTEN)) {
      flags.push(`NARRATIVE-UNWRITTEN ${p.slug}: ${p.page} is still the skeleton, the narrative was never written`);
    }
    // Whitespace between the heading and the marker is absorbed on the next write, but prose
    // between them is not, so the stale heading survives and a second one lands below it. Both
    // match CS_HEADING, /m takes the first, and the date reported here would never move again.
    // Counting catches any page already in that state too.
    const headings = (text.match(CS_HEADING_ALL) || []).length;
    if (headings > 1) {
      // Its own token. Not ORPHANED, which Task 7's migration gate owns, and not MALFORMED: the
      // tokens are independent and both can fire on one page.
      flags.push(`DOUBLE-HEADING ${p.slug}: ${p.page} carries ${plural(headings, 'Current state heading')
        }, so the date read here can be the stale one. Delete the heading with no block under it`);
    }
    // A heading present with nothing usable behind it is the same defect twice over: a date that
    // is not a day, and a date over no block. Either way there is a heading, so NO-CURRENT-STATE
    // would be a lie, and every number for the project is wrong until a human edits the page.
    // MALFORMED at exit 1 for both, ruled 2026-08-03.
    //
    // Deliberately asymmetric with the `last verified` case below, which stays UNVERIFIED at
    // exit 0: that token already means "we do not know when this was verified", so an unusable
    // stamp has somewhere honest to land. A heading date has no such fallback.
    //
    // csDate drops to null in both, so nothing below compares against a date it cannot trust.
    let csDate = currentStateDate(text);
    if (!csDate) {
      flags.push(`NO-CURRENT-STATE ${p.slug}: ${p.page} carries no dated Current state heading`);
    } else if (!isRealDate(csDate)) {
      flags.push(`MALFORMED ${p.slug}: ${p.page} heads its Current state block with ${csDate
        }, which is not a real date, so every date check on this project is off until it is fixed`);
      csDate = null;
    } else if (!block) {
      // `!block` covers two shapes, a heading with no markers under it and a START immediately
      // followed by an END, so the message says "no usable block" rather than "no block": on the
      // empty-block page both markers are there and "no block" would send a human looking for
      // something already in the file. Both wordings executed against both shapes.
      flags.push(`MALFORMED ${p.slug}: ${p.page} carries a Current state heading dated ${csDate
        } with no usable block under it, so there is no status to report`);
      csDate = null;
    }
    // Resolved against the store root, so `--repo ../foo` means the same thing wherever sync was
    // invoked from. The common case is an absolute path, which resolve returns as-is apart from
    // normalising the separators: `C:/dev/beacon` comes back as `C:\dev\beacon`. The flag below
    // still prints p.repo as it was written, since that is the string to fix.
    const repo = p.repo ? resolve(root, p.repo) : null;
    let commitDate = null;
    if (repo && !existsSync(repo)) {
      flags.push(`MISSING-REPO ${p.slug}: the repo path is not there: ${p.repo}`);
    } else if (repo) {
      // Only for a path that is actually there. Asking git about a directory already known to be
      // absent spawns a process to learn nothing.
      commitDate = commitDateFor(repo);
    }
    if (csDate && commitDate) {
      const behind = daysBetween(csDate, commitDate);
      if (behind > 0) {
        flags.push(`STALE ${p.slug}: the status is ${plural(behind, 'day')
          } behind the code (last commit ${commitDate})`);
      }
    }
    const lv = lastVerifiedDate(text);
    if (!lv || !isRealDate(lv)) {
      // Three shapes land here and the claim is true of all three: `last verified never`, which
      // register writes on every skeleton, no stamp at all, and a stamp that is not a real date.
      // Stale from day one on the first: the alternative is a date nobody earned, which would
      // suppress this line for a whole staleness window on the pages that most need it.
      flags.push(`UNVERIFIED ${p.slug}: ${p.page} carries no usable last verified date`);
    } else if (csDate && daysBetween(lv, csDate) > 0) {
      flags.push(`UNVERIFIED ${p.slug}: the narrative was last verified ${lv}, the status has moved on to ${csDate}`);
    }
  }

  const dir = join(root, PROJECTS_DIR);
  // A repo that has never registered anything has no folder, and readdirSync on a missing
  // directory throws an ENOENT that main would report as a bug in this file.
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    // archive/ and _projects.json are not .md, so the extension test drops both.
    if (!f.endsWith('.md') || f === 'INDEX.md' || f === 'CRITIQUES.md') continue;
    if (!pagesInUse.has(f)) flags.push(`NO-ROW ${f}: a page in ${PROJECTS_DIR} with no row pointing at it`);
  }

  // One flag, one line, enforced HERE rather than at each field that interpolates. Flag lines
  // quote hand-editable text, and any line break in it plants a second grep-visible token line
  // under a header still counting one flag. The exit code rides on that: the dispatcher decides it
  // with /^MALFORMED /m. Squashing per field left every sibling open, and every field a later
  // check adds. Squashing the assembled report needs no list of what to guard, and `\s` covers
  // every character /m treats as a line start, not just \n.
  const body = flags.map((f) => f.replace(/\s+/g, ' ')).join('\n');
  return flags.length
    ? `projects sync (${date}): ${flags.length} flagged\n\n${body}\n`
    : `projects sync (${date}): nothing to flag across ${plural(store.projects.length, 'project')}\n`;
}

const builtins = {
  // The slug is validated BEFORE stdin is read. The other way round, `projects current` with
  // no slug sits blocking on a terminal that is never going to send it an EOF.
  current: (root, rest) => {
    validateSlug(rest[0]);
    return cmdCurrent(root, rest, readFileSync(0, 'utf8'));
  },
  status: cmdStatus,
  register: cmdRegister,
  archive: cmdArchive,
  rename: cmdRename,
  set: cmdSet,
  log: cmdLog,
  // cmdSync returns the report rather than printing it, like renderList, so the tests stay
  // quiet and the exit code is decided in one place. A block sync cannot use is a real failure
  // (exit 1), where `list` degrades that row and stays 0. Matched at line start, so a filename
  // or a quoted reason merely containing the word cannot promote a clean report to a failure.
  // That guarantee rests on cmdSync squashing each flag to one line: a newline in a hand-edited
  // slug used to plant a MALFORMED line here and force exit 1 with nothing actually wrong.
  sync: (root, rest) => {
    const out = cmdSync(root, rest);
    process.stdout.write(out);
    if (/^MALFORMED /m.test(out)) process.exit(1);
  },
  list: (root) => process.stdout.write(renderList(root, readStore(root))),
  render: (root) => saveAndRender(root, readStore(root), [], 'projects: re-render index', {}),
  help: () => process.stdout.write(HELP),
  '--help': () => process.stdout.write(HELP),
  '-h': () => process.stdout.write(HELP),
};

const HELP = `projects: portfolio bookkeeping

  projects                     list every project, status and its page's opening line
  projects current <slug>      replace that page's Current state from stdin
  projects status <slug> <s>   set status: active | paused | ops | done
  projects register <slug> --theme T [--name N --status S --where W --repo R]
                               theme: ${THEME_ORDER.join(' | ')}
  projects archive <slug>      move the page to archive/ and drop the row
  projects rename <old> <new>  change a slug, moving its page with it
  projects set <slug> [--name N --where W --repo R --theme T]   change a row's other fields
  projects log [slug] [-n N]   what happened, read from git. A slug follows its page
  projects sync                check every row against reality, reporting and never rewriting
  projects render              re-render INDEX.md from the store

INDEX.md is generated. Never hand-edit it.
`;

// The shapes every intentional throw in this file takes. validateSlug and validateStatus are
// the only two that do not carry the `projects: ` prefix.
const DELIBERATE = /^(projects: |invalid slug|unknown status|unknown theme)/;

export function main(argv = process.argv.slice(2)) {
  const root = resolveRoot();
  const [cmd, ...rest] = argv;
  try {
    if (!cmd) return builtins.list(root, []);
    // hasOwn, not truthiness: `builtins.constructor` and `builtins.toString` resolve up the
    // prototype chain, so `projects constructor` ran a function that is not a verb and exited 0.
    // An agent reads exit 0 as the command having worked.
    if (!Object.hasOwn(builtins, cmd)) {
      console.error(`projects: unknown command "${cmd}"\n\n${HELP}`);
      process.exit(2);
    }
    return builtins[cmd](root, rest);
  } catch (e) {
    const message = (e && e.message) || String(e);
    // Every deliberate refusal in this file carries a message we wrote. Anything else is a bug
    // HERE, and printing only its one-line message throws the stack away, which is how a typo
    // becomes an unexplained exit 1. A real bug gets to be loud.
    if (!DELIBERATE.test(message)) {
      console.error('projects: internal error, this is a bug in projects.mjs');
      console.error((e && e.stack) || message);
      process.exit(1);
    }
    console.error(message);
    // 2 is "you asked for something that is not a thing", 1 is "the operation failed".
    // A refused page write is a 1: the request was valid, the file on disk is not.
    // `Migrate it first` rides along here rather than in a code on the error, because classifying by
    // message fragment is what this function already does and one more fragment is less machinery
    // than a second convention. An unmigrated root is an environment problem, so 2.
    // No `unknown command` fragment: that branch above exits directly and never throws.
    // `is required` is the same class as `was given`: an invocation missing a required field is a
    // malformed command, not a failed operation, and without it ONE user mistake exits two
    // different ways depending on argv shape (`register demo --theme --name X` throws
    // `was given` → 2, `register demo` with no --theme at all → 1).
    process.exit(/unknown status|unknown theme|unknown project|invalid slug|was given|is required|no page|Migrate it first/.test(message) ? 2 : 1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('projects.mjs')) main();
