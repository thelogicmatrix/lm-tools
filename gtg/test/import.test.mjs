// gtg.mjs has no import-time side effects (#30). It used to resolve the root at import, so an
// import outside a repo printed an error and exited 2, and inside one it opened the forge and ran
// a command. And the CLI still runs when it is reached through a junction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'gtg', 'gtg.mjs');

test('importing gtg.mjs outside any repo prints nothing and exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gtg-import-'));
  try {
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) };
    delete env.GTG_HUB;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(CLI).href)})`],
      { cwd: dir, env, encoding: 'utf8', timeout: 20_000 });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI runs its main() when reached through a junction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gtg-junction-'));
  try {
    symlinkSync(join(dirname(CLI)), join(dir, 'gtg'), 'junction');
    const r = spawnSync(process.execPath, [join(dir, 'gtg', 'gtg.mjs'), 'help'], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^gtg - pause\/resume \+ backlog bookkeeping/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
