// A project's page: the one guarded path to it, the Current state block this CLI owns inside
// it, and the no-args list that tails each row with that block's first line. Split out of
// projects.mjs (#37), code unchanged.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECTS_DIR, groupByTheme, sortProjects, validateTheme } from './render.mjs';

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

// `page` comes out of a hand-editable record file, so it is exactly as untrusted as a slug.
// One guard at the single choke point covers every verb: this is the only way any of them
// names a page file. Without it `page: "../../secrets.md"` lets cmdCurrent overwrite and
// cmdArchive MOVE a file anywhere in the tree.
export function pagePath(root, page) {
  if (typeof page !== 'string' || !/^[A-Za-z0-9_.-]+\.md$/.test(page) || page.includes('..')) {
    throw new Error(`projects: refusing a page path outside ${PROJECTS_DIR} ("${page}")`);
  }
  return join(root, PROJECTS_DIR, page);
}

// ── renderList: the no-args print ────────────────────────────────────────────────────
// One numbered row per project, grouped into theme sections, status order within a section,
// each row tailed by its page's Current state opening line.
//
// The tail is unchanged from the old inline body, extracted so renderList reads as grouping
// rather than as row building and so the filter has one row shape to produce. Read-only:
// nothing here is written to disk, so a bad page must degrade its own row, never the command.
// The try/catch is per row and not around the loop, so a single malformed page cannot blank
// out every row after it.
function listTail(root, p) {
  if (!p.page) return '(no page)';
  try {
    // pagePath, not a bare join: `page` comes out of a hand-editable record file, so
    // `page: "../../.ssh/config"` would otherwise make the no-args list READ a file outside
    // docs/projects. Inside the try on purpose, so the refusal degrades this one row to
    // MALFORMED like any other unreadable page and every other row still prints.
    const path = pagePath(root, p.page);
    return existsSync(path)
      ? currentStateFirstLine(readFileSync(path, 'utf8')) ?? '(no current state)'
      : '(page missing)';
  } catch {
    // currentStateFirstLine throws on markers that are missing-but-stray, reversed, or
    // duplicated, a deliberate refusal to guess (see locateBlock), and pagePath throws on a
    // page name that escapes the folder. A read must never lie about what is on disk, so the
    // row says MALFORMED rather than guessing or being dropped.
    return 'MALFORMED';
  }
}

// `theme` null lists everything grouped. A theme lists only that section, still under its
// heading, so there is one code path and the reader always knows what they are looking at.
export function renderList(root, store, theme = null) {
  if (theme !== null) validateTheme(theme);
  const rows = theme === null
    ? store.projects
    : store.projects.filter((p) => p.theme === theme);
  if (!rows.length) {
    // Distinct messages: an empty filter is a true answer about one theme, an empty store is
    // a different fact, and reporting the first as the second reads as a broken command.
    return theme === null ? 'No registered projects.\n' : `No projects under ${theme}.\n`;
  }
  const out = [];
  let n = 0;
  // Empty sections are dropped HERE, as groupByTheme's contract requires of every caller, so
  // this view and renderIndex agree on which sections exist.
  for (const [label, group] of groupByTheme(sortProjects(rows))) {
    if (!group.length) continue;
    // Squashed for the same reason every row is: an unrecognised theme titles its section with
    // its own raw value straight out of the hand-editable store, so a line break in it forged a
    // numbered row through the HEADING rather than through a row.
    out.push(`${String(label).replace(/\s+/g, ' ')}:`);
    for (const p of group) {
      // The slug is in the row because every mutating verb takes it and the skill is
      // forbidden to read the store to find it. Squashed once on the ASSEMBLED row, the same
      // shape as the sync report's join: the row interpolates raw store fields, and a line
      // break in any of them printed an extra numbered row carrying whatever tokens the
      // author of the store chose. `\s` covers every character /m treats as a line start.
      //
      // The indent is prefixed OUTSIDE the squash: inside it, /\s+/g would collapse the two
      // leading spaces along with everything else and the row would carry a one-space indent
      // nobody asked for.
      out.push('  ' + `${++n}. ${p.name} [${p.slug}] (${p.status}): ${listTail(root, p)}`
        .replace(/\s+/g, ' '));
    }
  }
  return out.join('\n') + '\n';
}
