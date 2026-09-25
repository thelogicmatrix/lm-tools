import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'index.mjs');

// End to end through --lint: a .runbooks/lint rule's violation is printed and fails the run.
// The fixture is its own git repo and HOME, USERPROFILE and LOCALAPPDATA point at it, so the
// machine's own ~/.runbooks, ~/docs/runbooks and any repo the temp dir sits inside never leak in.
test('--lint prints a lint extension violation and exits 1', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'runbooks-lint-')));
  try {
    execFileSync('git', ['init', '-q', base]);
    mkdirSync(join(base, 'docs', 'runbooks'), { recursive: true });
    writeFileSync(join(base, 'docs', 'runbooks', 'x.md'), '# X\n**Type:** standard\n**Purpose:** A valid standard.\n');
    mkdirSync(join(base, '.runbooks', 'lint'), { recursive: true });
    writeFileSync(join(base, '.runbooks', 'lint', 'rule.mjs'), "export default () => ['x: custom violation'];\n");
    const env = { ...process.env, HOME: base, USERPROFILE: base, LOCALAPPDATA: base, RUNBOOKS_DIR: '' };
    const r = spawnSync(process.execPath, [INDEX, '--lint'], { cwd: base, env, encoding: 'utf8' });
    assert.match(r.stdout, /x: custom violation/, r.stderr);
    assert.equal(r.status, 1, r.stdout + r.stderr);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
