import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { slugify, sprintPath, readSprint, writeSprint, UsageError } from '../skills/learn/learn.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'learn-'));

test('slugify collapses spaces and punctuation', () => {
  assert.equal(slugify('Growth Marketing'), 'growth-marketing');
  assert.equal(slugify('node.js'), 'node-js');
  assert.equal(slugify('  SQL  '), 'sql');
});

test('store round-trips a sprint unchanged', () => {
  const root = tmp();
  const sprint = {
    slug: 'learning-marketing', subject: 'Marketing', track: 'concept',
    created: '2026-08-17T09:00:00.000Z', content: 'docs/learning/marketing/x',
    research: null, week: 1, concept: null, gates: [], verify: [],
  };
  writeSprint(root, sprint);
  assert.deepEqual(readSprint(root, 'learning-marketing'), sprint);
  rmSync(root, { recursive: true, force: true });
});

test('reading a sprint that does not exist returns null, not a throw', () => {
  const root = tmp();
  assert.equal(readSprint(root, 'nope'), null);
  rmSync(root, { recursive: true, force: true });
});

test('sprintPath refuses a slug with a path separator', () => {
  assert.throws(() => sprintPath('/r', '../escape'), UsageError);
  assert.throws(() => sprintPath('/r', '../escape'), /invalid slug/);
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { TRACK_HEADINGS, parseTrack, trackFile, listTracks } from '../skills/learn/learn.mjs';

const TRACK_FIXTURE = `# demo — a demo track

## Pick this when
the subject produces a demo.

## Artifact floor
a demo you wrote.

## Session shape
A: demo. B: demo more.

## Mastery gate
demo it from memory.

## Verify exercise
spot the broken demo.

## Sequencing
project-first, because demos need a project.
`;

test('parseTrack reads every required heading', () => {
  const t = parseTrack(TRACK_FIXTURE);
  for (const h of TRACK_HEADINGS) assert.ok(t[h], `missing section: ${h}`);
  assert.equal(t['Sequencing'], 'project-first, because demos need a project.');
});

test('a user track overrides a bundled track of the same name', () => {
  const root = tmp();
  mkdirSync(join(root, '.learn', 'tracks'), { recursive: true });
  writeFileSync(join(root, '.learn', 'tracks', 'code.md'), TRACK_FIXTURE);
  const hit = trackFile(root, 'code');
  assert.equal(hit.source, 'user');
  rmSync(root, { recursive: true, force: true });

  // Mirror case: with no user tracks dir at all, the same name must resolve bundled.
  // Each half fails if precedence flips, which is what actually proves the ordering.
  const bare = tmp();
  const fallback = trackFile(bare, 'code');
  assert.equal(fallback.source, 'bundled');
  rmSync(bare, { recursive: true, force: true });
});

test('listTracks labels bundled and user tracks and dedupes by name', () => {
  const root = tmp();
  mkdirSync(join(root, '.learn', 'tracks'), { recursive: true });
  writeFileSync(join(root, '.learn', 'tracks', 'code.md'), TRACK_FIXTURE);
  writeFileSync(join(root, '.learn', 'tracks', 'language.md'), TRACK_FIXTURE);
  // Sorted, not directory order: the point is which names exist and which source each
  // carries (bundled vs. user), not the order the filesystem happens to hand them back —
  // and the bundled-tracks count grows over time (code, concept, ...) without this test
  // caring how many there are.
  const names = listTracks(root).map((t) => `${t.name}:${t.source}`).sort();
  assert.deepEqual(names, ['code:user', 'concept:bundled', 'language:user']);
  rmSync(root, { recursive: true, force: true });

  // No user tracks directory at all: falls back to the bundled list, doesn't throw.
  const bare = tmp();
  const bareNames = listTracks(bare).map((t) => `${t.name}:${t.source}`).sort();
  assert.deepEqual(bareNames, ['code:bundled', 'concept:bundled']);
  rmSync(bare, { recursive: true, force: true });
});

test('trackFile refuses a name with a path separator', () => {
  assert.throws(() => trackFile('/r', '../evil'), UsageError);
  assert.throws(() => trackFile('/r', '../evil'), /invalid track name/);
});

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRoot } from '../skills/learn/learn.mjs';

const withLearnHub = (value, fn) => {
  const prev = process.env.LEARN_HUB;
  if (value === undefined) delete process.env.LEARN_HUB; else process.env.LEARN_HUB = value;
  try { return fn(); }
  finally { if (prev === undefined) delete process.env.LEARN_HUB; else process.env.LEARN_HUB = prev; }
};

test('resolveRoot prefers LEARN_HUB when it is set', () => {
  withLearnHub('/some/hub', () => {
    assert.equal(resolveRoot(), '/some/hub');
  });
});

test('resolveRoot falls back to git rev-parse --show-toplevel when LEARN_HUB is unset', () => {
  withLearnHub(undefined, () => {
    const expected = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    assert.equal(resolveRoot(), expected);
  });
});

test('resolveRoot exits 2 with a message when neither LEARN_HUB nor a git repo is available', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-norepo-'));
  const cliPath = fileURLToPath(new URL('../skills/learn/learn.mjs', import.meta.url));
  const env = { ...process.env };
  delete env.LEARN_HUB;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  // tmpdir() can itself sit inside an ambient git repo (it does on this machine: the
  // home mirror), and GIT_CEILING_DIRECTORIES does not reliably stop discovery there.
  // Blank PATH so the child can't find a git binary at all, which hits the same
  // catch -> die(2) branch as "not in a repo" without depending on filesystem layout.
  env.PATH = '';
  env.Path = '';
  const result = spawnSync(process.execPath, [cliPath, 'tracks'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.ok(result.stderr.length > 0);
  rmSync(dir, { recursive: true, force: true });
});

test('slugify throws on input that reduces to nothing', () => {
  assert.throws(() => slugify('!!!'), UsageError);
  assert.throws(() => slugify('!!!'), /!!!/);
  assert.throws(() => slugify('   '), UsageError);
  assert.throws(() => slugify('   '), /   /);
});

import { newSprint } from '../skills/learn/learn.mjs';

test('newSprint builds a sprint at week 1 with no concept and no history', () => {
  const s = newSprint({
    subject: 'Growth Marketing', track: 'concept',
    contentRoot: 'docs/learning', now: '2026-08-17T09:00:00.000Z',
  });
  assert.equal(s.slug, 'learning-growth-marketing');
  assert.equal(s.subject, 'Growth Marketing');
  assert.equal(s.track, 'concept');
  assert.equal(s.week, 1);
  assert.equal(s.concept, null);
  assert.equal(s.research, null);
  assert.deepEqual(s.gates, []);
  assert.deepEqual(s.verify, []);
  assert.equal(s.content, 'docs/learning/learning-growth-marketing');
  assert.equal(s.created, '2026-08-17T09:00:00.000Z');
});

test('newSprint slugifies a subject that would break a path', () => {
  const s = newSprint({ subject: 'node.js', track: 'code', contentRoot: 'docs/learning', now: 'T' });
  assert.equal(s.slug, 'learning-node-js');
});

// Closes a gap deferred from Task 1: nothing previously exercised main()'s catch, because
// no verb reached a throwing guard. `start` is the first one that does, via newSprint ->
// slugify. This proves the guard throws, main classifies it as a usage error, and the
// process exits 2, which no in-process test can show together.
test('start exits 2 when the subject slugifies to nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-startslug-'));
  const cliPath = fileURLToPath(new URL('../skills/learn/learn.mjs', import.meta.url));
  const env = { ...process.env, LEARN_HUB: dir };
  const result = spawnSync(process.execPath, [cliPath, 'start', '!!!', '--track', 'code'], { encoding: 'utf8', env });
  assert.equal(result.status, 2);
  assert.ok(result.stderr.length > 0);
  rmSync(dir, { recursive: true, force: true });
});

test('start exits 1 when a sprint with that slug already exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-startexists-'));
  const cliPath = fileURLToPath(new URL('../skills/learn/learn.mjs', import.meta.url));
  const env = { ...process.env, LEARN_HUB: dir };
  const args = [cliPath, 'start', 'Growth Marketing', '--track', 'code'];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  assert.equal(first.status, 0);
  const second = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  assert.equal(second.status, 1);
  assert.ok(second.stderr.length > 0);
  rmSync(dir, { recursive: true, force: true });
});

import { verifyDue, applyGate, VERIFY_FLOOR_WEEKS } from '../skills/learn/learn.mjs';

const sprintAt = (week, verify = []) => ({
  slug: 's', subject: 'S', track: 'concept', created: 'T', content: 'c',
  research: null, week, concept: 'positioning', gates: [], verify,
});

test('verify floor: never run, due from week 2', () => {
  assert.equal(verifyDue(sprintAt(1)), false);
  assert.equal(verifyDue(sprintAt(2)), true);
});

// A never-verified sprint stays due once it is past the floor. Pins the "treat no verify
// as week 0" reading: anything that reset the baseline to the current week reads false here.
test('verify floor: never run, still due past the floor', () => {
  assert.equal(verifyDue(sprintAt(3)), true);
  assert.equal(verifyDue(sprintAt(9)), true);
});

test('verify floor boundary at N-1, N, N+1 after a week-1 verify', () => {
  assert.equal(verifyDue(sprintAt(2, [1])), false); // gap 1
  assert.equal(verifyDue(sprintAt(3, [1])), true);  // gap 2, the floor
  assert.equal(verifyDue(sprintAt(4, [1])), true);  // gap 3, overdue
});

// The same boundary one week further along, so an implementation that hardcoded week 3
// rather than the gap fails here. The floor is a gap, not a week number.
test('verify floor boundary walks with the latest verify', () => {
  assert.equal(verifyDue(sprintAt(6, [5])), false); // gap 1
  assert.equal(verifyDue(sprintAt(7, [5])), true);  // gap 2, the floor
});

test('verify floor reads the LATEST verify, not the first', () => {
  assert.equal(verifyDue(sprintAt(4, [1, 3])), false);
});

// The brief's [1, 3] is sorted, so last-entry and max agree there and cannot be told apart.
// Unsorted input separates them: the last entry is 1, so the gap is 3 and the floor fires.
// Reading the max would give 3, a gap of 1, and would swallow the nag.
test('verify floor takes the LAST entry of verify, not the largest', () => {
  assert.equal(verifyDue(sprintAt(4, [3, 1])), true);
});

test('gate pass advances the week and clears the concept', () => {
  const s = applyGate(sprintAt(2), 'pass', { now: 'T2' });
  assert.equal(s.week, 3);
  assert.equal(s.concept, null);
  assert.deepEqual(s.gates, [{ week: 2, concept: 'positioning', result: 'pass', at: 'T2' }]);
});

test('gate fail advances the week but KEEPS the concept, so it repeats', () => {
  const s = applyGate(sprintAt(2), 'fail', { now: 'T2' });
  assert.equal(s.week, 3);
  assert.equal(s.concept, 'positioning');
});

test('gate --verified records the week the verify exercise actually ran', () => {
  const s = applyGate(sprintAt(3, [1]), 'pass', { now: 'T3', verified: true });
  assert.deepEqual(s.verify, [1, 3]);
  assert.equal(verifyDue(s), false);
});

// The gate log is the history; the verify list is the floor's input. A gate without
// --verified must not feed the floor, or every session silently counts as a verify.
test('a gate without --verified logs the gate but not a verify', () => {
  const s = applyGate(sprintAt(3, [1]), 'pass', { now: 'T3' });
  assert.deepEqual(s.verify, [1]);
  assert.equal(s.gates.length, 1);
  assert.equal(verifyDue(s), true);
});

// The week recorded is the week the exercise ran, not the week the sprint moved to.
test('gate --verified records the pre-increment week', () => {
  const s = applyGate(sprintAt(5), 'fail', { now: 'T5', verified: true });
  assert.equal(s.week, 6);
  assert.deepEqual(s.verify, [5]);
  assert.equal(verifyDue(s), false); // gap 1 at week 6
});

test('gate rejects a result that is not pass or fail', () => {
  assert.throws(() => applyGate(sprintAt(1), 'maybe', { now: 'T' }), /pass or fail/);
  // A UsageError specifically: main() maps only that to exit 2, so a plain Error here would
  // give the first non-CLI caller exit 1 and a stack where the contract says 2.
  assert.throws(() => applyGate(sprintAt(1), 'maybe', { now: 'T' }), UsageError);
});

test('the verify floor constant is 2 weeks', () => {
  assert.equal(VERIFY_FLOOR_WEEKS, 2);
});

const learnCli = fileURLToPath(new URL('../skills/learn/learn.mjs', import.meta.url));
const run = (dir, ...args) =>
  spawnSync(process.execPath, [learnCli, ...args], {
    encoding: 'utf8', env: { ...process.env, LEARN_HUB: dir, NO_COLOR: '1' },
  });

// Every other CLI test invokes learn.mjs by its real path, which is why the entry-point guard
// could compare path FORMS and still look correct. An installed plugin is not reached by its
// real path: the work account's plugin cache sits behind a junction, node resolved the module
// to its real target, argv[1] kept the link path, the guard's equality failed, and every verb
// exited 0 printing nothing. This invokes through a link so the guard is pinned to behaviour
// rather than to a path shape.
test('the CLI runs when invoked through a linked path, not only its real path', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-link-'));
  const link = join(dir, 'linked-skill');
  try {
    symlinkSync(dirname(learnCli), link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return t.skip(`cannot create a link here: ${e.code ?? e.message}`);
  }
  const r = spawnSync(process.execPath, [join(link, 'learn.mjs'), 'help'], {
    encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /learn tracks/, 'main() did not run through the link');
  rmSync(dir, { recursive: true, force: true });
});

// Proves the whole chain the pure tests cannot: the counter is read from disk, advanced,
// and written back, and the marker the skill relays matches the stored state.
test('gate CLI advances the sprint on disk and prints ADVANCED', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-gatecli-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);

  const r = run(dir, 'gate', 'pass');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ADVANCED to week 2/);
  // gate emits its own VERIFY-DUE, separately from week()'s. Only the week() call further down
  // used to be asserted, so deleting gate's line would not have failed anything.
  assert.match(r.stdout, /^VERIFY-DUE  next session must include a verify exercise\.$/m);

  const s = readSprint(dir, 'learning-growth-marketing');
  assert.equal(s.week, 2);
  assert.equal(s.concept, null);
  assert.deepEqual(s.gates.map((g) => g.result), ['pass']);
  assert.deepEqual(s.verify, []);
  assert.ok(s.gates[0].at, 'gate must stamp a time');

  // Second session with no verify yet: week 2 against never-verified is the floor exactly,
  // so the CLI must say so rather than the skill having to work it out.
  const second = run(dir, 'week');
  assert.equal(second.status, 0);
  assert.match(second.stdout, /week 2/);
  assert.match(second.stdout, /VERIFY-DUE/);
  rmSync(dir, { recursive: true, force: true });
});

test('gate --verified clears VERIFY-DUE for the following week', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-gateverified-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  assert.equal(run(dir, 'gate', 'pass', '--verified').status, 0);

  const s = readSprint(dir, 'learning-growth-marketing');
  assert.deepEqual(s.verify, [1]);
  const w = run(dir, 'week');
  assert.equal(w.status, 0);
  assert.ok(!w.stdout.includes('VERIFY-DUE'), `expected no VERIFY-DUE, got: ${w.stdout}`);
  rmSync(dir, { recursive: true, force: true });
});

test('gate exits 2 without a pass or fail argument', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-gatenoarg-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  const r = run(dir, 'gate');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pass\|fail/);
  // A rejected gate must not have moved the counter.
  assert.equal(readSprint(dir, 'learning-growth-marketing').week, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('week and gate exit 2 when there is no sprint at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-nosprint-'));
  for (const args of [['week'], ['gate', 'pass']]) {
    const r = run(dir, ...args);
    assert.equal(r.status, 2, `${args.join(' ')} should exit 2`);
    assert.match(r.stderr, /no sprint here/);
  }
  rmSync(dir, { recursive: true, force: true });
});

// Two sprints is the case where guessing writes a gate onto the wrong subject, so the
// ambiguity must be an error, and --sprint must key off the slug.
test('two sprints: bare gate exits 2, --sprint mutates only the named one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-twosprints-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  assert.equal(run(dir, 'start', 'Statistics', '--track', 'code').status, 0);

  const ambiguous = run(dir, 'gate', 'pass');
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.stderr, /more than one sprint/);
  assert.match(ambiguous.stderr, /--sprint/);

  assert.equal(run(dir, 'gate', 'pass', '--sprint', 'learning-statistics').status, 0);
  assert.equal(readSprint(dir, 'learning-statistics').week, 2);
  assert.equal(readSprint(dir, 'learning-growth-marketing').week, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('gate exits 2 when --sprint names a sprint that does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-badsprint-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  const r = run(dir, 'gate', 'pass', '--sprint', 'learning-nope');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no sprint 'learning-nope'/);
  rmSync(dir, { recursive: true, force: true });
});

// Every sprint reachable today has concept null, so an unguarded interpolation puts the
// literal string "null" into a marker line the skill relays verbatim.
test('gate fail prints REPEAT with no literal null, and keeps the concept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-gatefail-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);

  const r = run(dir, 'gate', 'fail');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /REPEAT the same concept at week 2/);
  assert.ok(!r.stdout.includes('null'), `marker line leaked null: ${r.stdout}`);

  const s = readSprint(dir, 'learning-growth-marketing');
  assert.equal(s.week, 2);
  assert.equal(s.concept, null, 'a fail must not clear the concept');
  assert.deepEqual(s.gates.map((g) => g.result), ['fail']);
  rmSync(dir, { recursive: true, force: true });
});

// Seeds a concept directly. Before this task, week() inferred REPEAT from sprint.concept
// being non-null, which stops being sound once page() sets concept on a week that was never
// gated at all. This sprint has no gates, so week() must NOT claim REPEAT; gate() still can,
// since its branch is keyed off the result it was actually just called with, not this predicate.
test('week does not report REPEAT for a fresh concept with no gates yet, and gate still names it on fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-concept-'));
  writeSprint(dir, {
    slug: 'learning-seeded', subject: 'Seeded', track: 'code', created: 'T',
    content: 'docs/learning/learning-seeded', research: null,
    week: 3, concept: 'positioning', gates: [], verify: [],
  });

  const w = run(dir, 'week');
  assert.equal(w.status, 0);
  assert.ok(!w.stdout.includes('REPEAT'), `expected no REPEAT with no gates yet, got: ${w.stdout}`);
  assert.match(w.stdout, /positioning/);

  const g = run(dir, 'gate', 'fail');
  assert.equal(g.status, 0);
  assert.match(g.stdout, /REPEAT positioning at week 4/);
  assert.equal(readSprint(dir, 'learning-seeded').concept, 'positioning');
  rmSync(dir, { recursive: true, force: true });
});

// The other half of the same fix: a concept picked (by page()) for the week AFTER a pass
// also leaves sprint.concept non-null, with the last gate result 'pass'. week() must not
// report REPEAT here either — this is the case the task-5 brief calls out explicitly.
test('week does not report REPEAT when the last gate passed, even with a concept already picked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-concept-pass-'));
  writeSprint(dir, {
    slug: 'learning-seeded2', subject: 'Seeded', track: 'code', created: 'T',
    content: 'docs/learning/learning-seeded2', research: null,
    week: 3, concept: 'positioning',
    gates: [{ week: 2, concept: 'positioning', result: 'pass', at: 'T' }], verify: [],
  });

  const w = run(dir, 'week');
  assert.equal(w.status, 0);
  assert.ok(!w.stdout.includes('REPEAT'), `expected no REPEAT after a pass, got: ${w.stdout}`);
  // Positive pin, not just the negative above: gates is non-empty here, so the unconditional
  // "last gate: week 2 positioning -> pass" line also contains "positioning", and a regression
  // that fell into the wrong (no-concept) branch would still be REPEAT-free. This line can only
  // come from the middle branch actually firing.
  assert.match(w.stdout, /^ADVANCED  positioning — picked, not yet gated\.$/m);
  rmSync(dir, { recursive: true, force: true });
});

// And a sprint with no gates at all and NO concept: the plain "pick one" message, unaffected
// by the fix, stays correct.
test('week with no concept and no gates reports ADVANCED with no REPEAT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-noconcept-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  const w = run(dir, 'week');
  assert.equal(w.status, 0);
  assert.ok(!w.stdout.includes('REPEAT'));
  assert.match(w.stdout, /ADVANCED/);
  rmSync(dir, { recursive: true, force: true });
});

// The global rule is that a failed write prints what is on disk and exits non-zero. The
// guard lives in writeSprint, so start, gate and every later verb inherit it; a read-only
// sprint file is the cheapest way to make a real write fail.
test('a failed write exits 1 and prints the on-disk state, not ADVANCED', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-writefail-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  const file = sprintPath(dir, 'learning-growth-marketing');
  chmodSync(file, 0o444);

  const r = run(dir, 'gate', 'pass');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not write/);
  assert.match(r.stderr, /on disk now/);
  assert.match(r.stderr, /"week": 1/, `on-disk state was not printed: ${r.stderr}`);
  assert.ok(!r.stdout.includes('ADVANCED'), `a failed write printed success: ${r.stdout}`);

  chmodSync(file, 0o666);
  assert.equal(readSprint(dir, 'learning-growth-marketing').week, 1);
  rmSync(dir, { recursive: true, force: true });
});

import { readFileSync, existsSync } from 'node:fs';
import { renderPage, renderBrief, profilePath } from '../skills/learn/learn.mjs';

test('renderPage opens with a GFM TIP objective callout', () => {
  const md = renderPage({ subject: 'Marketing', week: 2, concept: 'positioning' });
  assert.match(md, /^# Week 2 — positioning$/m);
  assert.match(md, /^> \[!TIP\]$/m);
  assert.match(md, /^## Worked example$/m);
  assert.match(md, /^## The principle it generalises to$/m);
  assert.match(md, /^## Sources$/m);
  assert.match(md, /^## Worksheet$/m);
});

test('renderBrief emits the contract fields in contract order', () => {
  const md = renderBrief({
    slug: 'marketing-curriculum', root: 'docs/research', shape: 'synthesis+notes',
    body: 'angle:  seed a concept-track sprint\ncorpus:\n  - Ries and Trout, Positioning',
  });
  const lines = md.split('\n');
  assert.equal(lines[0], '# Corpus brief');
  assert.equal(lines.findIndex((l) => l.startsWith('slug:')), 1);
  assert.ok(lines.findIndex((l) => l.startsWith('root:')) === 2);
  assert.ok(lines.findIndex((l) => l.startsWith('shape:')) === 3);
  assert.ok(lines.findIndex((l) => l.startsWith('angle:')) > 3);
  assert.ok(lines.findIndex((l) => l.startsWith('corpus:')) >
            lines.findIndex((l) => l.startsWith('angle:')));
});

test('renderBrief does not hard-wrap the angle it was handed', () => {
  const long = 'angle:  ' + 'x'.repeat(200) + '\ncorpus:\n  - a';
  assert.ok(renderBrief({ slug: 's', root: 'r', shape: 'synthesis', body: long }).includes('x'.repeat(200)));
});

test('renderBrief rejects a shape outside the contract', () => {
  assert.throws(() => renderBrief({ slug: 's', root: 'r', shape: 'bogus', body: 'angle: x\ncorpus:\n  - a' }), UsageError);
});

test('page writes the week page, stamps the concept onto the sprint, and prints PAGE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-page-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);

  const r = run(dir, 'page', 'Positioning');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^PAGE /m);

  const s = readSprint(dir, 'learning-growth-marketing');
  assert.equal(s.concept, 'Positioning');
  const file = join(dir, s.content, 'week-1-positioning.md');
  assert.ok(existsSync(file), `expected ${file} to exist`);
  assert.match(readFileSync(file, 'utf8'), /^# Week 1 — Positioning$/m);
  rmSync(dir, { recursive: true, force: true });
});

test('page exits 2 with no concept argument and none already on the sprint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-pagenoarg-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  const r = run(dir, 'page');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: learn page/);
  rmSync(dir, { recursive: true, force: true });
});

test('page refuses to overwrite a page that already exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-pageexists-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  assert.equal(run(dir, 'page', 'Positioning').status, 0);
  const r = run(dir, 'page', 'Positioning');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already exists/);
  rmSync(dir, { recursive: true, force: true });
});

const runWithInput = (dir, input, ...args) =>
  spawnSync(process.execPath, [learnCli, ...args], {
    encoding: 'utf8', input, env: { ...process.env, LEARN_HUB: dir, NO_COLOR: '1' },
  });

test('brief writes the corpus brief in contract order and prints BRIEF-WRITTEN', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-brief-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);

  const stdin = 'angle:  seed a concept-track sprint\ncorpus:\n  - Ries and Trout, Positioning\n';
  const r = runWithInput(dir, stdin, 'brief');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^BRIEF-WRITTEN /m);

  const s = readSprint(dir, 'learning-growth-marketing');
  const file = join(dir, s.content, 'corpus-brief-week-1.md');
  const md = readFileSync(file, 'utf8');
  assert.match(md, /^# Corpus brief$/m);
  assert.match(md, /^root:\s+docs\/research$/m);
  assert.match(md, /^slug:\s+learning-growth-marketing-week-1$/m);
  rmSync(dir, { recursive: true, force: true });
});

test('brief exits 2 when stdin is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-briefempty-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  const r = runWithInput(dir, '', 'brief');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /reads angle and corpus on stdin/);
  rmSync(dir, { recursive: true, force: true });
});

test('brief exits 2 when --shape is outside the contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-briefshape-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  const r = runWithInput(dir, 'angle: x\ncorpus:\n  - a\n', 'brief', '--shape', 'bogus');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /shape must be one of/);
  rmSync(dir, { recursive: true, force: true });
});

test('brief --tier scan writes the tier line after shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-brieftier-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  const r = runWithInput(dir, 'angle: x\ncorpus:\n  - a\n', 'brief', '--shape', 'synthesis', '--tier', 'scan');
  assert.equal(r.status, 0, r.stderr);
  const s = readSprint(dir, 'learning-growth-marketing');
  const md = readFileSync(join(dir, s.content, 'corpus-brief-week-1.md'), 'utf8');
  const lines = md.split('\n');
  assert.equal(lines[3], 'shape:  synthesis');
  assert.equal(lines[4], 'tier:   scan');
  rmSync(dir, { recursive: true, force: true });
});

test('brief without --tier writes no tier line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-briefnotier-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  const r = runWithInput(dir, 'angle: x\ncorpus:\n  - a\n', 'brief');
  assert.equal(r.status, 0, r.stderr);
  const s = readSprint(dir, 'learning-growth-marketing');
  assert.doesNotMatch(readFileSync(join(dir, s.content, 'corpus-brief-week-1.md'), 'utf8'), /^tier:/m);
  rmSync(dir, { recursive: true, force: true });
});

test('brief exits 2 when --tier is outside scan|pack', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-brieftierbad-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  const r = runWithInput(dir, 'angle: x\ncorpus:\n  - a\n', 'brief', '--tier', 'deep');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /tier must be one of/);
  rmSync(dir, { recursive: true, force: true });
});

test('a brief per week: week 2 writes a second file instead of refusing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-briefweek2-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  assert.equal(runWithInput(dir, 'angle: x\ncorpus:\n  - a\n', 'brief').status, 0);
  assert.equal(run(dir, 'gate', 'pass').status, 0);
  const r = runWithInput(dir, 'angle: y\ncorpus:\n  - b\n', 'brief');
  assert.equal(r.status, 0, r.stderr);
  const s = readSprint(dir, 'learning-growth-marketing');
  assert.ok(existsSync(join(dir, s.content, 'corpus-brief-week-1.md')));
  assert.ok(existsSync(join(dir, s.content, 'corpus-brief-week-2.md')));
  assert.equal(s.research, `${s.content}/corpus-brief-week-2.md`);
  rmSync(dir, { recursive: true, force: true });
});

// The weekly research pass and the curriculum cross-check are two different writers. Sharing
// one filename meant the cross-check hit the no-overwrite guard in any week the session pass
// had already run, which is every week the skill's own session reference describes.
test('brief --for curriculum writes its own file beside the week brief', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-briefcurric-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  assert.equal(runWithInput(dir, 'angle: x\ncorpus:\n  - a\n', 'brief').status, 0);
  const r = runWithInput(dir, 'angle: y\ncorpus:\n  - b\n', 'brief', '--for', 'curriculum');
  assert.equal(r.status, 0, r.stderr);
  const s = readSprint(dir, 'learning-growth-marketing');
  assert.ok(existsSync(join(dir, s.content, 'corpus-brief-week-1.md')), 'the week brief must survive');
  const md = readFileSync(join(dir, s.content, 'corpus-brief-curriculum.md'), 'utf8');
  assert.match(md, /^slug:\s+learning-growth-marketing-curriculum$/m);
  rmSync(dir, { recursive: true, force: true });
});

test('brief exits 2 when --for is outside week|curriculum', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-briefforbad-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  const r = runWithInput(dir, 'angle: x\ncorpus:\n  - a\n', 'brief', '--for', 'bogus');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--for must be one of/);
  rmSync(dir, { recursive: true, force: true });
});

test('profile reports no profile yet when none has been written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-profileabsent-'));
  const r = run(dir, 'profile');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No profile yet/);
  rmSync(dir, { recursive: true, force: true });
});

test('profile prints the file at profilePath when one exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-profile-'));
  const p = profilePath(dir);
  mkdirSync(join(dir, '.learn'), { recursive: true });
  writeFileSync(p, '# Profile\n\nlearns fast.\n');
  const r = run(dir, 'profile');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /learns fast\./);
  rmSync(dir, { recursive: true, force: true });
});

import { positionals, flag, VALUED_FLAGS } from '../skills/learn/learn.mjs';

// The unit half of the argument fix. Every valued flag in the CLI must be in the set, or its
// value gets read as a positional again: that is the exact shape of the corruption below.
test('VALUED_FLAGS covers every flag the CLI reads a value from', () => {
  assert.deepEqual([...VALUED_FLAGS].sort(), ['--for', '--research-root', '--shape', '--sprint', '--tier', '--track']);
  assert.ok(!VALUED_FLAGS.has('--verified'), '--verified is a boolean and must not consume a token');
});

test('positionals skips a valued flag together with its value', () => {
  assert.deepEqual(positionals(['--track', 'code', 'Systems Design']), ['Systems Design']);
  assert.deepEqual(positionals(['--sprint', 'learning-rust', 'ownership']), ['ownership']);
  // The boolean must not eat the token after it.
  assert.deepEqual(positionals(['pass', '--verified', '--sprint', 's']), ['pass']);
  assert.deepEqual(positionals(['a', '--shape', 'synthesis', 'b']), ['a', 'b']);
});

test('flag returns undefined when absent and refuses a missing value', () => {
  assert.equal(flag(['start', 'X'], '--track'), undefined);
  assert.equal(flag(['--track', 'code'], '--track'), 'code');
  assert.throws(() => flag(['gate', 'pass', '--sprint'], '--sprint'), UsageError);
  assert.throws(() => flag(['gate', 'pass', '--sprint'], '--sprint'), /--sprint needs a value/);
  // A following flag is not a value either, or `--shape --verified` sets the shape to a flag.
  assert.throws(() => flag(['--shape', '--verified'], '--shape'), /--shape needs a value/);
});

// The Critical, end to end. Flag-first ordering is documented, and it used to slug the sprint
// after the TRACK: subject "code", sprint learning-code, exit 0. The trackFile guard can never
// catch that, because the eaten token is by definition a valid track name.
test('start with --track before the subject slugs the SUBJECT, not the track', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-startflagfirst-'));
  const r = run(dir, 'start', '--track', 'code', 'Systems Design');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^STARTED learning-systems-design$/m);

  const s = readSprint(dir, 'learning-systems-design');
  assert.ok(s, 'expected a sprint slugged from the subject');
  assert.equal(s.subject, 'Systems Design');
  assert.equal(s.track, 'code');
  assert.equal(readSprint(dir, 'learning-code'), null, 'the track name must not become a sprint');
  rmSync(dir, { recursive: true, force: true });
});

// The other half: `--sprint` on page used to be read as the concept, naming the page after the
// slug and stamping the slug onto sprint.concept. README and running-a-session both document
// this ordering, so only the undocumented one worked.
test('page with --sprint before the concept names the page after the CONCEPT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-pageflagfirst-'));
  assert.equal(run(dir, 'start', 'Rust', '--track', 'code').status, 0);

  const r = run(dir, 'page', '--sprint', 'learning-rust', 'ownership');
  assert.equal(r.status, 0);

  const s = readSprint(dir, 'learning-rust');
  assert.equal(s.concept, 'ownership');
  assert.ok(existsSync(join(dir, s.content, 'week-1-ownership.md')), 'page must be named for the concept');
  assert.ok(!existsSync(join(dir, s.content, 'week-1-learning-rust.md')), 'page must not be named for the slug');
  rmSync(dir, { recursive: true, force: true });
});

// --sprint with nothing after it used to coerce undefined to the string "undefined" inside
// SAFE.test and report `no sprint 'undefined'`, which reads like a real missing sprint.
test('a valued flag with no value exits 2 and does not report a sprint called undefined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-flagnovalue-'));
  assert.equal(run(dir, 'start', 'Rust', '--track', 'code').status, 0);
  const r = run(dir, 'gate', 'pass', '--sprint');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--sprint needs a value/);
  assert.ok(!r.stderr.includes('undefined'), `leaked undefined: ${r.stderr}`);
  assert.equal(readSprint(dir, 'learning-rust').week, 1, 'a rejected gate must not advance');
  rmSync(dir, { recursive: true, force: true });
});

import { missingHeadings, renderSprintDoc } from '../skills/learn/learn.mjs';

// The sibling of the guarded line in gate(). A fail on a week whose concept was never set
// leaves concept null, and week() interpolated it straight into a marker line the skill
// relays verbatim, so the reader got the literal word "null".
test('week prints REPEAT with no literal null when a fail left the concept unset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-weekfailnull-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  assert.equal(run(dir, 'gate', 'fail').status, 0);
  assert.equal(readSprint(dir, 'learning-growth-marketing').concept, null);

  const w = run(dir, 'week');
  assert.equal(w.status, 0);
  assert.match(w.stdout, /^REPEAT  the same concept — the last gate failed/m);
  assert.ok(!w.stdout.includes('null'), `marker line leaked null: ${w.stdout}`);
  rmSync(dir, { recursive: true, force: true });
});

test('missingHeadings names every required heading a track lacks', () => {
  assert.deepEqual(missingHeadings(TRACK_FIXTURE), []);
  const noGate = TRACK_FIXTURE.replace('## Mastery gate', '## Something else');
  assert.deepEqual(missingHeadings(noGate), ['Mastery gate']);
  assert.deepEqual(missingHeadings('# nothing but a title\n').sort(), [...TRACK_HEADINGS].sort());
});

// parseTrack and TRACK_HEADINGS were exported and tested but called by nothing in production,
// while README.md told strangers the headings are validated. A track missing `Mastery gate`
// used to start a sprint that then broke section 4 of every session with no error at all.
test('start exits 2 naming the heading a user track is missing, and creates nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-badtrack-'));
  mkdirSync(join(dir, '.learn', 'tracks'), { recursive: true });
  writeFileSync(join(dir, '.learn', 'tracks', 'broken.md'), TRACK_FIXTURE.replace('## Mastery gate', '## Grading'));

  const r = run(dir, 'start', 'Growth Marketing', '--track', 'broken');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /is missing: Mastery gate/);
  assert.equal(readSprint(dir, 'learning-growth-marketing'), null, 'a rejected track must not seed a sprint');

  // The bundled tracks must still pass the same check, or this guard breaks every sprint.
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('renderSprintDoc carries the goal and the milestone sequence', () => {
  const md = renderSprintDoc({ subject: 'Growth Marketing', track: 'concept', slug: 'learning-growth-marketing' });
  assert.match(md, /^# Growth Marketing — sprint scope$/m);
  assert.match(md, /^## Sprint goal$/m);
  assert.match(md, /^## Weekly milestones$/m);
  assert.match(md, /^- Week 1 — /m);
});

// spec:87 asked start to scaffold sprint.md and it was never built, so the four-question
// scoping pass in starting-a-sprint.md produced a goal and a milestone sequence with nowhere
// on disk to live.
test('start scaffolds sprint.md in the content directory and says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-startscope-'));
  const r = run(dir, 'start', 'Growth Marketing', '--track', 'code');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /sprint\.md/);

  const s = readSprint(dir, 'learning-growth-marketing');
  const scope = join(dir, s.content, 'sprint.md');
  assert.ok(existsSync(scope), `expected ${scope} to exist`);
  const md = readFileSync(scope, 'utf8');
  assert.match(md, /^## Sprint goal$/m);
  assert.match(md, /^## Weekly milestones$/m);
  rmSync(dir, { recursive: true, force: true });
});

// newSprint seeded research: null and nothing ever wrote it, so a null there could not be told
// apart from "no cross-check was ever run".
test('brief records the brief path on the sprint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-briefresearch-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  assert.equal(readSprint(dir, 'learning-growth-marketing').research, null);

  assert.equal(runWithInput(dir, 'angle: x\ncorpus:\n  - a\n', 'brief').status, 0);
  const s = readSprint(dir, 'learning-growth-marketing');
  assert.equal(s.research, `${s.content}/corpus-brief-week-1.md`);
  rmSync(dir, { recursive: true, force: true });
});

// page refuses to overwrite; brief clobbered. The angle is hand-edited, so a re-run destroyed
// the only copy of it.
test('brief refuses to overwrite a corpus brief that already exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-briefexists-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  assert.equal(runWithInput(dir, 'angle: first\ncorpus:\n  - a\n', 'brief').status, 0);
  const file = join(dir, readSprint(dir, 'learning-growth-marketing').content, 'corpus-brief-week-1.md');

  const r = runWithInput(dir, 'angle: second\ncorpus:\n  - b\n', 'brief');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already exists/);
  assert.match(readFileSync(file, 'utf8'), /angle: first/);
  assert.ok(!readFileSync(file, 'utf8').includes('second'), 'the hand-edited brief was clobbered');
  rmSync(dir, { recursive: true, force: true });
});

// page's documented fallback: with no concept argument it uses the one already on the sprint.
// Nothing covered it, so removing `|| s.concept` would only have shown up as an exit 2 in use.
test('page with no concept argument falls back to the concept on the sprint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-pagefallback-'));
  writeSprint(dir, {
    slug: 'learning-seeded3', subject: 'Seeded', track: 'code', created: 'T',
    content: 'docs/learning/learning-seeded3', research: null,
    week: 3, concept: 'positioning', gates: [], verify: [],
  });

  const r = run(dir, 'page');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /week-3-positioning\.md/);
  assert.ok(existsSync(join(dir, 'docs/learning/learning-seeded3', 'week-3-positioning.md')));
  assert.equal(readSprint(dir, 'learning-seeded3').concept, 'positioning');
  rmSync(dir, { recursive: true, force: true });
});

// A store root that is also a git toplevel: the only shape learn commits into. Committing is
// the point of the store living in a git repo at all, and the bug it fixes is invisible to
// every other test here, which run against a bare temp dir where committing is correctly a
// no-op — a dirty shared checkout only shows up when the root really is a repo root.
const repoRoot = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'learn test');
  git('config', 'commit.gpgsign', 'false');
  return dir;
};
const porcelain = (dir) =>
  execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });

test('start and gate commit their own writes, leaving the store root clean', () => {
  const dir = repoRoot('learn-commit-');
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  assert.equal(porcelain(dir).trim(), '', `start left the tree dirty:\n${porcelain(dir)}`);

  assert.equal(run(dir, 'gate', 'pass').status, 0);
  assert.equal(porcelain(dir).trim(), '', `gate left the tree dirty:\n${porcelain(dir)}`);

  const log = execFileSync('git', ['-C', dir, 'log', '--format=%s'], { encoding: 'utf8' });
  // The gated week is 1, not the 2 the sprint now sits on: applyGate advances before we commit.
  assert.match(log, /learn gate: learning-growth-marketing week 1 pass/);
  assert.match(log, /learn start: learning-growth-marketing \(code track\)/);
  rmSync(dir, { recursive: true, force: true });
});

test('page and brief commit the file they scaffold, not just the sprint', () => {
  const dir = repoRoot('learn-commit2-');
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  assert.equal(run(dir, 'page', 'positioning').status, 0);
  assert.equal(porcelain(dir).trim(), '', `page left the tree dirty:\n${porcelain(dir)}`);

  const r = spawnSync(process.execPath, [learnCli, 'brief'], {
    encoding: 'utf8', input: 'angle\ncorpus\n',
    env: { ...process.env, LEARN_HUB: dir, NO_COLOR: '1' },
  });
  assert.equal(r.status, 0);
  assert.equal(porcelain(dir).trim(), '', `brief left the tree dirty:\n${porcelain(dir)}`);

  const files = execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' });
  assert.match(files, /week-1-positioning\.md/);
  assert.match(files, /corpus-brief-week-1\.md/);
  rmSync(dir, { recursive: true, force: true });
});

// LEARN_HUB may point somewhere untracked, or merely inside somebody else's checkout — a temp
// dir under the home repo is the everyday case, and every other CLI test here is exactly that
// shape. Writing into a repo that never asked for the sprint is worse than not committing, so
// the guard is toplevel EQUALITY and its failure mode is silence, not an error.
test('a store root that is not the repo toplevel is written but never committed', () => {
  const dir = repoRoot('learn-nested-');
  const nested = join(dir, 'store');
  mkdirSync(nested, { recursive: true });

  const r = run(nested, 'start', 'Growth Marketing', '--track', 'code');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(nested, '.learn', 'sprints', 'learning-growth-marketing.json')),
    'the sprint was not written');
  const log = spawnSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' });
  assert.notEqual(log.status, 0, 'a nested store was committed into the enclosing repo');
  rmSync(dir, { recursive: true, force: true });
});

// `git add` is NOT atomic: given [tracked, ignored] it stages the tracked one and still exits
// 1. The first version of commit() bailed out of its try at that point, so the sprint JSON was
// left STAGED - an ownerless index entry that blocks every other session's merges, which is the
// 2026-07-27 failure this function exists to prevent. A repo that gitignores its docs tree is
// ordinary (lm-tools does), so the failure path has to leave the tree no worse than no commit.
test('a content dir the repo ignores leaves nothing staged, and says why', () => {
  const dir = repoRoot('learn-ignored-');
  writeFileSync(join(dir, '.gitignore'), 'docs/\n');
  execFileSync('git', ['-C', dir, 'add', '.gitignore'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'init'], { stdio: 'ignore' });

  const r = run(dir, 'start', 'Growth Marketing', '--track', 'code');
  assert.equal(r.status, 1, 'a write that could not be committed must not report success');
  assert.ok(existsSync(join(dir, '.learn', 'sprints', 'learning-growth-marketing.json')),
    'the sprint was not written');
  assert.equal(porcelain(dir).replace(/^\?\? .*$/gm, '').trim(), '',
    `the failed commit left the index dirty:\n${porcelain(dir)}`);
  // The reason must be the git error, never the `LF will be replaced by CRLF` warning that
  // precedes it on a default Windows checkout.
  assert.doesNotMatch(r.stderr, /LF will be replaced/);
  assert.match(r.stderr, /ignored/);
  rmSync(dir, { recursive: true, force: true });
});

// resolve() normalises separators but not the drive letter, and Windows paths are
// case-insensitive - so a lowercase LEARN_HUB at the true repo root compared unequal to git's
// own capitalisation and silently never committed anything.
test('the repo-root gate ignores path case where the filesystem does', () => {
  const dir = repoRoot('learn-case-');
  const flipped = process.platform === 'win32'
    ? dir[0].toLowerCase() + dir.slice(1)
    : dir;
  assert.equal(run(flipped, 'start', 'Growth Marketing', '--track', 'code').status, 0);
  const log = execFileSync('git', ['-C', dir, 'log', '--format=%s'], { encoding: 'utf8' });
  assert.match(log, /learn start: learning-growth-marketing/);
  rmSync(dir, { recursive: true, force: true });
});
