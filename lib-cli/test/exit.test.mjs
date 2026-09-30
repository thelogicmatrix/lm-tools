import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXIT = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'exit.mjs')).href;

function scriptDir() {
  const d = mkdtempSync(join(tmpdir(), 'libcli-exit-'));
  writeFileSync(join(d, 'entry.mjs'), `import { isMain } from ${JSON.stringify(EXIT)};\nconsole.log(isMain(import.meta.url));\n`);
  writeFileSync(join(d, 'importer.mjs'), `import './entry.mjs';\n`);
  return d;
}
const run = (file) => spawnSync(process.execPath, [file], { encoding: 'utf8' });

test('isMain is true for the started script and false for an imported one', () => {
  const d = scriptDir();
  assert.equal(run(join(d, 'entry.mjs')).stdout.trim(), 'true');
  assert.equal(run(join(d, 'importer.mjs')).stdout.trim(), 'false');
});

test('isMain is true when the script is reached through a junction or symlink', () => {
  const d = scriptDir();
  const link = `${d}-link`;
  symlinkSync(d, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(run(join(link, 'entry.mjs')).stdout.trim(), 'true');
});

test('isMain is false for an empty or unresolvable argv[1]', async () => {
  const { isMain } = await import(EXIT);
  assert.equal(isMain(import.meta.url, ''), false);
  assert.equal(isMain(import.meta.url, join(tmpdir(), 'libcli-missing-9d2e.mjs')), false);
});

test('fail prints to stderr and sets the exit code without exiting', () => {
  const d = mkdtempSync(join(tmpdir(), 'libcli-fail-'));
  const f = join(d, 'f.mjs');
  writeFileSync(f, `import { fail } from ${JSON.stringify(EXIT)};\nconst c = fail('demo: no such thing');\nconsole.log('after', c);\n`);
  const r = run(f);
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), 'demo: no such thing');
  assert.equal(r.stdout.trim(), 'after 2');
});
