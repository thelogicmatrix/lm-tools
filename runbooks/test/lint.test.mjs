import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(PLUGIN, 'scripts', 'index.mjs');

// End to end through --lint. The fixture is its own git repo and HOME, USERPROFILE and
// LOCALAPPDATA point at it, so the machine's own ~/.runbooks, ~/docs/runbooks and any repo the
// temp dir sits inside never leak in. It starts with one valid standard, so a clean run is exit 0.
function fixture(t) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'runbooks-lint-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', base]);
  const docs = join(base, 'docs', 'runbooks');
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, 'x.md'), '# X\n**Type:** standard\n**Purpose:** A valid standard.\n');
  const env = { ...process.env, HOME: base, USERPROFILE: base, LOCALAPPDATA: base, RUNBOOKS_DIR: '' };
  const lint = () => spawnSync(process.execPath, [INDEX, '--lint'], { cwd: base, env, encoding: 'utf8' });
  return { base, docs, lint };
}

test('--lint prints a lint extension violation and exits 1', (t) => {
  const f = fixture(t);
  // Clean first, so the exit 1 below is the extension's alone.
  const clean = f.lint();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  mkdirSync(join(f.base, '.runbooks', 'lint'), { recursive: true });
  writeFileSync(join(f.base, '.runbooks', 'lint', 'rule.mjs'), "export default () => ['x: custom violation'];\n");
  const r = f.lint();
  assert.match(r.stdout, /x: custom violation/, r.stderr);
  assert.equal(r.status, 1, r.stdout + r.stderr);
});

test('--lint prints a core rule violation and exits 1', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.docs, 'y.md'), '# Y\n**Purpose:** No type line.\n');
  const r = f.lint();
  assert.match(r.stdout, /^y: missing \*\*Type:\*\*$/m, r.stderr);
  assert.match(r.stdout, /2 runbooks, 1 violations\./);
  assert.equal(r.status, 1, r.stdout + r.stderr);
});

test('--lint names the check command quoted and with forward slashes', (t) => {
  const f = fixture(t);
  const r = f.lint();
  // x.md was never checked, so the advisory prints. Quoted so a space in the path survives, and
  // forward slashes so it pastes into bash on Windows without the backslashes being eaten.
  const cmd = `node "${join(PLUGIN, 'scripts', 'check.mjs').replace(/\\/g, '/')}" --changed`;
  assert.ok(r.stdout.includes(cmd), `expected ${cmd} in:\n${r.stdout}`);
});
