import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slugify, sprintPath, readSprint, writeSprint } from './learn.mjs';

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
  writeFileSync(join(root, '.learn', 'tracks', 'concept.md'), TRACK_FIXTURE);
  const hit = trackFile(root, 'concept');
  assert.equal(hit.source, 'user');
  rmSync(root, { recursive: true, force: true });
});

test('listTracks labels bundled and user tracks and dedupes by name', () => {
  const root = tmp();
  mkdirSync(join(root, '.learn', 'tracks'), { recursive: true });
  writeFileSync(join(root, '.learn', 'tracks', 'concept.md'), TRACK_FIXTURE);
  writeFileSync(join(root, '.learn', 'tracks', 'language.md'), TRACK_FIXTURE);
  const names = listTracks(root).map((t) => `${t.name}:${t.source}`).sort();
  assert.deepEqual(names, ['code:bundled', 'concept:user', 'language:user']);
  rmSync(root, { recursive: true, force: true });
});

test('trackFile refuses a name with a path separator', () => {
  assert.throws(() => trackFile('/r', '../evil'), /invalid track name/);
});
