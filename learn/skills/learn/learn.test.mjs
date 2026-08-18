import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slugify, sprintPath, readSprint, writeSprint, UsageError } from './learn.mjs';

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
import { TRACK_HEADINGS, parseTrack, trackFile, listTracks } from './learn.mjs';

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
  const names = listTracks(root).map((t) => `${t.name}:${t.source}`).sort();
  assert.deepEqual(names, ['code:user', 'language:user']);
  rmSync(root, { recursive: true, force: true });

  // No user tracks directory at all: falls back to the bundled list, doesn't throw.
  const bare = tmp();
  const bareNames = listTracks(bare).map((t) => `${t.name}:${t.source}`);
  assert.deepEqual(bareNames, ['code:bundled']);
  rmSync(bare, { recursive: true, force: true });
});

test('trackFile refuses a name with a path separator', () => {
  assert.throws(() => trackFile('/r', '../evil'), UsageError);
  assert.throws(() => trackFile('/r', '../evil'), /invalid track name/);
});

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRoot } from './learn.mjs';

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
  const cliPath = fileURLToPath(new URL('./learn.mjs', import.meta.url));
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

import { newSprint } from './learn.mjs';

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
  const cliPath = fileURLToPath(new URL('./learn.mjs', import.meta.url));
  const env = { ...process.env, LEARN_HUB: dir };
  const result = spawnSync(process.execPath, [cliPath, 'start', '!!!', '--track', 'code'], { encoding: 'utf8', env });
  assert.equal(result.status, 2);
  assert.ok(result.stderr.length > 0);
  rmSync(dir, { recursive: true, force: true });
});

test('start exits 1 when a sprint with that slug already exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-startexists-'));
  const cliPath = fileURLToPath(new URL('./learn.mjs', import.meta.url));
  const env = { ...process.env, LEARN_HUB: dir };
  const args = [cliPath, 'start', 'Growth Marketing', '--track', 'code'];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  assert.equal(first.status, 0);
  const second = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  assert.equal(second.status, 1);
  assert.ok(second.stderr.length > 0);
  rmSync(dir, { recursive: true, force: true });
});

import { verifyDue, applyGate, VERIFY_FLOOR_WEEKS } from './learn.mjs';

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

const learnCli = fileURLToPath(new URL('./learn.mjs', import.meta.url));
const run = (dir, ...args) =>
  spawnSync(process.execPath, [learnCli, ...args], {
    encoding: 'utf8', env: { ...process.env, LEARN_HUB: dir, NO_COLOR: '1' },
  });

// Proves the whole chain the pure tests cannot: the counter is read from disk, advanced,
// and written back, and the marker the skill relays matches the stored state.
test('gate CLI advances the sprint on disk and prints ADVANCED', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-gatecli-'));
  assert.equal(run(dir, 'start', 'Growth Marketing', '--track', 'code').status, 0);

  const r = run(dir, 'gate', 'pass');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ADVANCED to week 2/);

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

// Seeds a concept directly, which is the only way to reach week()'s REPEAT branch until a
// verb sets one. Both verbs must name the concept when there is one to name.
test('week and gate name the concept when the sprint has one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-concept-'));
  writeSprint(dir, {
    slug: 'learning-seeded', subject: 'Seeded', track: 'code', created: 'T',
    content: 'docs/learning/learning-seeded', research: null,
    week: 3, concept: 'positioning', gates: [], verify: [],
  });

  const w = run(dir, 'week');
  assert.equal(w.status, 0);
  assert.match(w.stdout, /REPEAT\s+positioning/);

  const g = run(dir, 'gate', 'fail');
  assert.equal(g.status, 0);
  assert.match(g.stdout, /REPEAT positioning at week 4/);
  assert.equal(readSprint(dir, 'learning-seeded').concept, 'positioning');
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
