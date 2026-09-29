// Every jevtools module imports without running anything, and every CLI still runs as a CLI,
// including through a junction.
//
// Before the main() guards, importing jevmail read stdin and importing jevclick exited, which is
// why their tests had to live inside the scripts as --selftest branches.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = [
  ...fs.readdirSync(path.join(ROOT, 'scripts')).map((f) => path.join(ROOT, 'scripts', f)),
  path.join(ROOT, 'skills', 'jevchecker', 'jevchecker.mjs'),
  ...fs.readdirSync(path.join(ROOT, 'skills', 'jevchecker', 'lib')).map((f) => path.join(ROOT, 'skills', 'jevchecker', 'lib', f)),
].filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));

// No key anywhere, an empty home and an empty cwd. A module that still runs its CLI on import then
// fails loudly (usage line, ENOENT, missing key) instead of reaching a paid endpoint.
const sandbox = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-entry-'));
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, JEV_SPEND_DISABLED: '1', FORGEJO_URL: '' };
  delete env.OPENROUTER_API_KEY;
  delete env.NODE_TEST_CONTEXT;
  return { dir, env };
};

test('every jevtools module imports with no output and no exit', () => {
  assert.ok(modules.length >= 12, `found ${modules.length} modules`);
  const { dir, env } = sandbox();
  try {
    for (const m of modules) {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(m).href)})`],
        { cwd: dir, env, input: '', encoding: 'utf8', timeout: 20_000 });
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], `importing ${path.relative(ROOT, m)} ran something`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a CLI run through a junction still runs its main()', () => {
  const { dir, env } = sandbox();
  try {
    const link = path.join(dir, 'plugin');
    fs.symlinkSync(ROOT, link, 'junction');
    const r = spawnSync(process.execPath, [path.join(link, 'scripts', 'jevmail.triage.mjs')],
      { cwd: dir, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /--in <tags\.json from jevmail\.mjs> required/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// `--selftest` predates the *.test.mjs files and runbooks still name it. It must run the tests,
// never fall through into the CLI, where jevclassify would read Forgejo and call Jev.
test('--selftest on each CLI runs its test file and nothing else', () => {
  const { dir, env } = sandbox();
  try {
    for (const cli of ['jevclassify', 'jevclick', 'jevdrift', 'jevmail', 'jevmail.triage']) {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', `${cli}.mjs`), '--selftest'],
        { cwd: dir, env, input: '', encoding: 'utf8', timeout: 60_000 });
      assert.equal(r.status, 0, `${cli} --selftest: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /[ℹ#] fail 0/, `${cli} --selftest ran its tests`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
