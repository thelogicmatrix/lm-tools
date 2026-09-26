import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check.mjs');

// No runbooks folder resolves here: its own git repo, with HOME and USERPROFILE pointed at it.
// None of these reach the API, so the no-key path is never hit.
function run(t, ...args) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'runbooks-check-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', base]);
  const env = { ...process.env, HOME: base, USERPROFILE: base, LOCALAPPDATA: base, RUNBOOKS_DIR: '' };
  return spawnSync(process.execPath, [CHECK, ...args], { cwd: base, env, encoding: 'utf8' });
}

test('a bad command line gets the usage line even with no runbooks folder', (t) => {
  const r = run(t);
  assert.match(r.stderr, /^usage: check\.mjs /);
  assert.equal(r.status, 2);
});

test('a good command line with no runbooks folder still says so', (t) => {
  for (const args of [['x.md', 'a prompt long enough'], ['--changed']]) {
    const r = run(t, ...args);
    assert.match(r.stderr, /^No runbooks folder found/, args.join(' '));
    assert.equal(r.status, 2);
  }
});
