import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check.mjs');

// No runbooks folder resolves here: its own git repo, with HOME and USERPROFILE pointed at it.
// None of these reach the API, so the no-key path is never hit.
// `files` seeds docs/runbooks, which makes it the runbooks folder.
function run(t, args, files = {}) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'runbooks-check-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', base]);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(base, 'docs', 'runbooks'), { recursive: true });
    writeFileSync(join(base, 'docs', 'runbooks', name), text);
  }
  const env = { ...process.env, HOME: base, USERPROFILE: base, LOCALAPPDATA: base, RUNBOOKS_DIR: '' };
  return spawnSync(process.execPath, [CHECK, ...args], { cwd: base, env, encoding: 'utf8' });
}

test('a bad command line gets the usage line even with no runbooks folder', (t) => {
  const r = run(t, []);
  assert.match(r.stderr, /^usage: check\.mjs /);
  assert.equal(r.status, 2);
});

test('a good command line with no runbooks folder still says so', (t) => {
  for (const args of [['x.md', 'a prompt long enough'], ['--changed']]) {
    const r = run(t, args);
    assert.match(r.stderr, /^No runbooks folder found/, args.join(' '));
    assert.equal(r.status, 2);
  }
});

test('a pushed purpose over the lint cap fails before any scoring', (t) => {
  const purpose = Array.from({ length: 26 }, (_, i) => `w${i}`).join(' ');
  const r = run(t, ['long.md', 'a prompt long enough'], { 'long.md': `# Long\n\n**Type:** reference\n**Purpose:** ${purpose}\n\nBody.\n` });
  assert.match(r.stderr, /^long\.md: purpose is 26 words, keep it to 25/);
  assert.equal(r.status, 1);
});
