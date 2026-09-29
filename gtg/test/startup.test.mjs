// help needs no store, so it must not spawn git to find one. Outside any repo the root lookup
// exits 2, which is what a help that still resolved the root would do here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'gtg', 'gtg.mjs');

test('help, --help and -h print the usage outside any git repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gtg-norepo-'));
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() };
  delete env.GTG_HUB;
  for (const verb of ['help', '--help', '-h']) {
    const r = spawnSync(process.execPath, [CLI, verb], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${verb}: ${r.stderr}`);
    assert.match(r.stdout, /^gtg - pause\/resume/);
  }
});

test('a real verb outside any git repo still refuses with exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gtg-norepo-'));
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() };
  delete env.GTG_HUB;
  const r = spawnSync(process.execPath, [CLI, 'list'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not inside a git repository/);
});
