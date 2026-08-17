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
