import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { purposeHash, triage, entry, load, save } from '../scripts/ledger.mjs';

test('the fingerprint ignores whitespace and nothing else', () => {
  assert.equal(purposeHash('Fix  the\tthing '), purposeHash('Fix the thing'));
  assert.notEqual(purposeHash('Fix the thing'), purposeHash('Fix the things'));
});

// The whole point: an unchanged purpose is never re-scored, a moved one always is, and one with
// no stored prompts is named rather than silently skipped.
test('triage sorts the corpus by what a re-check would cost', () => {
  const ledger = {
    'same.md': { purpose: purposeHash('Same words.') },
    'moved.md': { purpose: purposeHash('Old words.') },
    'deleted.md': { purpose: purposeHash('Gone.') },
  };
  const corpus = [
    { file: 'same.md', purpose: 'Same  words.' },
    { file: 'moved.md', purpose: 'New words.' },
    { file: 'new.md', purpose: 'Never scored.' },
  ];
  assert.deepEqual(triage(corpus, ledger), {
    changed: ['moved.md'], untested: ['new.md'], unchanged: ['same.md'], gone: ['deleted.md'],
  });
});

test('an entry records the purpose that was scored, pass or fail, and the lowest task score', () => {
  const e = entry('Trial text.', ['a', 'b'], ['n'], [
    { want: true, ok: true, p: 0.91 }, { want: true, ok: false, p: 0.8 }, { want: false, ok: true, p: 0.1 },
  ]);
  assert.equal(e.purpose, purposeHash('Trial text.'));
  assert.equal(e.passed, false);
  assert.equal(e.low, 0.8);
  assert.deepEqual([e.prompts, e.not], [['a', 'b'], ['n']]);
});

test('save sorts keys and load of a missing file is empty', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'l.json');
  assert.deepEqual(load(f), {});
  save({ 'b.md': { purpose: 'x' }, 'a.md': { purpose: 'y' } }, f);
  assert.deepEqual(Object.keys(load(f)), ['a.md', 'b.md']);
});
