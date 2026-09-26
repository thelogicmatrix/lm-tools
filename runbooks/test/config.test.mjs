import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findRoot, loadConfig, resolveDir, settings, loadExtensions, STATE_DIR } from '../scripts/config.mjs';

// Each fixture is its own git repo, so the git top is the project and never a repo the temp dir sits inside.
// realpathSync.native, not realpathSync: only the native call expands a Windows 8.3 short name
// (RUNNER~1), and git hands back the long form, so the plain call made paths that never compared equal.
// Cleanup is registered in t.after so a failing assertion still removes the temp tree.
function fixture(t) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'runbooks-config-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(base, 'project');
  const home = join(base, 'home');
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  return { base, project, home, env: {} };
}
const mk = (...p) => { const d = join(...p); mkdirSync(d, { recursive: true }); return d; };
const writeConfig = (root, obj) => writeFileSync(join(root, 'config.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));

test('1. no .runbooks anywhere: findRoot null, dir is project docs/runbooks', (t) => {
  const f = fixture(t);
  const dir = mk(f.project, 'docs', 'runbooks');
  const sub = mk(f.project, 'src');
  assert.strictEqual(findRoot(sub, f.home), null);
  assert.strictEqual(resolveDir({ cwd: sub, env: f.env, home: f.home }), dir);
});

test('2. RUNBOOKS_DIR beats everything', (t) => {
  const f = fixture(t);
  mk(f.project, 'docs', 'runbooks');
  mk(f.home, 'docs', 'runbooks');
  const root = mk(f.project, '.runbooks');
  writeConfig(root, { dir: mk(f.base, 'configured') });
  const envDir = mk(f.base, 'from-env');
  assert.strictEqual(resolveDir({ cwd: f.project, env: { RUNBOOKS_DIR: envDir }, home: f.home }), envDir);
});

test('2b. a relative RUNBOOKS_DIR resolves from the cwd argument, not the process cwd', (t) => {
  const f = fixture(t);
  const rel = mk(f.project, 'rel-runbooks');
  assert.notStrictEqual(process.cwd(), f.project);
  assert.strictEqual(resolveDir({ cwd: f.project, env: { RUNBOOKS_DIR: 'rel-runbooks' }, home: f.home }), rel);
});

test('3. an existing config.dir beats project docs/runbooks', (t) => {
  const f = fixture(t);
  mk(f.project, 'docs', 'runbooks');
  const root = mk(f.project, '.runbooks');
  const configured = mk(f.base, 'configured');
  writeConfig(root, { dir: configured });
  assert.strictEqual(resolveDir({ cwd: f.project, env: f.env, home: f.home }), configured);
});

test('4. a missing config.dir falls through to project, then home', (t) => {
  const f = fixture(t);
  const root = mk(f.home, '.runbooks');
  writeConfig(root, { dir: join(f.base, 'pinned-elsewhere', 'docs', 'runbooks') });
  const projectDir = mk(f.project, 'docs', 'runbooks');
  const homeDir = mk(f.home, 'docs', 'runbooks');
  assert.strictEqual(resolveDir({ cwd: f.project, env: f.env, home: f.home }), projectDir);
  rmSync(projectDir, { recursive: true });
  assert.strictEqual(resolveDir({ cwd: f.project, env: f.env, home: f.home }), homeDir);
  rmSync(homeDir, { recursive: true });
  assert.strictEqual(resolveDir({ cwd: f.project, env: f.env, home: f.home }), null);
});

test('5. a relative config.dir resolves against the parent of .runbooks/', (t) => {
  const f = fixture(t);
  const root = mk(f.project, '.runbooks');
  writeConfig(root, { dir: 'notes/runbooks' });
  const dir = mk(f.project, 'notes', 'runbooks');
  const sub = mk(f.project, 'src', 'deep');
  assert.strictEqual(resolveDir({ cwd: sub, env: f.env, home: f.home }), dir);
});

test('6. a project .runbooks beats ~/.runbooks', (t) => {
  const f = fixture(t);
  const projectRoot = mk(f.project, '.runbooks');
  const homeRoot = mk(f.home, '.runbooks');
  assert.strictEqual(findRoot(f.project, f.home), projectRoot);
  rmSync(projectRoot, { recursive: true });
  assert.strictEqual(findRoot(f.project, f.home), homeRoot);
});

test('6b. the working directory .runbooks sits between the project one and ~/.runbooks', (t) => {
  const f = fixture(t);
  const sub = mk(f.project, 'sub');
  const cwdRoot = mk(sub, '.runbooks');
  mk(f.home, '.runbooks');
  assert.strictEqual(findRoot(sub, f.home), cwdRoot);
  const projectRoot = mk(f.project, '.runbooks');
  assert.strictEqual(findRoot(sub, f.home), projectRoot);
});

test('7. settings with an empty config returns the measured defaults plus paths', (t) => {
  const f = fixture(t);
  const root = mk(f.project, '.runbooks');
  writeConfig(root, {});
  const dir = mk(f.project, 'docs', 'runbooks');
  assert.deepStrictEqual(settings({ cwd: f.project, env: f.env, home: f.home }), {
    root, dir, firesAt: 0.8, writeBar: 0.85, maxInject: 6, shortlist: 30,
    ledger: join(dir, '.router-ledger.json'),
  });
});

test('7b. writeBar follows firesAt, a relative ledger resolves against the parent of .runbooks/', (t) => {
  const f = fixture(t);
  const root = mk(f.project, '.runbooks');
  writeConfig(root, { firesAt: 0.7, ledger: 'state/ledger.json' });
  mk(f.project, 'docs', 'runbooks');
  const s = settings({ cwd: f.project, env: f.env, home: f.home });
  assert.strictEqual(s.writeBar, 0.75);
  assert.strictEqual(s.ledger, join(f.project, 'state', 'ledger.json'));
});

test('7c. settings with nothing resolving has null root, dir and ledger', (t) => {
  const f = fixture(t);
  const s = settings({ cwd: f.project, env: f.env, home: f.home });
  assert.deepStrictEqual([s.root, s.dir, s.ledger], [null, null, null]);
});

test('7d. a writeBar under firesAt falls back to firesAt + 0.05, one at or above it stands', (t) => {
  const f = fixture(t);
  const root = mk(f.project, '.runbooks');
  mk(f.project, 'docs', 'runbooks');
  const bar = (c) => { writeConfig(root, c); return settings({ cwd: f.project, env: f.env, home: f.home }).writeBar; };
  assert.strictEqual(bar({ firesAt: 0.9, writeBar: 0.85 }), 0.95);
  assert.strictEqual(bar({ firesAt: 0.8, writeBar: 0.8 }), 0.8);
  assert.strictEqual(bar({ writeBar: 0.9 }), 0.9);
});

test('8. loadExtensions keeps function defaults sorted by name, skips throwers and non-functions', async (t) => {
  const f = fixture(t);
  const root = mk(f.project, '.runbooks');
  const nudges = mk(root, 'nudges');
  writeFileSync(join(nudges, 'b.mjs'), 'export default () => "b";\n');
  writeFileSync(join(nudges, 'a.mjs'), 'export default () => "a";\n');
  writeFileSync(join(nudges, 'broken.mjs'), 'throw new Error("boom");\n');
  writeFileSync(join(nudges, 'notfn.mjs'), 'export default 42;\n');
  writeFileSync(join(nudges, 'readme.txt'), 'not a module\n');
  // A test file beside an extension is not an extension, in either folder.
  writeFileSync(join(nudges, 'a.test.mjs'), 'export default () => "test";\n');
  writeFileSync(join(mk(root, 'lint'), 'rule.test.mjs'), 'export default () => ["test"];\n');
  const got = await loadExtensions(root, 'nudges');
  assert.deepStrictEqual(got.map(e => e.name), ['a', 'b']);
  assert.deepStrictEqual(got.map(e => e.fn()), ['a', 'b']);
  assert.deepStrictEqual(await loadExtensions(root, 'lint'), []);
  assert.deepStrictEqual(await loadExtensions(null, 'nudges'), []);
});

test('9. a non-numeric firesAt, writeBar, maxInject or shortlist falls back to the default', (t) => {
  const f = fixture(t);
  const root = mk(f.project, '.runbooks');
  writeConfig(root, { firesAt: '0.9', writeBar: null, maxInject: 'six', shortlist: {} });
  mk(f.project, 'docs', 'runbooks');
  const s = settings({ cwd: f.project, env: f.env, home: f.home });
  assert.deepStrictEqual([s.firesAt, s.writeBar, s.maxInject, s.shortlist], [0.8, 0.85, 6, 30]);
});

test('10. invalid or missing config.json gives {}', (t) => {
  const f = fixture(t);
  const root = mk(f.project, '.runbooks');
  assert.deepStrictEqual(loadConfig(root), {});
  writeConfig(root, '{ not json');
  assert.deepStrictEqual(loadConfig(root), {});
  assert.deepStrictEqual(loadConfig(null), {});
  writeConfig(root, { firesAt: 0.9 });
  assert.deepStrictEqual(loadConfig(root), { firesAt: 0.9 });
});

test('STATE_DIR ends in claude-router', () => {
  assert.match(STATE_DIR, /claude-router$/);
});

test('settings() and resolveDir() with no argument fall back to process.cwd() and do not throw', () => {
  const s = settings();
  assert.deepStrictEqual(Object.keys(s), ['root', 'dir', 'firesAt', 'writeBar', 'maxInject', 'shortlist', 'ledger']);
  assert.strictEqual(resolveDir(), s.dir);
  assert.strictEqual(resolveDir({}), s.dir);
});
