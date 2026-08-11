import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStore, writeStore, validateStatus, validateSlug, sortProjects, commit, resolveRoot, today, REL_STORE, STATUSES, renderIndex, parseIndex, assertRenderable, THEMES, THEME_ORDER, validateTheme } from '../skills/projects/projects.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'projects-test-'));
  mkdirSync(join(root, 'docs/projects'), { recursive: true });
  return root;
}

// `git init` gives the fixture its OWN index, so no git call below can reach the home
// repo's shared index even though os.tmpdir() sits inside that repo.
function gitFixture() {
  const root = fixture();
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'projects test');
  return { root, git };
}

test('store round-trips identically', () => {
  const root = fixture();
  const store = { version: 1, projects: [
    { slug: 'price-alerts', name: 'price-alerts', status: 'active', where: ['C:/dev/price-alerts'],
      repo: 'C:/dev/price-alerts', page: 'price-alerts.md', lastTouched: '2026-07-29' },
  ] };
  writeStore(root, store);
  assert.deepEqual(readStore(root), store);
});

test('readStore returns an empty store when the file is absent', () => {
  assert.deepEqual(readStore(fixture()), { version: 1, projects: [] });
});

test('status accepts the four words and rejects everything else', () => {
  for (const s of ['active', 'paused', 'ops', 'done']) assert.equal(validateStatus(s), s);
  for (const bad of ['running', 'building', '🟢 active', 'Active', '']) {
    assert.throws(() => validateStatus(bad), /unknown status/);
  }
});

test('slug rejects anything that could escape a path', () => {
  assert.equal(validateSlug('price-alerts'), 'price-alerts');
  for (const bad of ['../etc', 'a/b', 'a b', '', 'a.md']) {
    assert.throws(() => validateSlug(bad), /invalid slug/);
  }
});

test('sort is status rank, then lastTouched desc, then slug', () => {
  const p = (slug, status, lastTouched) => ({ slug, status, lastTouched });
  const sorted = sortProjects([
    p('zeta', 'paused', '2026-07-29'), p('alpha', 'active', '2026-07-01'),
    p('beta', 'ops', '2026-07-29'), p('gamma', 'active', '2026-07-29'),
    p('delta', 'active', '2026-07-29'),
  ]).map(x => x.slug);
  assert.deepEqual(sorted, ['delta', 'gamma', 'alpha', 'beta', 'zeta']);
});

test('sort survives a hand-edited entry with no lastTouched', () => {
  const sorted = sortProjects([
    { slug: 'nodate', status: 'active' },
    { slug: 'dated', status: 'active', lastTouched: '2026-07-29' },
  ]).map(x => x.slug);
  assert.deepEqual(sorted, ['dated', 'nodate']);
});

test('an unrecognised status sorts last, never ahead of active', () => {
  const sorted = sortProjects([
    { slug: 'typo', status: 'Active', lastTouched: '2026-07-29' },
    { slug: 'real', status: 'active', lastTouched: '2026-07-29' },
    { slug: 'finished', status: 'done', lastTouched: '2026-07-29' },
  ]).map(x => x.slug);
  assert.deepEqual(sorted, ['real', 'finished', 'typo']);
});

test('STATUSES maps every word to a rendered form', () => {
  assert.deepEqual(Object.keys(STATUSES), ['active', 'ops', 'paused', 'done']);
  assert.match(STATUSES.active, /active/);
});

test('PROJECTS_ROOT overrides git discovery', () => {
  // This override is what keeps tests off the live repo, so it has to hold.
  const orig = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = 'C:/nowhere/at/all';
  try {
    assert.equal(resolveRoot(), 'C:/nowhere/at/all');
  } finally {
    if (orig === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = orig;
  }
});

test('today is an ISO date, so string compare sorts it chronologically', () => {
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
});

test('commit takes only the named paths, not a concurrent session\'s staged work', () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, REL_STORE), '{"version":1,"projects":[]}\n');
  writeFileSync(join(root, 'other.md'), 'another session was mid-edit\n');
  git('add', 'other.md'); // the other session stages its work into the shared index

  assert.equal(commit(root, [REL_STORE], 'store'), true);
  const committed = git('show', '--name-only', '--format=', 'HEAD').toString().trim().split('\n');
  assert.deepEqual(committed, [REL_STORE], 'other.md must not ride along in our commit');

  // Nothing changed since, so this is an empty commit: swallowed as success.
  assert.equal(commit(root, [REL_STORE], 'store again'), true);
});

test('commit with no paths creates nothing and leaves the index alone', () => {
  // Callers build `paths` conditionally, so [] is an ordinary outcome. Without the
  // guard, a bare `git add` exits 0 and the commit runs with no pathspec after `--`,
  // sweeping the WHOLE shared index — verified: it committed the sibling file.
  const { root, git } = gitFixture();
  writeFileSync(join(root, 'README.md'), 'base\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'base');
  const before = git('rev-parse', 'HEAD').toString().trim();

  writeFileSync(join(root, 'other.md'), 'another session was mid-edit\n');
  git('add', 'other.md'); // a concurrent session's staged work

  assert.equal(commit(root, [], 'nothing asked for'), true);
  assert.equal(git('rev-parse', 'HEAD').toString().trim(), before, 'no commit may be created');
  assert.equal(git('diff', '--cached', '--name-only').toString().trim(), 'other.md',
    "the other session's staged work must be left untouched");
});

test('a real git failure returns false and says the files are uncommitted', () => {
  // cwd does not exist, so execFileSync fails for a reason that is NOT
  // "nothing to commit". That must never be reported as success.
  // ⚠ Do NOT use a tmpdir as the cwd here: os.tmpdir() on this machine is
  // C:\Users\you\AppData\Local\Temp, which is INSIDE the home repo, so
  // `git add` would stage files into the real shared index.
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    assert.equal(commit(join(tmpdir(), 'projects-no-such-dir-9f3a'), ['x.md'], 'nope'), false);
  } finally { console.error = orig; }
  assert.match(errs.join('\n'), /on disk but uncommitted/);
});

const SAMPLE = { version: 1, projects: [
  { slug: 'beacon', name: 'Beacon', status: 'active', where: ['C:/dev/beacon', 'skill dir'],
    repo: 'C:/dev/beacon', page: 'beacon.md', lastTouched: '2026-07-29' },
  // ops and done are here so all four words round-trip through RENDERED_TO_WORD, not just
  // the two the brief happened to sample. Listed in sortProjects order, since the round-trip
  // assertion compares against the rendered order. A separate test pins the sort itself.
  { slug: 'obelisk', name: 'Obelisk', status: 'ops', where: ['Obelisk'],
    page: 'obelisk.md', lastTouched: '2026-07-27' },
  { slug: 'fw16', name: 'Framework 16 Stutter', status: 'paused', where: ['home checkout'],
    page: null, lastTouched: '2026-07-28' },
  { slug: 'optin', name: 'OptIn Pipeline', status: 'done', where: [],
    page: null, lastTouched: '2026-07-16' },
] };

// Only the fields the table carries. `repo` is deliberately absent from the render, so
// the round-trip cannot recover it — it is a checkable path for `sync`, not display data.
const mechanical = (p) => ({ name: p.name, status: p.status, where: p.where,
  lastTouched: p.lastTouched, page: p.page });

test('render then parse returns the same mechanical fields', () => {
  const parsed = parseIndex(renderIndex(SAMPLE));
  assert.deepEqual(parsed.projects.map(mechanical), SAMPLE.projects.map(mechanical));
});

test('render is byte-stable — re-rendering the same store is a no-op', () => {
  assert.equal(renderIndex(SAMPLE), renderIndex(SAMPLE));
  assert.equal(renderIndex(parseIndex(renderIndex(SAMPLE))), renderIndex(SAMPLE));
});

test('render has no Next column and carries the generated header', () => {
  const out = renderIndex(SAMPLE);
  assert.match(out, /\| Project \| Status \| Where \| Last touched \|/);
  assert.doesNotMatch(out, /\| Next \|/);
  assert.match(out, /generated/i);
  assert.match(out, /projects current/);
});

test('a pageless project renders as plain text, a paged one as a link', () => {
  const out = renderIndex(SAMPLE);
  assert.match(out, /\| \[Beacon\]\(beacon\.md\) \|/);
  assert.match(out, /\| Framework 16 Stutter \|/);
});

test('where is joined with a middot', () => {
  assert.match(renderIndex(SAMPLE), /C:\/dev\/beacon · skill dir/);
});

test('a pipe in any field is refused rather than corrupting the table', () => {
  assert.throws(() => assertRenderable({ slug: 'x', name: 'a|b', status: 'active',
    where: [], lastTouched: '2026-07-29' }), /pipe/);
  assert.throws(() => assertRenderable({ slug: 'x', name: 'ok', status: 'active',
    where: ['a|b'], lastTouched: '2026-07-29' }), /pipe/);
});

test('a newline in any field is refused: it would forge a whole extra row', () => {
  for (const bad of ['a\nb', 'a\rb']) {
    assert.throws(() => assertRenderable({ slug: 'x', name: bad, status: 'active',
      where: [], lastTouched: '2026-07-29' }), /line break/);
    assert.throws(() => assertRenderable({ slug: 'x', name: 'ok', status: 'active',
      where: [bad], lastTouched: '2026-07-29' }), /line break/);
  }
});

test('an empty store round-trips to no projects at all', () => {
  const out = renderIndex({ version: 1, projects: [] });
  assert.deepEqual(parseIndex(out).projects, []);
  assert.equal(renderIndex(parseIndex(out)), out);
});

test('a pageless project named "Project ..." survives instead of being eaten as the header', () => {
  // Its row is `| Project Atlas | 🟢 active | … |`, which a startsWith('| Project') skip
  // swallowed silently. A paged project was unaffected, so the loss was inconsistent too.
  const store = { version: 1, projects: [
    { slug: 'project-atlas', name: 'Project Atlas', status: 'active', where: [],
      page: null, lastTouched: '2026-07-29' },
  ] };
  assert.deepEqual(parseIndex(renderIndex(store)).projects.map(mechanical),
    store.projects.map(mechanical));
});

test('a malformed short row and a spaced separator row are both skipped', () => {
  // `| foo |` would alias label and the last cell, parsing status undefined; the spaced
  // separator would parse as a project named "---".
  assert.deepEqual(parseIndex('| foo |').projects, []);
  assert.deepEqual(parseIndex('| --- | --- | --- | --- |').projects, []);
  assert.deepEqual(parseIndex('| :--- | ---: | :---: | --- |').projects, []);
});

test('a missing lastTouched renders an empty cell, not the string "undefined"', () => {
  const out = renderIndex({ version: 1, projects: [
    { slug: 'x', name: 'X', status: 'active', where: [], page: null },
  ] });
  assert.doesNotMatch(out, /undefined/);
  assert.match(out, /^\| X \| 🟢 active \|  \|  \|$/m);
});

test('an off-list status fails loudly at render time, not as a blank cell', () => {
  assert.throws(() => renderIndex({ version: 1, projects: [
    { slug: 'x', name: 'X', status: 'building', where: [], page: null, lastTouched: '2026-07-29' },
  ] }), /unknown status/);
});

test('parse reads the date from the last cell, so the legacy 5-column row migrates', () => {
  // The hand-typed INDEX.md had `Project | Status | Where | Next | Last touched`. Reading
  // position 4 would store the Next prose as lastTouched and lose the date.
  const [p] = parseIndex('| [A](a.md) | 🟢 active | home | ship the thing | 2026-07-29 |').projects;
  assert.equal(p.lastTouched, '2026-07-29');
  assert.deepEqual(p.where, ['home']);
});

test('rendered rows are ordered by sortProjects, not store order', () => {
  const rows = renderIndex({ version: 1, projects: [
    { slug: 'b', name: 'Bee', status: 'done', where: [], page: null, lastTouched: '2026-07-29' },
    { slug: 'a', name: 'Ay', status: 'active', where: [], page: null, lastTouched: '2026-07-01' },
  ] }).split('\n').filter(l => /^\| (Ay|Bee) /.test(l));
  assert.deepEqual(rows.map(l => l.split('|')[1].trim()), ['Ay', 'Bee']);
});

import { setCurrentState, getCurrentState, currentStateFirstLine, CS_START, CS_END, NARRATIVE_UNWRITTEN } from '../skills/projects/projects.mjs';

const PAGE = `# Beacon
*last verified 2026-07-25 · 🟢 active · docs: none*

Narrative paragraph one.

Narrative paragraph two.

## Future Directions
- something long-horizon

## Docs map
links
`;

test('inserts the block before Future Directions and leaves the narrative byte-identical', () => {
  const out = setCurrentState(PAGE, 'First body.', '2026-07-29');
  assert.match(out, /## Current state \(2026-07-29\)/);
  assert.match(out, /Narrative paragraph one\.\n\nNarrative paragraph two\./);
  assert.ok(out.indexOf('## Current state') < out.indexOf('## Future Directions'));
  assert.match(out, /- something long-horizon/);
  assert.match(out, /## Docs map/);
});

test('a second write REPLACES rather than appends, one block, second body only', () => {
  const once = setCurrentState(PAGE, 'First body.', '2026-07-29');
  const twice = setCurrentState(once, 'Second body.', '2026-07-30');
  assert.equal(twice.match(/## Current state/g).length, 1);
  assert.equal(twice.match(new RegExp(CS_START, 'g')).length, 1);
  assert.match(twice, /Second body\./);
  assert.doesNotMatch(twice, /First body\./);
  assert.match(twice, /## Current state \(2026-07-30\)/);
});

test('a body containing ## subheadings survives replacement intact', () => {
  const body = 'Lead line.\n\n## Not a real section\n\n- bullet\n\n## Another\n\ntail';
  const once = setCurrentState(PAGE, body, '2026-07-29');
  assert.equal(getCurrentState(once), body);
  const twice = setCurrentState(once, 'replaced', '2026-07-30');
  assert.equal(getCurrentState(twice), 'replaced');
  assert.doesNotMatch(twice, /Not a real section/);
  assert.match(twice, /## Future Directions/);
});

test('appends when the page has no Future Directions heading', () => {
  const out = setCurrentState('# Bare\n\nJust narrative.\n', 'body', '2026-07-29');
  assert.match(out, /Just narrative\./);
  assert.match(out, /## Current state \(2026-07-29\)/);
});

test('getCurrentState returns null when there is no block', () => {
  assert.equal(getCurrentState(PAGE), null);
  assert.equal(currentStateFirstLine(PAGE), null);
});

test('firstLine takes the opening prose line, stripped of bullet and bold markup', () => {
  const out = setCurrentState(PAGE, '**Next:** push to Forgejo.\n\nmore detail', '2026-07-29');
  assert.equal(currentStateFirstLine(out), 'Next: push to Forgejo.');
  const bul = setCurrentState(PAGE, '- first bullet\n- second', '2026-07-29');
  assert.equal(currentStateFirstLine(bul), 'first bullet');
});

// ── Destructive edges. The page around the block is hand-written and cannot be
// regenerated, so every ambiguous shape below must refuse rather than pick a boundary.

test('replacement rewrites the block and nothing else, byte for byte', () => {
  // The strongest statement of the invariant: whatever the diff looks like, the text above
  // the heading and below the end marker is the SAME STRING before and after.
  const once = setCurrentState(PAGE, 'First body.', '2026-07-29');
  const twice = setCurrentState(once, 'Second body.', '2026-07-30');
  const above = (t) => t.slice(0, t.indexOf('## Current state'));
  const below = (t) => t.slice(t.indexOf(CS_END) + CS_END.length);
  assert.equal(above(twice), above(once));
  assert.equal(below(twice), below(once));
});

test('a start marker with no end marker is refused, never repaired by guessing', () => {
  const orphan = `# P\n\nnarrative\n\n## Current state (2026-07-29)\n${CS_START}\nbody\n\n## Future Directions\n- x\n`;
  assert.throws(() => setCurrentState(orphan, 'new', '2026-07-30'), /will not guess/);
  assert.throws(() => getCurrentState(orphan), /will not guess/);
  assert.throws(() => currentStateFirstLine(orphan), /will not guess/);
});

test('a stray end marker with no start marker is refused', () => {
  const stray = `# P\n\nnarrative\n${CS_END}\n\n## Future Directions\n- x\n`;
  assert.throws(() => setCurrentState(stray, 'new', '2026-07-30'), /will not guess/);
  assert.throws(() => getCurrentState(stray), /will not guess/);
});

test('markers in the wrong order are refused rather than duplicating the page', () => {
  // The naive slice for this shape emits slice(0, start) + block + slice(after end), which
  // repeats every byte between the two markers instead of replacing anything.
  const reversed = `# P\n\n${CS_END}\nnarrative worth keeping\n${CS_START}\n\n## Future Directions\n`;
  assert.throws(() => setCurrentState(reversed, 'new', '2026-07-30'), /before the start marker/);
  assert.throws(() => getCurrentState(reversed), /before the start marker/);
});

test('duplicated or nested marker pairs are refused', () => {
  const twoBlocks = `# P\n\n## Current state (2026-07-01)\n${CS_START}\nold\n${CS_END}\n\n`
    + `## Current state (2026-07-02)\n${CS_START}\nnewer\n${CS_END}\n\n## Future Directions\n`;
  assert.throws(() => setCurrentState(twoBlocks, 'new', '2026-07-30'), /exactly one of each/);
  const nested = `# P\n\n${CS_START}\nouter\n${CS_START}\ninner\n${CS_END}\nrest\n${CS_END}\n`;
  assert.throws(() => setCurrentState(nested, 'new', '2026-07-30'), /exactly one of each/);
  assert.throws(() => getCurrentState(nested), /exactly one of each/);
});

test('a body carrying a real marker is refused, a lookalike passes through', () => {
  // A body that smuggles in a marker makes the NEXT write see three markers, and from then
  // on the page can only be repaired by hand. Refuse at the point the corruption enters.
  assert.throws(() => setCurrentState(PAGE, `done\n${CS_END}\nsneaky`, '2026-07-29'),
    /carries a Current state marker/);
  assert.throws(() => setCurrentState(PAGE, `${CS_START} done`, '2026-07-29'),
    /carries a Current state marker/);
  // The match is exact, not fuzzy: prose that merely resembles a marker is ordinary text.
  const lookalike = '<!-- projects:current-state:starting -->';
  const out = setCurrentState(PAGE, `see ${lookalike}`, '2026-07-29');
  assert.equal(getCurrentState(out), `see ${lookalike}`);
});

test('a body containing its own Current state heading does not confuse replacement', () => {
  const body = '## Current state (2020-01-01)\n\nquoted from an old page';
  const once = setCurrentState(PAGE, body, '2026-07-29');
  assert.equal(getCurrentState(once), body);
  const twice = setCurrentState(once, 'replaced', '2026-07-30');
  assert.equal(getCurrentState(twice), 'replaced');
  assert.equal(twice.match(/## Current state/g).length, 1);
  assert.match(twice, /## Current state \(2026-07-30\)/);
  assert.doesNotMatch(twice, /2020-01-01/);
});

test('a block whose own heading was hand-deleted does not eat the heading above it', () => {
  // Cutting back to the nearest "## " above the start marker would delete ## Overview and
  // the paragraph under it. Only a Current state heading directly above the marker is ours.
  const page = `# P\n\n## Overview\n\nnarrative that cannot be regenerated\n\n`
    + `${CS_START}\nstale\n${CS_END}\n\n## Future Directions\n- x\n`;
  const out = setCurrentState(page, 'fresh', '2026-07-30');
  assert.match(out, /## Overview\n\nnarrative that cannot be regenerated/);
  assert.equal(getCurrentState(out), 'fresh');
  assert.doesNotMatch(out, /stale/);
  assert.match(out, /## Current state \(2026-07-30\)/);
});

test('an empty page takes the block cleanly, with no leading blank lines', () => {
  // A skeleton page with nothing in it yet destroys no narrative, so this passes through.
  assert.equal(setCurrentState('', 'body', '2026-07-29'),
    `## Current state (2026-07-29)\n${CS_START}\nbody\n${CS_END}\n`);
  assert.equal(setCurrentState('\n\n', 'body', '2026-07-29'),
    `## Current state (2026-07-29)\n${CS_START}\nbody\n${CS_END}\n`);
});

test('an empty body is refused: an empty block reads as a real status to sync', () => {
  for (const bad of ['', '   \n\t ', undefined, null]) {
    assert.throws(() => setCurrentState(PAGE, bad, '2026-07-29'), /empty body/);
  }
});

test('a date that is not YYYY-MM-DD is refused', () => {
  // sync reads the heading with /^## Current state \((\d{4}-\d\d-\d\d)\)/m, so any other
  // shape writes a block that is permanently invisible to it.
  for (const bad of [undefined, '', '29 Jul 2026', '2026-7-9', '2026-07-29)\n## Injected']) {
    assert.throws(() => setCurrentState(PAGE, 'body', bad), /YYYY-MM-DD/);
  }
});

test('a blank line between the heading and the start marker still absorbs the heading', () => {
  // Any markdown formatter that separates block elements puts a blank line here. Requiring
  // the heading to be the last thing before the marker means it is not absorbed, the stale
  // heading survives, and a second one is written below it. sync reads the FIRST heading, so
  // the project would report the old date forever with a current block underneath, and no
  // later write self-corrects because each one absorbs only the second heading.
  const page = `# P\n\nnarrative that cannot be regenerated\n\n`
    + `## Current state (2026-07-01)\n\n${CS_START}\nstale\n${CS_END}\n\n## Future Directions\n- x\n`;
  const out = setCurrentState(page, 'fresh', '2026-07-30');
  assert.equal(out.match(/## Current state/g).length, 1);
  assert.match(out, /## Current state \(2026-07-30\)/);
  assert.doesNotMatch(out, /2026-07-01/);
  assert.doesNotMatch(out, /stale/);
  assert.match(out, /narrative that cannot be regenerated/);
  assert.equal(getCurrentState(out), 'fresh');
});

test('a renamed Current state heading is still ours and is still absorbed', () => {
  const page = `# P\n\nnarrative\n\n## Current state and next steps\n`
    + `${CS_START}\nstale\n${CS_END}\n\n## Future Directions\n- x\n`;
  const out = setCurrentState(page, 'fresh', '2026-07-30');
  assert.equal(out.match(/## Current state/g).length, 1);
  assert.match(out, /## Current state \(2026-07-30\)/);
  assert.doesNotMatch(out, /and next steps/);
});

test('an unrelated same-prefix heading above an orphaned marker survives untouched', () => {
  // The heading match is a word-boundary match, not a prefix match: "statement" is not
  // "state". Absorbing it would delete a hand-written heading, which is the one thing this
  // code may never do. Nothing is absorbed here, so a fresh heading is written above the
  // marker instead, which repairs the page rather than cutting it.
  const page = `# P\n\n## Current statement of work\n\n${CS_START}\nstale\n${CS_END}\n\n## Future Directions\n- x\n`;
  const out = setCurrentState(page, 'fresh', '2026-07-30');
  assert.match(out, /## Current statement of work/);
  assert.match(out, /## Current state \(2026-07-30\)/);
  assert.equal(getCurrentState(out), 'fresh');
  assert.doesNotMatch(out, /stale/);
});

test('a CRLF page keeps its narrative and gets exactly one heading', () => {
  // Pins today's behaviour, it does not ask for it: the heading is absorbed because [^\n]*
  // swallows the \r, and the block itself is written with \n, so the file ends up with mixed
  // endings. Harmless in markdown. Line-ending normalisation is nobody's job in this task.
  const crlf = ['# P', '', 'narrative that cannot be regenerated', '',
    '## Current state (2026-07-01)', CS_START, 'stale', CS_END, '',
    '## Future Directions', '- x', ''].join('\r\n');
  const out = setCurrentState(crlf, 'fresh', '2026-07-30');
  assert.equal(out.match(/## Current state/g).length, 1);
  assert.match(out, /## Current state \(2026-07-30\)/);
  assert.doesNotMatch(out, /2026-07-01/);
  assert.equal(getCurrentState(out), 'fresh');
  assert.ok(out.includes('narrative that cannot be regenerated\r\n'), 'CRLF narrative survives');
  assert.ok(out.includes(`## Current state (2026-07-30)\n${CS_START}\nfresh\n${CS_END}`),
    'the block is written with \\n into a \\r\\n page, so endings are mixed');
});

test('a non-string page is refused with a message that names the argument', () => {
  for (const bad of [undefined, null, 42, {}, ['# P']]) {
    assert.throws(() => setCurrentState(bad, 'body', '2026-07-30'), /page text must be a string/);
    assert.throws(() => getCurrentState(bad), /page text must be a string/);
    assert.throws(() => currentStateFirstLine(bad), /page text must be a string/);
  }
  // A refusal writes nothing anywhere: the good page is byte-identical afterwards.
  const before = PAGE;
  assert.throws(() => setCurrentState(undefined, 'body', '2026-07-30'), /page text must be a string/);
  assert.equal(PAGE, before);
});

test('the unwritten-narrative sentinel is a comment, invisible in rendered markdown', () => {
  assert.match(NARRATIVE_UNWRITTEN, /^<!--.*-->$/);
  assert.match(NARRATIVE_UNWRITTEN, /narrative-unwritten/);
});

// ── renderList: the no-args print ────────────────────────────────────────────────────
import { renderList } from '../skills/projects/projects.mjs';

test('list prints numbered rows in status order with the page opening line', () => {
  const root = fixture();
  writeFileSync(join(root, 'docs/projects/beacon.md'),
    setCurrentState('# Beacon\n\nnarrative\n\n## Future Directions\n- x\n',
      'Build the SuccessFactors adapter.', '2026-07-29'));
  writeFileSync(join(root, 'docs/projects/gtg.md'), '# gtg\n\nnarrative only\n');
  const store = { version: 1, projects: [
    { slug: 'gtg', name: 'gtg', status: 'paused', where: [], page: 'gtg.md', lastTouched: '2026-07-27' },
    { slug: 'beacon', name: 'Beacon', status: 'active', where: [], page: 'beacon.md', lastTouched: '2026-07-29' },
  ] };
  const out = renderList(root, store);
  const lines = out.split('\n').filter(Boolean);
  assert.match(lines[0], /1\. Beacon \[beacon\] \(active\): Build the SuccessFactors adapter\./);
  assert.match(lines[1], /2\. gtg \[gtg\] \(paused\): \(no current state\)/);
});

test('list says so when there are no projects', () => {
  assert.match(renderList(fixture(), { version: 1, projects: [] }), /No registered projects/);
});

test('a pageless project prints (no page) rather than being skipped', () => {
  const out = renderList(fixture(), { version: 1, projects: [
    { slug: 'fw16', name: 'FW16', status: 'paused', where: [], page: null, lastTouched: '2026-07-28' }] });
  assert.match(out, /1\. FW16 \[fw16\] \(paused\): \(no page\)/);
});

test('a page that throws is rendered as MALFORMED, and the other rows still print', () => {
  const root = fixture();
  // A start marker with no matching end marker throws inside currentStateFirstLine.
  writeFileSync(join(root, 'docs/projects/bad.md'),
    `# Bad\n\nnarrative\n\n## Current state (2026-07-29)\n${CS_START}\nstuck\n\n## Future Directions\n- x\n`);
  writeFileSync(join(root, 'docs/projects/good.md'),
    setCurrentState('# Good\n\nnarrative\n\n## Future Directions\n- x\n', 'All fine.', '2026-07-29'));
  const store = { version: 1, projects: [
    { slug: 'bad', name: 'Bad', status: 'active', where: [], page: 'bad.md', lastTouched: '2026-07-29' },
    { slug: 'good', name: 'Good', status: 'active', where: [], page: 'good.md', lastTouched: '2026-07-28' },
  ] };
  const out = renderList(root, store);
  assert.match(out, /1\. Bad \[bad\] \(active\): MALFORMED/);
  assert.match(out, /2\. Good \[good\] \(active\): All fine\./);
});

test('a page file missing from disk prints (page missing), distinct from (no page)', () => {
  const out = renderList(fixture(), { version: 1, projects: [
    { slug: 'ghost', name: 'Ghost', status: 'paused', where: [], page: 'ghost.md', lastTouched: '2026-07-28' }] });
  assert.match(out, /1\. Ghost \[ghost\] \(paused\): \(page missing\)/);
});

test('a page with narrative but no Current state block prints (no current state)', () => {
  const root = fixture();
  writeFileSync(join(root, 'docs/projects/plain.md'), '# Plain\n\nJust narrative, no block.\n');
  const out = renderList(root, { version: 1, projects: [
    { slug: 'plain', name: 'Plain', status: 'ops', where: [], page: 'plain.md', lastTouched: '2026-07-28' }] });
  assert.match(out, /1\. Plain \[plain\] \(ops\): \(no current state\)/);
});

test('a page field that escapes docs/projects is never read, and the other rows still print', () => {
  // _projects.json is hand-editable, so `page` is as untrusted here as it is in the mutating
  // verbs. Bare `projects` with no args is the widest surface in the CLI, and before this went
  // through pagePath a row reading `page: "../../.ssh/config"` printed that file's contents.
  const root = fixture();
  writeFileSync(join(root, 'secret.md'),
    setCurrentState('# Secret\n\nnot a project page\n', 'SUPERSECRET leaked.', '2026-07-29'));
  writeFileSync(join(root, 'docs/projects/good.md'),
    setCurrentState('# Good\n\nnarrative\n\n## Future Directions\n- x\n', 'All fine.', '2026-07-29'));
  const out = renderList(root, { version: 1, projects: [
    { slug: 'escape', name: 'Escape', status: 'active', where: [], page: '../../secret.md',
      lastTouched: '2026-07-29' },
    { slug: 'good', name: 'Good', status: 'active', where: [], page: 'good.md',
      lastTouched: '2026-07-28' },
  ] });
  assert.doesNotMatch(out, /SUPERSECRET/, 'the escaping row must not read outside docs/projects');
  assert.match(out, /1\. Escape \[escape\] \(active\): MALFORMED/, 'it degrades like any unreadable page');
  assert.match(out, /2\. Good \[good\] \(active\): All fine\./, 'and every other row still prints');
});

// ── The mutating verbs ───────────────────────────────────────────────────────────────
// Everything below writes to disk. Two rules hold in every test here:
//   1. PROJECTS_ROOT is passed explicitly per invocation. os.tmpdir() on this machine is
//      C:\Users\you\AppData\Local\Temp, which sits INSIDE the home repo, so a root
//      resolved by git rather than by the env var would write into the LIVE docs/projects.
//   2. Anything that can reach git runs in a gitFixture, whose own .git keeps `git add`
//      away from the shared index every concurrent session is staging into.
import { cmdCurrent, cmdStatus, cmdRegister, cmdArchive, findProject, REL_INDEX } from '../skills/projects/projects.mjs';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// RENDERED and ARCHIVED are the machine surface the skill greps, so they are real output
// rather than debug noise. Captured rather than left to scatter bare through the test run, and
// captured PER TEST: the patch used to be installed at module scope and never restored, which
// silenced console.log for all 77 tests, including every test that has nothing to do with
// markers. `capture` always puts the console back, even when the body throws.
function capture(fn) {
  const orig = console.log;
  const marks = [];
  console.log = (m) => marks.push(String(m));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return marks;
}

// `test`, for the mutating tests below whose verbs print a marker. Output is captured and
// discarded, the console is restored, and nothing leaks into the run.
const mtest = (name, fn) => test(name, () => capture(fn));

function seeded() {
  const root = fixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'beacon', name: 'Beacon', status: 'active', where: ['C:/dev/beacon'],
      repo: 'C:/dev/beacon', page: 'beacon.md', lastTouched: '2026-07-20' }] });
  writeFileSync(join(root, 'docs/projects/beacon.md'),
    '# Beacon\n\nnarrative\n\n## Future Directions\n- x\n');
  return root;
}

mtest('current writes the body to the page and bumps lastTouched', () => {
  const root = seeded();
  cmdCurrent(root, ['beacon'], 'Shipped the reach overhaul.', { commit: false, date: '2026-07-29' });
  const page = readFileSync(join(root, 'docs/projects/beacon.md'), 'utf8');
  assert.match(page, /Shipped the reach overhaul\./);
  assert.match(page, /## Current state \(2026-07-29\)/);
  assert.equal(findProject(readStore(root), 'beacon').lastTouched, '2026-07-29');
  assert.match(page, /narrative/);
});

test('current refuses an unknown slug with exit code 2 semantics', () => {
  assert.throws(() => cmdCurrent(seeded(), ['nope'], 'x', { commit: false }), /unknown project/);
});

test('current refuses an empty body rather than blanking the block', () => {
  assert.throws(() => cmdCurrent(seeded(), ['beacon'], '   \n', { commit: false }), /empty body/);
});

mtest('status validates, updates and re-renders the index', () => {
  const root = seeded();
  cmdStatus(root, ['beacon', 'paused'], { commit: false, date: '2026-07-29' });
  assert.equal(findProject(readStore(root), 'beacon').status, 'paused');
  assert.match(readFileSync(join(root, 'docs/projects/INDEX.md'), 'utf8'), /🟡 paused/);
  assert.throws(() => cmdStatus(root, ['beacon', 'running'], { commit: false }), /unknown status/);
});

mtest('register adds a row and a page skeleton carrying the unwritten marker', () => {
  const root = seeded();
  cmdRegister(root, ['newthing', '--name', 'New Thing', '--status', 'active',
    '--where', 'C:/dev/newthing'], { commit: false, date: '2026-07-29' });
  const p = findProject(readStore(root), 'newthing');
  assert.equal(p.name, 'New Thing');
  assert.equal(p.page, 'newthing.md');
  const page = readFileSync(join(root, 'docs/projects/newthing.md'), 'utf8');
  assert.match(page, /# New Thing/);
  assert.match(page, /projects:narrative-unwritten/);
  assert.match(page, /## Future Directions/);
});

mtest('a skeleton page is stamped "last verified never", never with a date', () => {
  // The narrative is unwritten, so a date would claim a concept review that never happened, and
  // it would also hide the page from sync's UNVERIFIED sentinel for the whole staleness window,
  // on exactly the pages that most need flagging. The field stays PRESENT, so no reader
  // downstream needs a missing-field branch.
  const root = seeded();
  cmdRegister(root, ['fresh', '--name', 'Fresh'], { commit: false, date: '2026-07-29' });
  const page = readFileSync(join(root, 'docs/projects/fresh.md'), 'utf8');
  assert.match(page, /^\*last verified never · docs: none\*$/m);
  assert.doesNotMatch(page.split('\n')[1], /\d{4}-\d{2}-\d{2}/, 'no date on the header line');
  // The heading date and lastTouched are separate concepts and both still carry the real date.
  assert.match(page, /## Current state \(2026-07-29\)/);
  assert.equal(findProject(readStore(root), 'fresh').lastTouched, '2026-07-29');
});

mtest('register works in a repo that has no docs/projects yet', () => {
  // A fresh repo is the first thing this verb ever meets, and the skeleton write ran before
  // anything had created the folder, so it died on a raw ENOENT with no usable message.
  const root = fixture();
  rmSync(join(root, 'docs'), { recursive: true });
  cmdRegister(root, ['first', '--name', 'First'], { commit: false, date: '2026-07-29' });
  assert.ok(existsSync(join(root, 'docs/projects/first.md')));
  assert.equal(findProject(readStore(root), 'first').page, 'first.md');
});

test('register refuses a duplicate slug instead of clobbering the page', () => {
  assert.throws(() => cmdRegister(seeded(), ['beacon', '--name', 'Dup'], { commit: false }),
    /already registered/);
});

mtest('archive moves the page and drops the row', () => {
  const root = seeded();
  cmdArchive(root, ['beacon'], { commit: false, date: '2026-07-29' });
  assert.equal(findProject(readStore(root), 'beacon'), undefined);
  assert.ok(existsSync(join(root, 'docs/projects/archive/beacon.md')));
  assert.ok(!existsSync(join(root, 'docs/projects/beacon.md')));
});

// ── Destructive and traversal edges ──────────────────────────────────────────────────

test('every verb rejects a traversal slug before it can reach path.join', () => {
  const root = seeded();
  const before = readFileSync(join(root, 'docs/projects/beacon.md'), 'utf8');
  for (const bad of ['../evil', 'docs/evil', '..\\evil', '..', 'a b', '']) {
    assert.throws(() => cmdCurrent(root, [bad], 'body', { commit: false }), /invalid slug/);
    assert.throws(() => cmdStatus(root, [bad, 'paused'], { commit: false }), /invalid slug/);
    assert.throws(() => cmdRegister(root, [bad, '--name', 'Evil'], { commit: false }), /invalid slug/);
    assert.throws(() => cmdArchive(root, [bad], { commit: false }), /invalid slug/);
  }
  assert.ok(!existsSync(join(root, 'docs/evil.md')), 'nothing may be written outside the slug space');
  assert.ok(!existsSync(join(root, 'evil.md')));
  assert.equal(readFileSync(join(root, 'docs/projects/beacon.md'), 'utf8'), before);
  assert.deepEqual(readStore(root).projects.map((p) => p.slug), ['beacon']);
});

test('a hand-edited page field cannot walk a write or a rename out of docs/projects', () => {
  // _projects.json is hand-editable, so `page` is exactly as untrusted as a slug. archive is
  // the sharp one: renameSync would MOVE the named file, wherever in the tree it sits.
  const root = seeded();
  const store = readStore(root);
  store.projects[0].page = '../../escape.md';
  writeStore(root, store);
  assert.throws(() => cmdCurrent(root, ['beacon'], 'body', { commit: false }), /refusing a page path/);
  assert.throws(() => cmdArchive(root, ['beacon'], { commit: false }), /refusing a page path/);
  assert.ok(findProject(readStore(root), 'beacon'), 'the row survives a refused archive');
});

test('current on a page with malformed markers writes nothing at all', () => {
  const root = seeded();
  const path = join(root, 'docs/projects/beacon.md');
  writeFileSync(path, `# Beacon\n\nnarrative\n\n${CS_START}\nold\n${CS_START}\nolder\n${CS_END}\n`);
  const before = readFileSync(path, 'utf8');
  assert.throws(() => cmdCurrent(root, ['beacon'], 'new body', { commit: false }),
    /expected exactly one of each/);
  assert.equal(readFileSync(path, 'utf8'), before, 'a refused write leaves the page byte-identical');
  assert.equal(findProject(readStore(root), 'beacon').lastTouched, '2026-07-20',
    'and lastTouched must not move for a write that never landed');
});

test('current refuses a project with no page, and one whose page is gone', () => {
  const root = seeded();
  const store = readStore(root);
  store.projects.push({ slug: 'pageless', name: 'Pageless', status: 'active', where: [],
    page: null, lastTouched: '2026-07-20' });
  writeStore(root, store);
  assert.throws(() => cmdCurrent(root, ['pageless'], 'body', { commit: false }), /has no page/);
  rmSync(join(root, 'docs/projects/beacon.md'));
  assert.throws(() => cmdCurrent(root, ['beacon'], 'body', { commit: false }), /page beacon\.md is missing/);
});

mtest('archive drops the row when the page file is already gone', () => {
  const root = seeded();
  rmSync(join(root, 'docs/projects/beacon.md'));
  cmdArchive(root, ['beacon'], { commit: false, date: '2026-07-29' });
  assert.equal(findProject(readStore(root), 'beacon'), undefined);
  assert.ok(!existsSync(join(root, 'docs/projects/archive/beacon.md')));
});

test('archive refuses to overwrite a page already sitting in archive/', () => {
  // renameSync replaces the destination silently on both platforms, so without this guard a
  // second project reusing a retired slug destroys the first one's narrative.
  const root = seeded();
  mkdirSync(join(root, 'docs/projects/archive'), { recursive: true });
  const archived = join(root, 'docs/projects/archive/beacon.md');
  writeFileSync(archived, '# Beacon\n\nthe FIRST beacon, archived years ago\n');
  const before = readFileSync(archived, 'utf8');
  assert.throws(() => cmdArchive(root, ['beacon'], { commit: false }), /already an archived page/);
  assert.equal(readFileSync(archived, 'utf8'), before);
  assert.ok(existsSync(join(root, 'docs/projects/beacon.md')), 'the live page stays where it is');
  assert.ok(findProject(readStore(root), 'beacon'), 'and the row is not dropped');
});

mtest('register adopts an existing page rather than clobbering the narrative', () => {
  const root = seeded();
  const path = join(root, 'docs/projects/adopted.md');
  writeFileSync(path, '# Adopted\n\nhand-written long before the CLI existed\n');
  const before = readFileSync(path, 'utf8');
  cmdRegister(root, ['adopted'], { commit: false, date: '2026-07-29' });
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(findProject(readStore(root), 'adopted').page, 'adopted.md');
});

test('a duplicate register leaves both the page and the store byte-identical', () => {
  const root = seeded();
  const page = readFileSync(join(root, 'docs/projects/beacon.md'), 'utf8');
  const store = readFileSync(join(root, REL_STORE), 'utf8');
  assert.throws(() => cmdRegister(root, ['beacon', '--name', 'Dup'], { commit: false }),
    /already registered/);
  assert.equal(readFileSync(join(root, 'docs/projects/beacon.md'), 'utf8'), page);
  assert.equal(readFileSync(join(root, REL_STORE), 'utf8'), store);
});

test('an unrenderable name is refused before anything reaches disk', () => {
  // A pipe in a name shifts every column of its row. Caught before the write, because a
  // stored row that no render can emit bricks every later status, current and render call.
  const root = seeded();
  const store = readFileSync(join(root, REL_STORE), 'utf8');
  assert.throws(() => cmdRegister(root, ['pipey', '--name', 'a|b'], { commit: false }),
    /pipe or line break/);
  assert.equal(readFileSync(join(root, REL_STORE), 'utf8'), store);
  assert.ok(!existsSync(join(root, 'docs/projects/pipey.md')), 'and no orphan skeleton either');
});

mtest('a mutating verb commits its own paths only, never the shared index', () => {
  const { root, git } = gitFixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'beacon', name: 'Beacon', status: 'active', where: [], page: 'beacon.md',
      lastTouched: '2026-07-20' }] });
  writeFileSync(join(root, 'docs/projects/beacon.md'), '# Beacon\n\nnarrative\n');
  writeFileSync(join(root, 'other.md'), 'another session was mid-edit\n');
  git('add', 'other.md');

  cmdStatus(root, ['beacon', 'paused'], { date: '2026-07-29' }); // commit ON, the real path
  const committed = git('show', '--name-only', '--format=', 'HEAD').toString().trim().split('\n');
  assert.deepEqual(committed.sort(), [REL_INDEX, REL_STORE].sort());
  assert.equal(git('diff', '--cached', '--name-only').toString().trim(), 'other.md',
    'the staged work of the other session must be left exactly where it was');
});

test('every mutation prints its marker, archive printing ARCHIVED before RENDERED', () => {
  const root = seeded();
  const before = console.log;
  assert.deepEqual(
    capture(() => cmdStatus(root, ['beacon', 'ops'], { commit: false, date: '2026-07-29' })),
    ['RENDERED']);
  assert.deepEqual(
    capture(() => cmdArchive(root, ['beacon'], { commit: false, date: '2026-07-29' })),
    ['ARCHIVED', 'RENDERED']);
  // The invariant the old `typeof console.log === 'function'` assertion only gestured at, since
  // that held whether or not the patch was ever undone: capture puts the REAL console back, so
  // no later test in this file runs muted.
  assert.equal(console.log, before, 'capture must restore the console it replaced');
});

// ── main() and the dispatch map ──────────────────────────────────────────────────────
// Run as a subprocess: main() calls process.exit, which would take the test runner with it.
// The cwd is always a gitFixture, so the commit these verbs really do stays local.
const CLI = fileURLToPath(new URL('../skills/projects/projects.mjs', import.meta.url));
function runCli(root, args, input = '') {
  return spawnSync(process.execPath, [CLI, ...args],
    { cwd: root, input, encoding: 'utf8', env: { ...process.env, PROJECTS_ROOT: root } });
}

test('main registers, writes a Current state from stdin and lists, all exit 0', () => {
  const { root, git } = gitFixture();
  const reg = runCli(root, ['register', 'demo', '--name', 'Demo', '--status', 'active']);
  assert.equal(reg.status, 0, reg.stderr);
  assert.match(reg.stdout, /RENDERED/);

  const cur = runCli(root, ['current', 'demo'], 'Doing the thing.\n');
  assert.equal(cur.status, 0, cur.stderr);

  const list = runCli(root, []);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /1\. Demo \[demo\] \(active\): Doing the thing\./);
  assert.match(readFileSync(join(root, REL_INDEX), 'utf8'), /\[Demo\]\(demo\.md\)/);
  assert.match(git('log', '--format=%s').toString(), /projects: current state/);
});

test('main exits 2 on an unknown verb and on a missing argument, 1 on a real failure', () => {
  const { root } = gitFixture();
  const unknown = runCli(root, ['frobnicate']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command "frobnicate"/);
  assert.match(unknown.stderr, /projects current <slug>/, 'a usage error prints the help');

  // Inherited Object keys are not verbs. These resolved through the prototype chain and exited 0
  // with no output, which an agent reads as the command having worked.
  for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const proto = runCli(root, [key]);
    assert.equal(proto.status, 2, `${key} must be refused, got ${proto.status}`);
    assert.match(proto.stderr, new RegExp(`unknown command "${key === '__proto__' ? '__proto__' : key}"`));
  }

  assert.equal(runCli(root, ['status']).status, 2, 'no slug');
  assert.equal(runCli(root, ['status', 'demo']).status, 2, 'no status word');
  assert.equal(runCli(root, ['register']).status, 2, 'no slug');
  // Only the exit code is claimed here. `current` validating the slug before it reads stdin is
  // real and deliberate, but it is not what this line proves: spawnSync always closes the
  // child's stdin, so the read returns '' immediately and the exit code is 2 either way. The
  // behaviour it guards against, blocking forever on a terminal, needs a tty to observe.
  assert.equal(runCli(root, ['current']).status, 2, 'no slug');

  runCli(root, ['register', 'demo']);
  writeFileSync(join(root, 'docs/projects/demo.md'),
    `# Demo\n${CS_START}\na\n${CS_START}\nb\n${CS_END}\n`);
  const bad = runCli(root, ['current', 'demo'], 'new body\n');
  assert.equal(bad.status, 1, 'a refused page write is a failure, not a usage error');
  assert.match(bad.stderr, /expected exactly one of each/);
});

test('an unexpected throw prints its stack instead of a bare one-line message', () => {
  // The blanket catch used to print `e.message` alone, so any bug in this file exited 1 with a
  // single unattributed line and no frames. A deliberate refusal still prints just its message
  // (asserted by the tests above), and anything else is treated as a bug and gets to be loud.
  const { root } = gitFixture();
  writeFileSync(join(root, REL_STORE), '{"version":1,"projects":{}}\n');
  const r = runCli(root, ['render']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /internal error/);
  assert.match(r.stderr, /^\s+at .+projects\.mjs/m, 'the stack has to name a frame in this file');
});

// ── sync: the reality check ──────────────────────────────────────────────────────────
// NARRATIVE_UNWRITTEN, CS_START and CS_END are already imported above. Importing them a
// second time here is a duplicate binding, which is a SyntaxError for the whole file.
import { daysBetween, currentStateDate, lastVerifiedDate, cmdSync } from '../skills/projects/projects.mjs';

test('daysBetween crosses a month boundary and a year boundary', () => {
  assert.equal(daysBetween('2026-07-31', '2026-08-01'), 1);
  assert.equal(daysBetween('2026-07-01', '2026-07-31'), 30);
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(daysBetween('2026-08-01', '2026-07-31'), -1);
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1); // 2026 is not a leap year
});

test('date extraction reads the block heading and the italic header separately', () => {
  const page = '# X\n*last verified 2026-07-04 · 🟢 active · docs: none*\n\n'
    + '## Current state (2026-07-29)\n' + CS_START + '\nbody\n' + CS_END + '\n';
  assert.equal(currentStateDate(page), '2026-07-29');
  assert.equal(lastVerifiedDate(page), '2026-07-04');
  assert.equal(currentStateDate('# X\n\nno block\n'), null);
  assert.equal(lastVerifiedDate('# X\n\nno stamp\n'), null);
});

test('sync flags a row with no page, a page with no row, and an unlinked file', () => {
  const root = fixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'ghost', name: 'Ghost', status: 'active', where: [], page: null, lastTouched: '2026-07-28' },
    { slug: 'gone', name: 'Gone', status: 'active', where: [], page: 'gone.md', lastTouched: '2026-07-28' },
  ] });
  writeFileSync(join(root, 'docs/projects/stray.md'), '# Stray\n');
  const out = cmdSync(root, [], { date: '2026-07-29' });
  assert.match(out, /NO-PAGE .*ghost/);
  assert.match(out, /NO-PAGE .*gone/);      // row points at a page that is not there
  assert.match(out, /NO-ROW .*stray\.md/);  // page in the folder nothing points at
  // The 2026-08-03 ruling reaches layout punctuation, not only prose: no em dash and
  // no semicolon in anything this CLI prints. The row separator is ': ', as in renderList.
  assert.doesNotMatch(out, /[—;]/, 'no em dash and no semicolon in printed output');
});

test('sync flags a narrative that was never written', () => {
  const root = fixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'skel', name: 'Skel', status: 'active', where: [], page: 'skel.md', lastTouched: '2026-07-29' }] });
  writeFileSync(join(root, 'docs/projects/skel.md'), `# Skel\n\n${NARRATIVE_UNWRITTEN}\n`);
  assert.match(cmdSync(root, [], { date: '2026-07-29' }), /NARRATIVE-UNWRITTEN .*skel/);
});

test('sync flags a missing repo and reports status age against a stubbed commit date', () => {
  // Both flags are still pinned, but on separate rows. A repo known to be absent is no longer
  // handed to git (see 'a repo path known to be absent is never handed to git'), so one row
  // cannot carry MISSING-REPO and STALE at once. It never could in production either: the
  // combined shape only existed because the stub returned a date for a path that is not there.
  const root = fixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'nope', name: 'Nope', status: 'active', where: [], repo: join(root, 'not-here'),
      page: 'nope.md', lastTouched: '2026-07-29' },
    { slug: 'aged', name: 'Aged', status: 'active', where: [], repo: root,
      page: 'aged.md', lastTouched: '2026-07-29' }] });
  for (const slug of ['nope', 'aged']) {
    writeFileSync(join(root, `docs/projects/${slug}.md`),
      `# ${slug}\n\n## Current state (2026-07-01)\n${CS_START}\nbody\n${CS_END}\n`);
  }
  const out = cmdSync(root, [], { date: '2026-07-29', commitDateFor: () => '2026-07-29' });
  assert.match(out, /MISSING-REPO .*nope/);
  assert.match(out, /STALE .*aged.*28 days/);
});

test('sync reports nothing wrong on a clean store', () => {
  const root = fixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'ok', name: 'OK', status: 'active', where: [], page: 'ok.md', lastTouched: '2026-07-29' }] });
  writeFileSync(join(root, 'docs/projects/ok.md'),
    `# OK\n*last verified 2026-07-29 · 🟢 active · docs: none*\n\nnarrative\n\n`
    + `## Current state (2026-07-29)\n${CS_START}\nbody\n${CS_END}\n`);
  const out = cmdSync(root, [], { date: '2026-07-29', commitDateFor: () => '2026-07-29' });
  assert.match(out, /nothing to flag/i);
  assert.match(out, /1 project\b/, 'the count is grammatical, not "1 projects"');
});

test('"last verified never" is UNVERIFIED from the day the skeleton is written', () => {
  // register stamps `never` rather than today, because stamping today claims a concept review
  // that did not happen. That is only worth anything if sync treats `never` as stale at once:
  // a date would suppress this sentinel for the whole staleness window on the pages that most
  // need it. The field is always present, so there is no missing-field branch to write.
  const root = fixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'skel', name: 'Skel', status: 'active', where: [], page: 'skel.md', lastTouched: '2026-07-29' }] });
  writeFileSync(join(root, 'docs/projects/skel.md'),
    `# Skel\n*last verified never · 🟢 active · docs: none*\n\nnarrative\n\n`
    + `## Current state (2026-07-29)\n${CS_START}\nbody\n${CS_END}\n`);
  assert.match(cmdSync(root, [], { date: '2026-07-29' }), /UNVERIFIED .*skel/);
});

test('a verified narrative older than the status date is UNVERIFIED, a current one is not', () => {
  const root = fixture();
  const page = (lv) => `# V\n*last verified ${lv} · 🟢 active · docs: none*\n\nnarrative\n\n`
    + `## Current state (2026-07-29)\n${CS_START}\nbody\n${CS_END}\n`;
  writeStore(root, { version: 1, projects: [
    { slug: 'v', name: 'V', status: 'active', where: [], page: 'v.md', lastTouched: '2026-07-29' }] });
  writeFileSync(join(root, 'docs/projects/v.md'), page('2026-07-04'));
  assert.match(cmdSync(root, [], { date: '2026-07-29' }), /UNVERIFIED .*v.*2026-07-04/);
  writeFileSync(join(root, 'docs/projects/v.md'), page('2026-07-29'));
  assert.doesNotMatch(cmdSync(root, [], { date: '2026-07-29' }), /UNVERIFIED/);
});

test('two Current state headings on one page are flagged, because the date read goes stale', () => {
  // Carried from Task 3's review. Whitespace between the heading and the marker is absorbed on
  // the next write, but PROSE between them is not, so the old heading survives and a second one
  // is written below it. Both match the heading regex, /m takes the FIRST, and the project then
  // reports the stale date forever with a current block sitting underneath it. Nothing throws
  // here: the marker pair is clean and getCurrentState reads the body fine, so this is a
  // page-health warning under its own token and not MALFORMED. That token is DOUBLE-HEADING and
  // not ORPHANED, which Task 7's migration gate already uses for a Next cell that would be lost.
  // One grep token, one condition.
  const root = fixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'twoheads', name: 'Two Heads', status: 'active', where: [], page: 'twoheads.md',
      lastTouched: '2026-07-29' }] });
  writeFileSync(join(root, 'docs/projects/twoheads.md'),
    `# Two Heads\n*last verified 2026-07-29 · 🟢 active · docs: none*\n\n`
    + `## Current state (2026-07-01)\n\nprose a human left between the heading and the block\n\n`
    + `## Current state (2026-07-29)\n${CS_START}\nbody\n${CS_END}\n`);
  const out = cmdSync(root, [], { date: '2026-07-29' });
  assert.match(out, /DOUBLE-HEADING .*twoheads.*twoheads\.md/);
  assert.match(out, /2 Current state headings/);
  assert.doesNotMatch(out, /MALFORMED/, 'the block itself parses, so this is not MALFORMED');
  assert.doesNotMatch(out, /ORPHANED/, 'ORPHANED belongs to Task 7 migration gate, not to this');
});

test('sync prints MALFORMED naming the file, and the other rows are still checked', () => {
  // list prints MALFORMED in the row and stays exit 0. sync names the file and fails, because
  // its whole job is the numbers, and a page it cannot parse means it has no numbers for that
  // project. Read per row, not once around the loop, so one bad page checks nothing else out.
  const root = fixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'bad', name: 'Bad', status: 'active', where: [], page: 'bad.md', lastTouched: '2026-07-29' },
    { slug: 'escape', name: 'Escape', status: 'active', where: [], page: '../../secret.md',
      lastTouched: '2026-07-29' },
    { slug: 'ghost', name: 'Ghost', status: 'active', where: [], page: null, lastTouched: '2026-07-29' },
  ] });
  writeFileSync(join(root, 'docs/projects/bad.md'),
    `# Bad\n\nnarrative\n\n${CS_START}\nold\n${CS_START}\nolder\n${CS_END}\n`);
  writeFileSync(join(root, 'secret.md'), '# Secret\n\nSUPERSECRET, not a project page\n');
  const out = cmdSync(root, [], { date: '2026-07-29' });
  assert.match(out, /MALFORMED bad: bad\.md/);
  assert.match(out, /exactly one of each/, 'the reason travels with the flag');
  // A hand-edited page field is as untrusted here as anywhere else: sync READS every page.
  assert.match(out, /MALFORMED escape: \.\.\/\.\.\/secret\.md/);
  assert.doesNotMatch(out, /SUPERSECRET/);
  assert.match(out, /NO-PAGE .*ghost/, 'a later row is still checked');
});

test('sync survives a repo that has no docs/projects folder at all', () => {
  const root = fixture();
  rmSync(join(root, 'docs'), { recursive: true });
  assert.match(cmdSync(root, [], { date: '2026-07-29' }), /nothing to flag/i);
});

// ── sync, fix round 1 ────────────────────────────────────────────────────────────────
import { lastCommitDate } from '../skills/projects/projects.mjs';

test('the last verified stamp is read from the header line, never from prose below it', () => {
  // Unanchored, this regex scans the whole page, so the FIRST "last verified <date>" anywhere
  // wins over the italic header. The Current state body is the likeliest place that phrase
  // shows up, because writing it is exactly what model-authored status prose does, and the body
  // sits below the header, so it beat a header saying `never` and silenced UNVERIFIED on the
  // pages that need it most. Its sibling currentStateDate has been anchored from the start.
  const page = `# API Watch\n*last verified never · 🟢 active · docs: none*\n\n`
    + `We last verified 2026-08-03 that the upstream API is stable.\n\n`
    + `## Current state (2026-08-03)\n${CS_START}\nLast verified 2026-08-03, nothing moved.\n${CS_END}\n`;
  assert.equal(lastVerifiedDate(page), null, 'the header says never, and the header is the stamp');
  const root = fixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'apiwatch', name: 'API Watch', status: 'active', where: [], page: 'apiwatch.md',
      lastTouched: '2026-08-03' }] });
  writeFileSync(join(root, 'docs/projects/apiwatch.md'), page);
  assert.match(cmdSync(root, [], { date: '2026-08-03' }), /UNVERIFIED .*apiwatch/);
  // A real header stamp is still read, so the anchor did not simply break the function.
  assert.equal(lastVerifiedDate(page.replace('never', '2026-07-04')), '2026-07-04');
});

test('lastCommitDate measures the named directory, not the repo that encloses it', () => {
  // `git -C <dir> log -1` with no pathspec walks UP to whatever repo contains <dir>. So a repo
  // field naming a plain folder inside a bigger repo reported that repo's newest commit, made
  // by any session working anywhere in it, and a genuinely dormant folder read as 0 days
  // behind. This is read-only git in a gitFixture, which has its own .git.
  const { root, git } = gitFixture();
  writeFileSync(join(root, 'tracked.md'), 'x\n');
  git('add', '--', 'tracked.md');
  git('commit', '-q', '-m', 'one', '--date', '2026-07-01T00:00:00');
  assert.equal(lastCommitDate(root), '2026-07-01', 'the repo root still reports its own commit');
  const plain = join(root, 'plain');
  mkdirSync(plain);
  assert.equal(lastCommitDate(plain), null, 'a plain folder inside a repo is not that repo');
  assert.equal(lastCommitDate(join(root, 'not-there')), null, 'and a path that is not there is null');
});

test('a repo path known to be absent is never handed to git', () => {
  const root = fixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'nope', name: 'Nope', status: 'active', where: [], repo: join(root, 'not-here'),
      page: 'nope.md', lastTouched: '2026-07-29' }] });
  writeFileSync(join(root, 'docs/projects/nope.md'),
    `# Nope\n*last verified 2026-07-01 · 🟢 active · docs: none*\n\n`
    + `## Current state (2026-07-01)\n${CS_START}\nbody\n${CS_END}\n`);
  let calls = 0;
  const out = cmdSync(root, [], { date: '2026-07-29',
    commitDateFor: () => { calls++; return '2026-07-29'; } });
  assert.match(out, /MISSING-REPO .*nope/);
  assert.equal(calls, 0, 'no git process for a path already known to be absent');
  assert.doesNotMatch(out, /STALE/, 'and no staleness number invented for a repo that is not there');
});

test('a relative repo path is resolved against the store root, not the working directory', () => {
  // `register --repo ../foo` stores the string verbatim, so a bare existsSync made the flag
  // depend on where sync happened to be run from.
  const root = fixture();
  mkdirSync(join(root, 'sibling'));
  writeStore(root, { version: 1, projects: [
    { slug: 'rel', name: 'Rel', status: 'active', where: [], repo: 'sibling',
      page: 'rel.md', lastTouched: '2026-07-29' }] });
  writeFileSync(join(root, 'docs/projects/rel.md'),
    `# Rel\n*last verified 2026-07-29 · 🟢 active · docs: none*\n\n`
    + `## Current state (2026-07-29)\n${CS_START}\nbody\n${CS_END}\n`);
  const out = cmdSync(root, [], { date: '2026-07-29', commitDateFor: () => '2026-07-29' });
  assert.doesNotMatch(out, /MISSING-REPO/, 'the folder is there, relative to the root');
  assert.match(out, /nothing to flag/i);
});

test('a page with narrative but no Current state block is NO-CURRENT-STATE, not MALFORMED', () => {
  const root = fixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'plain', name: 'Plain', status: 'active', where: [], page: 'plain.md',
      lastTouched: '2026-07-29' }] });
  writeFileSync(join(root, 'docs/projects/plain.md'),
    '# Plain\n*last verified 2026-07-29 · 🟢 active · docs: none*\n\nJust narrative.\n');
  const out = cmdSync(root, [], { date: '2026-07-29' });
  assert.match(out, /NO-CURRENT-STATE .*plain.*plain\.md/);
  // Absent is not unparseable. Collapsing the two would also flip the exit code to 1.
  assert.doesNotMatch(out, /MALFORMED/);
});

test('an impossible date in a heading is flagged, not silently believed', () => {
  // \d\d accepts 13 and 45, so the regex matches and csDate is truthy, which keeps
  // NO-CURRENT-STATE quiet. Date.parse then yields NaN, every comparison below is false, and
  // the page reports clean while being months behind. 2026-02-30 is the nastier shape: V8 rolls
  // it forward to 2026-03-02 rather than rejecting it, so it produces a plausible WRONG number.
  const root = fixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'bogus', name: 'Bogus', status: 'active', where: [], repo: root,
      page: 'bogus.md', lastTouched: '2026-08-03' }] });
  const page = (heading, lv) => `# Bogus\n*last verified ${lv} · 🟢 active · docs: none*\n\n`
    + `## Current state (${heading})\n${CS_START}\nbody\n${CS_END}\n`;
  writeFileSync(join(root, 'docs/projects/bogus.md'), page('2026-13-45', '2020-01-01'));
  const out = cmdSync(root, [], { date: '2026-08-03', commitDateFor: () => '2026-08-03' });
  assert.match(out, /MALFORMED bogus: bogus\.md.*2026-13-45/);
  assert.doesNotMatch(out, /nothing to flag/i);
  // A rolled-over date is just as unreal, and it is the one that yields a confident wrong count.
  writeFileSync(join(root, 'docs/projects/bogus.md'), page('2026-02-30', '2026-01-01'));
  assert.match(cmdSync(root, [], { date: '2026-08-03', commitDateFor: () => '2026-08-03' }),
    /MALFORMED bogus: bogus\.md.*2026-02-30/);
  // An impossible last verified stamp is unusable too, so it flags rather than passing as fresh.
  writeFileSync(join(root, 'docs/projects/bogus.md'), page('2026-08-03', '2026-13-45'));
  assert.match(cmdSync(root, [], { date: '2026-08-03', commitDateFor: () => '2026-08-03' }),
    /UNVERIFIED .*bogus/);
});

test('a newline in a page field cannot forge a second flag line', () => {
  // The MALFORMED reason quotes the rejected page verbatim, and pagePath refuses this one for
  // the newline it contains, so without squashing the whitespace the report grows a second
  // grep-visible token line while the header still counts one flag. Hand-edit only, which is
  // exactly pagePath's threat model.
  const root = fixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'forge', name: 'Forge', status: 'active', where: [],
      page: 'a.md\nSTALE forged: 999 days behind the code', lastTouched: '2026-07-29' }] });
  const out = cmdSync(root, [], { date: '2026-07-29' });
  assert.match(out, /MALFORMED forge:/);
  assert.doesNotMatch(out, /^STALE/m, 'no forged token may start a line');
  assert.equal(out.match(/^\S+ forge/gm)?.length, 1, 'one flag line, as the header claims');
  assert.match(out, /1 flagged/);
});

// A page with a real block and no verified stamp, so its row IS flagged and whatever the store
// carried into that flag line is on show. Shared by both forge tests.
const FLAGGABLE_PAGE = `# F\n\nnarrative\n\n## Current state (2026-07-29)\n${CS_START}\nbody\n${CS_END}\n`;

test('a forged flag line in a slug cannot force the exit code', () => {
  // The sharp one. Every flag line carries the slug, the dispatcher decides the exit code with
  // /^MALFORMED /m, and every store field is hand-editable, so a newline in a slug planted a
  // MALFORMED line at line start and made sync exit 1 on a store with no real defect. The squash
  // is per report rather than per field, so no field can do this.
  // fixture, not gitFixture: this store has no `repo`, so sync makes no git call and the three
  // processes `git init` plus two `git config` cost were paid for nothing.
  const root = fixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'ok\nMALFORMED injected: forced exit 1', name: 'OK', status: 'active', where: [],
      page: 'ok.md', lastTouched: '2026-07-29' }] });
  writeFileSync(join(root, 'docs/projects/ok.md'), FLAGGABLE_PAGE);
  const r = runCli(root, ['sync']);
  assert.match(r.stdout, /UNVERIFIED/, 'the row really is flagged, so the slug really is printed');
  assert.doesNotMatch(r.stdout, /^MALFORMED /m, 'no forged token may start a line');
  assert.equal(r.status, 0, 'and the exit code cannot be forged');
  // The text is not censored, it just stops being a line of its own.
  assert.match(r.stdout, /MALFORMED injected/);
});

test('a newline in any store field cannot forge a flag line', () => {
  // Every field a hand-edited store carries into a flag line: slug (above), repo, page, and the
  // reason quoted back by a pagePath refusal, which is `page` again. A NO-ROW filename is the
  // fourth and cannot be tested on this machine, because NTFS refuses a newline in a filename.
  // The squash covers it regardless, being per report rather than per field.
  const root = fixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'repoforge', name: 'R', status: 'active', where: [],
      repo: 'nope\nSTALE repoforge: 999 days behind the code',
      page: 'r.md', lastTouched: '2026-07-29' },
    { slug: 'pageforge', name: 'P', status: 'active', where: [],
      page: 'p.md\nNO-ROW forged.md: a page in docs/projects with no row pointing at it',
      lastTouched: '2026-07-29' },
  ] });
  writeFileSync(join(root, 'docs/projects/r.md'), FLAGGABLE_PAGE);
  const out = cmdSync(root, [], { date: '2026-07-29', commitDateFor: () => null });
  for (const token of ['STALE', 'NO-ROW']) {
    assert.doesNotMatch(out, new RegExp(`^${token} `, 'm'), `${token} may not be forged at line start`);
  }
  assert.match(out, /MISSING-REPO repoforge/, 'the real flags are still reported');
  assert.match(out, /MALFORMED pageforge/);
  // The general invariant, rather than one regex per token: the body carries exactly as many
  // lines as the header claims flags. A forged line breaks this whatever token it names.
  const claimed = Number(out.match(/(\d+) flagged/)[1]);
  assert.equal(out.split('\n\n')[1].trim().split('\n').length, claimed,
    'one flag, one line, and the header count agrees with the body');
});

test('a dated heading with no usable block under it is MALFORMED, not silently clean', () => {
  // The heading makes csDate truthy, so NO-CURRENT-STATE stays quiet, and locateBlock returns
  // null rather than throwing when BOTH markers are absent, so MALFORMED stayed quiet too. sync
  // then trusted a status date with no status behind it. Reachable by design: DOUBLE-HEADING's
  // own remedy text tells you to delete the heading with no block under it, and hand-deleting
  // a block leaves exactly this. Same class as the impossible heading date, closed the same way.
  const root = fixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'hollow', name: 'Hollow', status: 'active', where: [], page: 'hollow.md',
      lastTouched: '2026-07-29' }] });
  const page = (block) => `# Hollow\n*last verified 2026-07-29 · 🟢 active · docs: none*\n\n`
    + `narrative\n\n## Current state (2026-07-29)\n${block}`;
  const path = join(root, 'docs/projects/hollow.md');

  writeFileSync(path, page('\nprose where the block should be, and no markers at all\n'));
  const out = cmdSync(root, [], { date: '2026-07-29' });
  assert.match(out, /MALFORMED hollow: hollow\.md/);
  assert.doesNotMatch(out, /nothing to flag/i);

  // An empty block is the same defect: a dated heading over nothing sync can report.
  writeFileSync(path, page(`${CS_START}\n${CS_END}\n`));
  assert.match(cmdSync(root, [], { date: '2026-07-29' }), /MALFORMED hollow: hollow\.md/);

  // And the shape stays fixed by writing a real block, which is the remedy the flag asks for.
  writeFileSync(path, page(`${CS_START}\nreal status\n${CS_END}\n`));
  assert.match(cmdSync(root, [], { date: '2026-07-29' }), /nothing to flag/i);
});

test('a NO-ROW filename carrying U+2028 cannot forge a flag line', () => {
  // Round 2 recorded this surface as untestable because NTFS refused a filename with \n. It
  // accepts U+2028 and U+2029 (executed), and /m treats both as line starts, so the surface was
  // live and only the claim was untested. \s matches them, so the report squash covers them.
  const root = fixture();
  writeFileSync(join(root, 'docs/projects/x MALFORMED forged.md'), '# X\n');
  const out = cmdSync(root, [], { date: '2026-07-29' });
  assert.match(out, /NO-ROW /, 'the real flag is still reported');
  assert.doesNotMatch(out, /^MALFORMED /m, 'U+2028 starts a line for /m, so it has to be squashed');
  const claimed = Number(out.match(/(\d+) flagged/)[1]);
  assert.equal(out.split('\n\n')[1].trim().split('\n').length, claimed,
    'one flag, one line, whatever whitespace the filename smuggles in');
});

test('main wires sync: exit 0 on a clean store, exit 1 on a page it cannot parse', () => {
  // fixture, not gitFixture: sync commits nothing and this store has no `repo`, so no git call
  // is reachable. PROJECTS_ROOT is passed by runCli, so root resolution needs no repo either.
  const root = fixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'ok', name: 'OK', status: 'active', where: [], page: 'ok.md', lastTouched: '2026-07-29' }] });
  writeFileSync(join(root, 'docs/projects/ok.md'),
    `# OK\n*last verified 2026-07-29 · 🟢 active · docs: none*\n\nnarrative\n\n`
    + `## Current state (2026-07-29)\n${CS_START}\nbody\n${CS_END}\n`);
  const clean = runCli(root, ['sync']);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /nothing to flag/i);

  writeFileSync(join(root, 'docs/projects/ok.md'),
    `# OK\n\nnarrative\n\n${CS_START}\nold\n${CS_START}\nolder\n${CS_END}\n`);
  const broken = runCli(root, ['sync']);
  assert.equal(broken.status, 1, 'a page sync cannot parse is a real failure');
  assert.match(broken.stdout, /MALFORMED ok: ok\.md/);
  // The same page keeps `list` at exit 0: a read-only listing degrades its row and moves on.
  assert.equal(runCli(root, []).status, 0);

  // sync never rewrites: the report is the whole output, and the store is untouched.
  assert.equal(readStore(root).projects[0].lastTouched, '2026-07-29');
  assert.equal(runCli(root, ['sync']).stdout, broken.stdout);
});

// ── sync, fix round 5 ────────────────────────────────────────────────────────────────

test('a status body opening with a stamp line cannot pass as the header stamp', () => {
  // Built through the CLI, register then current, because hand-assembled page text is what hid
  // this for two rounds. register writes the header stamp as `never` and no verb ever replaces
  // it with a date, while setCurrentState writes the trimmed body line-initial directly under
  // CS_START. So a body whose first line is `*last verified <date>` lands exactly where a read
  // anchored to a line start but not bounded to the header looks, and the page reported clean
  // with a header still saying `never`. That is the false pass the anchor was added to close.
  const { root } = gitFixture();
  assert.equal(runCli(root, ['register', 'beacon', '--name', 'Beacon']).status, 0);
  assert.equal(runCli(root, ['current', 'beacon'],
    '*last verified 2026-08-03 after a full read*\nSweep is green.\n').status, 0);

  const page = readFileSync(join(root, 'docs/projects/beacon.md'), 'utf8');
  assert.match(page, /^\*last verified never/m, 'the header stamp is the one register wrote');
  assert.match(page, /^\*last verified 2026-08-03/m, 'and the block really does carry the decoy');
  assert.equal(lastVerifiedDate(page), null, 'read from the header region, not from the block');

  const sync = runCli(root, ['sync']);
  assert.equal(sync.status, 0, 'UNVERIFIED is a page-health warning, not an exit 1');
  assert.doesNotMatch(sync.stdout, /nothing to flag/i);
  assert.match(sync.stdout, /UNVERIFIED beacon/);
});

test('main help prints the usage without touching the store', () => {
  const { root } = gitFixture();
  for (const verb of ['help', '--help', '-h']) {
    const r = runCli(root, [verb]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /INDEX\.md is generated\. Never hand-edit it\./);
    assert.match(r.stdout, /projects sync/, 'a verb that exists has to be advertised');
    assert.doesNotMatch(r.stdout, /[—;]/, 'no em dash and no semicolon in printed output');
  }
  assert.ok(!existsSync(join(root, REL_STORE)));
});

// One guard, at the one place every verb reads the store, rather than in each verb. Without it a
// root holding rows in INDEX.md and none in the store is a loaded gun: readStore returns an empty
// list, saveAndRender renders a bare header over the table, and commit commits it, all at exit 0.
// Measured on copies of the live tree: 33 rows and 10,642 characters became 617 before the
// migration, and 33 rows and 5,454 characters became 617 after it with the store deleted.
//
// The condition is rows-here-and-none-there, NOT the table's shape. Shape detection covered only
// the five-column pre-migration table and left the mirror wide open, which is the more expensive
// side: after the migration the rendered INDEX is the only human-readable copy of where, status and
// lastTouched. Rows-and-no-store also subsumes a four-cell hand table still carrying a Next column,
// which no shape test recognised.
test('rows in INDEX.md with an empty store refuse every verb, on either side of the migration', () => {
  const row = { slug: 'beacon', name: 'Beacon', status: 'active', where: ['`C:/dev/beacon`'],
    page: 'beacon.md', lastTouched: '2026-07-29' };
  const tables = {
    'legacy five column': '# Projects\n\n| Project | Status | Where | Next | Last touched |\n'
      + '|---|---|---|---|---|\n'
      + '| [Beacon](beacon.md) | 🟢 running | `C:/dev/beacon` | Build the adapter | 2026-07-29 |\n',
    'hand four column with a Next': '# Projects\n\n| Project | Status | Where | Next |\n|---|---|---|---|\n'
      + '| [Beacon](beacon.md) | 🟢 running | `C:/dev/beacon` | Build the adapter |\n',
    'rendered and populated': renderIndex({ version: 1, projects: [row] }),
  };
  for (const [shape, table] of Object.entries(tables)) {
    for (const args of [['render'], ['status', 'beacon', 'paused'], ['sync'], []]) {
      const { root } = gitFixture();
      writeFileSync(join(root, REL_INDEX), table, 'utf8');
      const r = runCli(root, args);
      assert.equal(r.status, 2, `${shape} / ${args[0] || 'list'} did not refuse: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /[Mm]igrate it first/);
      assert.equal(readFileSync(join(root, REL_INDEX), 'utf8'), table, `${shape}: the table was rewritten`);
      assert.ok(!existsSync(join(root, REL_STORE)));
    }
  }
});

test('an INDEX.md with no data rows is not mistaken for an unmigrated table', () => {
  // The fresh-repo path. A header with nothing under it has nothing to lose, so refusing here would
  // only stop a new project from registering its first row.
  const { root } = gitFixture();
  writeFileSync(join(root, REL_INDEX), renderIndex({ version: 1, projects: [] }), 'utf8');
  const r = runCli(root, ['register', 'demo']);
  assert.equal(r.status, 0, r.stderr);
});

// ── The final fix wave ───────────────────────────────────────────────────────────────
// The zone is picked from the CURRENT instant in the two tests below, so the local and the UTC
// calendar are guaranteed to disagree whenever the suite runs. Before 12:00 UTC a UTC-12 zone is
// still on the previous day, and from 10:00 UTC on a UTC+14 zone is already on the next one, so
// one of the two always diverges. Both restore the machine zone by NAME, because deleting the
// variable does not put it back on this platform.
const divergentZone = () => (new Date().getUTCHours() < 12 ? 'Etc/GMT+12' : 'Etc/GMT-14');
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${
  String(d.getDate()).padStart(2, '0')}`;

test('today is the LOCAL calendar date, not the UTC one', () => {
  // A bare toISOString slice is UTC, so between local midnight and local 08:00 in Singapore it
  // names yesterday, and that is the working window this gets used in. Every date it is compared
  // against is local too: git's --date=short renders a commit in the commit's own zone.
  const home = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    process.env.TZ = divergentZone();
    const now = new Date();
    assert.notEqual(localDate(now), now.toISOString().slice(0, 10),
      'the chosen zone has to actually diverge, or this test proves nothing');
    assert.equal(today(), localDate(now));
  } finally {
    process.env.TZ = home;
  }
});

mtest('sync does not report the code a day ahead of a status written the same local day', () => {
  // The live repro: a status written seconds earlier read one day behind the code, the report
  // header printed yesterday, and STALE fired on a project nobody had touched. Both dates here
  // come from the same local day, so a STALE line means the two sides are on different calendars.
  const home = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    process.env.TZ = divergentZone();
    const day = localDate(new Date());
    assert.notEqual(day, new Date().toISOString().slice(0, 10), 'the chosen zone has to diverge');
    const root = fixture();
    cmdRegister(root, ['beacon', '--name', 'Beacon', '--repo', '.'], { commit: false });
    cmdCurrent(root, ['beacon'], 'All current.', { commit: false });
    const out = cmdSync(root, [], { commitDateFor: () => day });
    assert.match(out, new RegExp(`^projects sync \\(${day}\\):`), 'the header is the local day');
    assert.doesNotMatch(out, /STALE/, 'a commit made today is not ahead of a status written today');
  } finally {
    process.env.TZ = home;
  }
});

test('a line break in a store field cannot forge a second numbered list row', () => {
  // renderList interpolates raw store fields and the skill is told to relay the listing verbatim,
  // so a line break in one printed an extra numbered row of the store author's choosing, carrying
  // an uppercase token the skill greps. assertRenderable guards `name` on every WRITE path, which
  // is why the forge survived only on this read-only one, and it guards neither slug nor status.
  const out = renderList(fixture(), { version: 1, projects: [
    { slug: 'real', name: 'Real\n2. Ghost [ghost] (active): NO-PAGE nothing to see',
      status: 'active', where: [], page: null, lastTouched: '2026-07-29' },
    { slug: 'two', name: 'Two', status: 'active', where: [], page: null, lastTouched: '2026-07-28' },
  ] });
  assert.equal(out.split('\n').filter(Boolean).length, 2, 'two projects, two rows');
  // U+2028, U+2029 and a lone CR are all line starts to /m, and the squash covers every one of
  // them. Run on the unguarded fields too, so no field is left to a later reviewer.
  const BREAKS = ['\n', '\r', '\u2028', '\u2029'];
  for (const sep of BREAKS) {
    for (const field of ['name', 'slug', 'status']) {
      const p = { slug: 'a', name: 'A', status: 'active', where: [], page: null,
        lastTouched: '2026-07-29' };
      p[field] = `${p[field]}${sep}2. Ghost [ghost] (active): NO-PAGE forged`;
      const forged = renderList(fixture(), { version: 1, projects: [p] });
      assert.equal(forged.split(/[\n\r\u2028\u2029]/).filter(Boolean).length, 1,
        `${field} forged a row with U+${sep.charCodeAt(0).toString(16)}`);
    }
  }
});

test('a last verified date in prose below the stamp is not read as the stamp', () => {
  // Bounding the read to the header region was not enough on its own, because the header region IS
  // the narrative above the first `## `. The read scanned that region for a line carrying a DATE,
  // and the skeleton's own stamp says `never` and carries none, so a hand-written line-initial
  // stamp lower down won and the page reported clean. That errs toward a false pass.
  const block = `## Current state (2026-08-03)\n${CS_START}\nAll fine.\n${CS_END}\n`;
  const forged = `# T\n*last verified never · docs: none*\n\nSome narrative.\n`
    + `*last verified 2026-08-03 by hand*\n\n${block}`;
  assert.equal(lastVerifiedDate(forged), null, 'the first stamp line is the stamp, and it says never');
  // The shapes the header bound already protected, unchanged by the tighter one.
  assert.equal(lastVerifiedDate(forged.replace('never · docs', '2026-07-04 · docs')), '2026-07-04',
    'a real header stamp is still read');
  assert.equal(lastVerifiedDate(`# T\n    *last verified 2026-07-04*\n\n${block}`), null,
    'an indented stamp is not a stamp');
  assert.equal(lastVerifiedDate(`# T\n\n## Current state (2026-08-03)\n${CS_START}\n`
    + `*last verified 2026-07-04*\n${CS_END}\n`), null, 'nor is a line inside the block');
  assert.equal(lastVerifiedDate(`# T\n\nno stamp at all\n\n${block}`), null);
});

test('a flag handed another flag as its value is refused, not taken as the value', () => {
  // flag() takes the next argv element whatever it is, so `--name --status active` registered a
  // project literally NAMED "--status" at exit 0, and the name is what a human reads in the index.
  const { root } = gitFixture();
  const typo = runCli(root, ['register', 'demo', '--name', '--status', 'active']);
  // 2, not 1: a malformed argument value is "you asked for something that is not a thing", the
  // same class as `unknown status`, and every other argv refusal in this CLI exits 2.
  assert.equal(typo.status, 2, typo.stdout);
  assert.match(typo.stderr, /--name was given --status/);
  assert.ok(!existsSync(join(root, REL_STORE)), 'the row was never written');
  assert.ok(!existsSync(join(root, 'docs/projects/demo.md')), 'and no orphan page was left behind');
});

mtest('a store row that cannot render names its slug', () => {
  // Every mutating verb renders the whole index before writing anything, so one hand-edited row
  // refuses verbs that touch only healthy rows, while sync reports nothing about it. Neither throw
  // knew which row it came from, so the message sent a human through the whole file.
  const root = fixture();
  writeStore(root, { version: 1, projects: [
    { slug: 'good', name: 'Good', status: 'active', where: [], page: 'good.md', lastTouched: '2026-07-29' },
    { slug: 'piped', name: 'Bad | name', status: 'active', where: [], page: 'piped.md', lastTouched: '2026-07-29' },
  ] });
  assert.throws(() => cmdStatus(root, ['good', 'paused'], { commit: false }),
    /pipe or line break .*on project "piped"/);
  writeStore(root, { version: 1, projects: [
    { slug: 'good', name: 'Good', status: 'active', where: [], page: 'good.md', lastTouched: '2026-07-29' },
    { slug: 'typo', name: 'Typo', status: 'activ', where: [], page: 'typo.md', lastTouched: '2026-07-29' },
  ] });
  assert.throws(() => cmdStatus(root, ['good', 'paused'], { commit: false }),
    /unknown status .*on project "typo"/);
});

mtest('SKILL.md carries the page skeleton and the list row byte-exact', () => {
  // Verified by RUNNING the two functions rather than by eye. Both fences are what the skill hands
  // a model that has never seen this CLI, so a drifting fence is a false comment with a wider
  // blast radius than one in a source file.
  const root = fixture();
  cmdRegister(root, ['demo', '--name', 'Demo Project'], { commit: false, date: '2026-08-04' });
  const skill = readFileSync(fileURLToPath(new URL('../skills/projects/SKILL.md', import.meta.url)), 'utf8')
    .replaceAll('\r\n', '\n');
  const skeleton = skill.match(/```markdown\n([\s\S]*?)```/)[1]
    .replace('# <Name>', '# Demo Project').replaceAll('YYYY-MM-DD', '2026-08-04');
  assert.equal(skeleton, readFileSync(join(root, 'docs/projects/demo.md'), 'utf8'));
  assert.equal(skill.match(/```\n(1\.[^\n]*)\n```/)[1],
    renderList(root, readStore(root)).trimEnd());
});

import { cmdRename, cmdLog } from '../skills/projects/projects.mjs';

test('rename moves the row and its page, and git records it as a rename', () => {
  const { root, git } = gitFixture();
  runCli(root, ['register', 'ugly-derived-slug', '--name', 'Nice Project', '--status', 'active']);
  const r = runCli(root, ['rename', 'ugly-derived-slug', 'nice']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RENAMED/);

  const store = readStore(root);
  assert.equal(store.projects.length, 1, 'a rename is not an insert');
  assert.equal(store.projects[0].slug, 'nice');
  assert.equal(store.projects[0].page, 'nice.md', 'the page field follows the slug');
  assert.equal(store.projects[0].name, 'Nice Project', 'the display name is untouched');
  assert.ok(existsSync(join(root, 'docs/projects/nice.md')));
  assert.ok(!existsSync(join(root, 'docs/projects/ugly-derived-slug.md')), 'no page left behind');
  assert.match(readFileSync(join(root, REL_INDEX), 'utf8'), /\[Nice Project\]\(nice\.md\)/);

  // Both paths went to the commit, so git sees one rename rather than a delete plus an add.
  // -M is what makes the R status appear at all, and a stray untracked page would show as ??.
  const status = git('status', '--porcelain').toString();
  assert.equal(status.trim(), '', 'the rename is committed, nothing dangling');
  assert.match(git('show', '--name-status', '-M', 'HEAD').toString(), /^R\d*\s+.*ugly-derived-slug\.md/m);
});

test('rename refuses a taken slug, an unknown one, and itself, and changes nothing', () => {
  const { root } = gitFixture();
  runCli(root, ['register', 'alpha', '--name', 'Alpha', '--status', 'active']);
  runCli(root, ['register', 'beta', '--name', 'Beta', '--status', 'active']);
  const before = readFileSync(join(root, REL_STORE), 'utf8');

  // The exit codes split the way the rest of this CLI splits them. 2 is "what you named is not
  // a thing", so an unknown slug is a 2. A taken slug and a no-op rename are well-formed
  // requests the world refuses, which is the 1 that a refused page write already uses.
  const taken = runCli(root, ['rename', 'alpha', 'beta']);
  assert.equal(taken.status, 1, taken.stderr);
  assert.match(taken.stderr, /already registered/);

  const unknown = runCli(root, ['rename', 'nope', 'whatever']);
  assert.equal(unknown.status, 2, unknown.stderr);
  assert.match(unknown.stderr, /unknown project/);

  const itself = runCli(root, ['rename', 'alpha', 'alpha']);
  assert.equal(itself.status, 1, itself.stderr);
  assert.match(itself.stderr, /already its own slug/);

  assert.equal(readFileSync(join(root, REL_STORE), 'utf8'), before, 'the store is byte-identical');
  assert.ok(existsSync(join(root, 'docs/projects/alpha.md')));
  assert.ok(existsSync(join(root, 'docs/projects/beta.md')));
});

test('rename refuses to clobber an unrelated page already sitting at the new name', () => {
  const { root } = gitFixture();
  runCli(root, ['register', 'alpha', '--name', 'Alpha', '--status', 'active']);
  // A page with no row pointing at it. sync calls this NO-ROW, and it is somebody's narrative.
  writeFileSync(join(root, 'docs/projects/gamma.md'), '# Gamma\n\nhand written, no row\n');
  const r = runCli(root, ['rename', 'alpha', 'gamma']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /already a page at/);
  assert.match(readFileSync(join(root, 'docs/projects/gamma.md'), 'utf8'), /hand written/);
  assert.ok(existsSync(join(root, 'docs/projects/alpha.md')), 'the source page stayed put');
  assert.equal(readStore(root).projects[0].slug, 'alpha', 'and the row did not move');
});

test('rename leaves an already-divergent page basename alone', () => {
  const root = fixture();
  writeStore(root, { version: 1, projects: [{ slug: 'alpha', name: 'Alpha', status: 'active',
    where: [], page: 'deliberately-different.md', lastTouched: '2026-07-01' }] });
  writeFileSync(join(root, 'docs/projects/deliberately-different.md'), '# Alpha\n\nprose\n');
  cmdRename(root, ['alpha', 'omega'], { commit: false });
  const p = readStore(root).projects[0];
  assert.equal(p.slug, 'omega');
  assert.equal(p.page, 'deliberately-different.md', 'a page named on purpose is not renamed');
  assert.ok(existsSync(join(root, 'docs/projects/deliberately-different.md')));
});

test('rename does not bump lastTouched', () => {
  const root = fixture();
  writeStore(root, { version: 1, projects: [{ slug: 'alpha', name: 'Alpha', status: 'active',
    where: [], page: 'alpha.md', lastTouched: '2026-07-01' }] });
  writeFileSync(join(root, 'docs/projects/alpha.md'), '# Alpha\n');
  cmdRename(root, ['alpha', 'omega'], { commit: false });
  // Bookkeeping is not work on the project. Bumping this would restart sync's staleness window.
  assert.equal(readStore(root).projects[0].lastTouched, '2026-07-01');
});

test('log reads history from git and follows a page across a rename', () => {
  const { root } = gitFixture();
  runCli(root, ['register', 'alpha', '--name', 'Alpha', '--status', 'active']);
  runCli(root, ['current', 'alpha'], 'first state\n');
  runCli(root, ['rename', 'alpha', 'omega']);

  const all = runCli(root, ['log']);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /projects: register alpha/);
  assert.match(all.stdout, /projects: rename alpha to omega/);

  // Per slug it follows the page, so history from before the rename is still reachable under
  // the new slug. That is the one thing the store's own history cannot show.
  const one = runCli(root, ['log', 'omega']);
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /current state for alpha/, 'history predating the rename survives');

  assert.equal(runCli(root, ['log', 'nope']).status, 2, 'an unknown slug is a usage error');
  // A leading flag must not be read as a slug: the slug pattern permits a leading '-'.
  assert.equal(runCli(root, ['log', '-n', '1']).status, 0);
  assert.equal(runCli(root, ['log', '-n', '1']).stdout.trim().split('\n').length, 1);
});

test('rename warns when a gtg entry still names the old slug as its parent', () => {
  const { root } = gitFixture();
  runCli(root, ['register', 'alpha', '--name', 'Alpha', '--status', 'active']);
  mkdirSync(join(root, 'docs/handoffs'), { recursive: true });
  writeFileSync(join(root, 'docs/handoffs/_active.json'), JSON.stringify({ handoffs: [
    { slug: 'alpha', project: 'Alpha', parent: 'alpha' },
    { slug: 'unrelated', project: 'Unrelated', parent: 'something-else' }] }));
  writeFileSync(join(root, 'docs/handoffs/_backlog.json'), JSON.stringify({ backlog: [
    { slug: 'shelved-kid', project: 'Shelved Kid', parent: 'alpha' }] }));

  const r = runCli(root, ['rename', 'alpha', 'omega']);
  assert.equal(r.status, 0, r.stderr);
  // Both shelves are checked, because an entry on one can be a child of a family on the other.
  assert.match(r.stdout, /2 gtg entries still name "alpha" as their parent/);
  assert.match(r.stdout, /alpha, shelved-kid/);
  assert.doesNotMatch(r.stdout, /unrelated/, 'an entry with a different parent is not named');
  // A named remedy, not a dead end. This is the command that repairs it.
  assert.match(r.stdout, /gtg rename alpha omega/);

  // Read-only: this CLI must never write a store it does not own.
  const after = JSON.parse(readFileSync(join(root, 'docs/handoffs/_active.json'), 'utf8'));
  assert.equal(after.handoffs[0].parent, 'alpha', "gtg's store is untouched");
});

test('rename says nothing about gtg when there is no gtg store to read', () => {
  const { root } = gitFixture();
  runCli(root, ['register', 'alpha', '--name', 'Alpha', '--status', 'active']);
  const r = runCli(root, ['rename', 'alpha', 'omega']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /gtg/, 'gtg not installed here is not a problem worth a word');
});

test('the store guard has no bypass parameter left', () => {
  // allowLegacy was the migration's door past this guard. The migration is gone, so a second
  // argument must not be able to reopen it.
  // The table shapes and the verbs are covered above. What is new here is that no SECOND
  // ARGUMENT reopens the guard, which is the point of deleting the parameter and not just its
  // one caller. A real rendered index, because the guard counts parsed rows.
  const root = fixture();
  writeFileSync(join(root, REL_INDEX), renderIndex({ version: 1, projects: [{ slug: 'beacon',
    name: 'Beacon', status: 'active', where: [], page: 'beacon.md', lastTouched: '2026-07-29' }] }), 'utf8');
  assert.throws(() => readStore(root), /Migrate it first/);
  assert.throws(() => readStore(root, true), /Migrate it first/, 'a stray truthy arg is not a bypass');
});

import { cmdSet } from '../skills/projects/projects.mjs';

test('set changes where, repo and name, and clears repo with an empty string', () => {
  const { root } = gitFixture();
  runCli(root, ['register', 'alpha', '--name', 'Alpha', '--status', 'active', '--where', 'old place']);
  assert.equal(readStore(root).projects[0].repo, undefined, 'register without --repo leaves it absent');

  const r = runCli(root, ['set', 'alpha', '--where', 'C:/dev/alpha', '--repo', 'C:/dev/alpha']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SET/);
  let p = readStore(root).projects[0];
  assert.deepEqual(p.where, ['C:/dev/alpha']);
  assert.equal(p.repo, 'C:/dev/alpha');
  assert.equal(p.name, 'Alpha', 'a field not passed is not touched');
  assert.match(readFileSync(join(root, REL_INDEX), 'utf8'), /C:\/dev\/alpha/, 'the index re-rendered');

  runCli(root, ['set', 'alpha', '--name', 'Alpha Renamed']);
  p = readStore(root).projects[0];
  assert.equal(p.name, 'Alpha Renamed');
  assert.equal(p.repo, 'C:/dev/alpha', 'and repo survived a name-only set');

  // Empty string CLEARS, for a project whose checkout is gone. The key is deleted, so absent
  // has one representation rather than two.
  runCli(root, ['set', 'alpha', '--repo', '']);
  assert.ok(!('repo' in readStore(root).projects[0]), 'the key is deleted, not set to empty');
});

test('set refuses an unknown project, an empty change, and an unrenderable value', () => {
  const { root } = gitFixture();
  runCli(root, ['register', 'alpha', '--name', 'Alpha', '--status', 'active']);
  const before = readFileSync(join(root, REL_STORE), 'utf8');

  assert.equal(runCli(root, ['set', 'nope', '--repo', 'x']).status, 2, 'unknown project is a 2');
  const empty = runCli(root, ['set', 'alpha']);
  assert.equal(empty.status, 1, 'a valid request that asks for nothing is a 1');
  assert.match(empty.stderr, /nothing to set/);

  // A pipe would shift every column after it. Checked before anything is assigned.
  const piped = runCli(root, ['set', 'alpha', '--where', 'a | b']);
  assert.equal(piped.status, 1);
  assert.match(piped.stderr, /pipe or line break/);
  assert.equal(readFileSync(join(root, REL_STORE), 'utf8'), before, 'the store is byte-identical');
});

test('set does not bump lastTouched', () => {
  const root = fixture();
  writeStore(root, { version: 1, projects: [{ slug: 'alpha', name: 'Alpha', status: 'active',
    where: [], page: 'alpha.md', lastTouched: '2026-07-01' }] });
  writeFileSync(join(root, 'docs/projects/alpha.md'), '# Alpha\n');
  cmdSet(root, ['alpha', '--repo', 'C:/dev/alpha'], { commit: false });
  // Bookkeeping is not work on the project, same reasoning as rename.
  assert.equal(readStore(root).projects[0].lastTouched, '2026-07-01');
});

test('SKILL.md frontmatter carries no unquoted colon-space', () => {
  // A plain YAML scalar cannot contain ": ", so the unquoted description that shipped in 1.0.0
  // made the whole frontmatter unparseable and Claude Code dropped the skill from its registry
  // without a word: the plugin installed, the hook and the CLI worked, and only the skill was
  // missing (2026-08-04). Regex rather than a YAML parser because this package has no
  // dependencies and this is the only failure mode that has bitten. Quote it, or keep ": " out.
  const fm = readFileSync(fileURLToPath(new URL('../skills/projects/SKILL.md', import.meta.url)), 'utf8')
    .replaceAll('\r\n', '\n').split('---')[1];
  const keys = [];
  for (const line of fm.split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (!m) continue;
    keys.push(m[1]);
    assert.ok(/^['"]/.test(m[2]) || !m[2].includes(': '), `${m[1]} holds ": " and is not quoted`);
  }
  assert.deepEqual(keys, ['name', 'description'], 'both keys are still there to check');
});

test('THEME_ORDER is the enum key order, and every theme has a label', () => {
  assert.deepEqual(THEME_ORDER,
    ['work', 'job-search', 'tooling', 'homelab', 'worldbuilding', 'personal']);
  assert.equal(THEMES['job-search'], 'Job search');
  assert.equal(THEME_ORDER.length, Object.keys(THEMES).length);
});

test('validateTheme returns a known theme and refuses an unknown one', () => {
  assert.equal(validateTheme('homelab'), 'homelab');
  assert.throws(() => validateTheme('wrok'), /unknown theme "wrok"/);
  // No `projects: ` prefix, so DELIBERATE keeps recognising it as a deliberate refusal
  // rather than a bug in this file, exactly as validateStatus is treated.
  assert.throws(() => validateTheme('wrok'), (e) => !e.message.startsWith('projects: '));
});

const THEMED = { version: 1, projects: [
  { slug: 'beacon', name: 'Beacon', status: 'active', theme: 'tooling',
    where: ['C:/dev/beacon'], page: 'beacon.md', lastTouched: '2026-07-20' },
  { slug: 'atlas', name: 'Atlas', status: 'paused', theme: 'work',
    where: [], page: 'atlas.md', lastTouched: '2026-07-18' },
] };

test('renderIndex emits one section per non-empty theme in THEME_ORDER', () => {
  const out = renderIndex(THEMED);
  assert.match(out, /## Work/);
  assert.match(out, /## Tooling/);
  // Work is ahead of Tooling in THEME_ORDER, whatever the rows' own sort order says.
  assert.ok(out.indexOf('## Work') < out.indexOf('## Tooling'));
  // A theme with no rows renders no heading and no empty table.
  assert.doesNotMatch(out, /## Homelab/);
  // Each section carries its own header and separator.
  assert.equal(out.split('| Project | Status | Where | Last touched |').length - 1, 2);
});

test('a themed index round-trips byte for byte through parseIndex', () => {
  assert.equal(renderIndex(parseIndex(renderIndex(THEMED))), renderIndex(THEMED));
  assert.deepEqual(parseIndex(renderIndex(THEMED)).projects.map((p) => p.theme),
    ['work', 'tooling']);
});

test('an unrecognised theme names itself, and a themeless row lands in Unthemed last', () => {
  const odd = { version: 1, projects: [
    { slug: 'a', name: 'A', status: 'active', theme: 'wrok', where: [], page: 'a.md', lastTouched: '2026-08-01' },
    { slug: 'b', name: 'B', status: 'active', where: [], page: 'b.md', lastTouched: '2026-08-01' },
    { slug: 'c', name: 'C', status: 'active', theme: 'work', where: [], page: 'c.md', lastTouched: '2026-08-01' },
  ] };
  const out = renderIndex(odd);
  assert.match(out, /## wrok/);
  assert.match(out, /## Unthemed/);
  assert.ok(out.indexOf('## Work') < out.indexOf('## wrok'));
  assert.ok(out.indexOf('## wrok') < out.indexOf('## Unthemed'));
  // A true inverse for all three cases, so nothing is silently relabelled on re-render.
  assert.equal(renderIndex(parseIndex(out)), out);
});

test('a flat index with no headings still parses to the right row count', () => {
  // This is the pre-change INDEX.md shape. indexRowCount reads it through parseIndex, and a
  // wrong count here makes readStore refuse every verb.
  const flat = [
    '| Project | Status | Where | Last touched |',
    '|---|---|---|---|',
    '| [Beacon](beacon.md) | 🟢 active | C:/dev/beacon | 2026-07-20 |',
    '| [Atlas](atlas.md) | 🟡 paused |  | 2026-07-18 |',
  ].join('\n');
  const parsed = parseIndex(flat);
  assert.equal(parsed.projects.length, 2);
  assert.equal(parsed.projects[0].theme, undefined);
});
