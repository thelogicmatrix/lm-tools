// lib/git.mjs runGit, and gtg's commit() on a failed commit. Every vendored git.mjs is pinned to
// lib-cli/git.mjs by test/framework.test.mjs, so the runGit cases here cover every copy. Each tool's own suite checks its commit() leaves nothing
// staged when the commit fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit } from '../skills/gtg/lib/git.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'gtg', 'gtg.mjs');

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'gtg-git-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  return { dir, git };
}
const staged = (git) => git('diff', '--cached', '--name-only').toString().trim();

// Another git holding the index: a real lock file, released by a separate process while runGit
// sleeps between attempts (runGit blocks this process, so a timer here could never fire).
function holdLock(dir, ms) {
  const lock = join(dir, '.git', 'index.lock');
  writeFileSync(lock, '');
  const child = spawn(process.execPath, ['-e',
    `setTimeout(() => require('fs').rmSync(${JSON.stringify(lock)}), ${ms})`], { stdio: 'ignore' });
  return { lock, child };
}

test('runGit waits out a briefly held index.lock and the add lands', async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, 'f.txt'), 'x\n');
  const { lock, child } = holdLock(dir, 400);
  assert.equal(existsSync(lock), true);
  const t0 = Date.now();
  runGit(['add', '--', 'f.txt'], { cwd: dir });
  assert.ok(Date.now() - t0 >= 250, 'the first attempt must have hit the lock and retried');
  assert.equal(staged(git), 'f.txt');
  await new Promise((r) => (child.exitCode === null ? child.on('exit', r) : r()));
});

test('runGit gives up on a lock that never clears and throws the lock error', () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'f.txt'), 'x\n');
  writeFileSync(join(dir, '.git', 'index.lock'), '');
  assert.throws(() => runGit(['add', '--', 'f.txt'], { cwd: dir, retries: 1 }),
    (e) => /index\.lock/.test(`${e.stderr}`));
});

test('runGit does not retry a failure that is not the lock', () => {
  const { dir } = repo();
  const t0 = Date.now();
  assert.throws(() => runGit(['add', '--', 'missing.txt'], { cwd: dir }), /pathspec|did not match/);
  assert.ok(Date.now() - t0 < 250, 'a real failure is thrown at once, not after the retry pauses');
});

// gtg's commit() runs inside the CLI, so this drives a real handoff. A pre-commit hook that
// exits 1 is a failed commit after a successful add, which used to leave the records staged
// and ownerless in the shared index.
test('a failed gtg commit leaves nothing staged', () => {
  const { dir, git } = repo();
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir(), GTG_SESSION_ID: 'test-session' };
  delete env.GTG_HUB;
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [CLI, 'handoff', '--project', 'P', '--slug', 'p',
    '--eta', '~2h', '--next', 'do the next thing'], {
    cwd: dir, env, encoding: 'utf8',
    input: '## What Was Done This Session\n- stuff\n\n## Next Action\ndo the next thing\n',
  });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /uncommitted/);
  assert.equal(staged(git), '', 'the failed commit must unstage what its add staged');
});
