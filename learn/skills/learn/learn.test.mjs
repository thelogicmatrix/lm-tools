import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
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
