import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findRoot, loadConfig, resolveDir, settings, loadExtensions, STATE_DIR } from '../scripts/config.mjs';

// Each fixture is its own git repo, so the git top is the project and never a repo the temp dir sits inside.
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'runbooks-config-')));
  const project = join(base, 'project');
  const home = join(base, 'home');
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  return { base, project, home, env: {} };
}
const mk = (...p) => { const d = join(...p); mkdirSync(d, { recursive: true }); return d; };
const writeConfig = (root, obj) => writeFileSync(join(root, 'config.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));

test('1. no .runbooks anywhere: findRoot null, dir is project docs/runbooks', () => {
  const f = fixture();
  const dir = mk(f.project, 'docs', 'runbooks');
  const sub = mk(f.project, 'src');
  assert.strictEqual(findRoot(sub, f.home), null);
  assert.strictEqual(resolveDir({ cwd: sub, env: f.env, home: f.home }), dir);
  rmSync(f.base, { recursive: true, force: true });
});

test('2. RUNBOOKS_DIR beats everything', () => {
  const f = fixture();
  mk(f.project, 'docs', 'runbooks');
  mk(f.home, 'docs', 'runbooks');
  const root = mk(f.project, '.runbooks');
  writeConfig(root, { dir: mk(f.base, 'configured') });
  const envDir = mk(f.base, 'from-env');
  assert.strictEqual(resolveDir({ cwd: f.project, env: { RUNBOOKS_DIR: envDir }, home: f.home }), envDir);
  rmSync(f.base, { recursive: true, force: true });
});

test('3. an existing config.dir beats project docs/runbooks', () => {
  const f = fixture();
  mk(f.project, 'docs', 'runbooks');
  const root = mk(f.project, '.runbooks');
  const configured = mk(f.base, 'configured');
  writeConfig(root, { dir: configured });
  assert.strictEqual(resolveDir({ cwd: f.project, env: f.env, home: f.home }), configured);
  rmSync(f.base, { recursive: true, force: true });
});

test('4. a missing config.dir falls through to project, then home', () => {
  const f = fixture();
  const root = mk(f.home, '.runbooks');
  writeConfig(root, { dir: join(f.base, 'pinned-elsewhere', 'docs', 'runbooks') });
  const projectDir = mk(f.project, 'docs', 'runbooks');
  const homeDir = mk(f.home, 'docs', 'runbooks');
  assert.strictEqual(resolveDir({ cwd: f.project, env: f.env, home: f.home }), projectDir);
  rmSync(projectDir, { recursive: true });
  assert.strictEqual(resolveDir({ cwd: f.project, env: f.env, home: f.home }), homeDir);
  rmSync(homeDir, { recursive: true });
  assert.strictEqual(resolveDir({ cwd: f.project, env: f.env, home: f.home }), null);
  rmSync(f.base, { recursive: true, force: true });
});

test('5. a relative config.dir resolves against the parent of .runbooks/', () => {
  const f = fixture();
  const root = mk(f.project, '.runbooks');
  writeConfig(root, { dir: 'notes/runbooks' });
  const dir = mk(f.project, 'notes', 'runbooks');
  const sub = mk(f.project, 'src', 'deep');
  assert.strictEqual(resolveDir({ cwd: sub, env: f.env, home: f.home }), dir);
  rmSync(f.base, { recursive: true, force: true });
});

test('6. a project .runbooks beats ~/.runbooks', () => {
  const f = fixture();
  const projectRoot = mk(f.project, '.runbooks');
  const homeRoot = mk(f.home, '.runbooks');
  assert.strictEqual(findRoot(f.project, f.home), projectRoot);
  rmSync(projectRoot, { recursive: true });
  assert.strictEqual(findRoot(f.project, f.home), homeRoot);
  rmSync(f.base, { recursive: true, force: true });
});

test('7. settings with an empty config returns the measured defaults plus paths', () => {
  const f = fixture();
  const root = mk(f.project, '.runbooks');
  writeConfig(root, {});
  const dir = mk(f.project, 'docs', 'runbooks');
  assert.deepStrictEqual(settings({ cwd: f.project, env: f.env, home: f.home }), {
    root, dir, firesAt: 0.8, writeBar: 0.85, maxInject: 6, shortlist: 30,
    ledger: join(dir, '.router-ledger.json'),
  });
  rmSync(f.base, { recursive: true, force: true });
});

test('7b. writeBar follows firesAt, a relative ledger resolves against the parent of .runbooks/', () => {
  const f = fixture();
  const root = mk(f.project, '.runbooks');
  writeConfig(root, { firesAt: 0.7, ledger: 'state/ledger.json' });
  mk(f.project, 'docs', 'runbooks');
  const s = settings({ cwd: f.project, env: f.env, home: f.home });
  assert.strictEqual(s.writeBar, 0.75);
  assert.strictEqual(s.ledger, join(f.project, 'state', 'ledger.json'));
  rmSync(f.base, { recursive: true, force: true });
});

test('7c. settings with nothing resolving has null root, dir and ledger', () => {
  const f = fixture();
  const s = settings({ cwd: f.project, env: f.env, home: f.home });
  assert.deepStrictEqual([s.root, s.dir, s.ledger], [null, null, null]);
  rmSync(f.base, { recursive: true, force: true });
});

test('8. loadExtensions keeps function defaults sorted by name, skips throwers and non-functions', async () => {
  const f = fixture();
  const root = mk(f.project, '.runbooks');
  const nudges = mk(root, 'nudges');
  writeFileSync(join(nudges, 'b.mjs'), 'export default () => "b";\n');
  writeFileSync(join(nudges, 'a.mjs'), 'export default () => "a";\n');
  writeFileSync(join(nudges, 'broken.mjs'), 'throw new Error("boom");\n');
  writeFileSync(join(nudges, 'notfn.mjs'), 'export default 42;\n');
  writeFileSync(join(nudges, 'readme.txt'), 'not a module\n');
  const got = await loadExtensions(root, 'nudges');
  assert.deepStrictEqual(got.map(e => e.name), ['a', 'b']);
  assert.deepStrictEqual(got.map(e => e.fn()), ['a', 'b']);
  assert.deepStrictEqual(await loadExtensions(root, 'lint'), []);
  assert.deepStrictEqual(await loadExtensions(null, 'nudges'), []);
  rmSync(f.base, { recursive: true, force: true });
});

test('9. a non-numeric firesAt, writeBar, maxInject or shortlist falls back to the default', () => {
  const f = fixture();
  const root = mk(f.project, '.runbooks');
  writeConfig(root, { firesAt: '0.9', writeBar: null, maxInject: 'six', shortlist: {} });
  mk(f.project, 'docs', 'runbooks');
  const s = settings({ cwd: f.project, env: f.env, home: f.home });
  assert.deepStrictEqual([s.firesAt, s.writeBar, s.maxInject, s.shortlist], [0.8, 0.85, 6, 30]);
  rmSync(f.base, { recursive: true, force: true });
});

test('10. invalid or missing config.json gives {}', () => {
  const f = fixture();
  const root = mk(f.project, '.runbooks');
  assert.deepStrictEqual(loadConfig(root), {});
  writeConfig(root, '{ not json');
  assert.deepStrictEqual(loadConfig(root), {});
  assert.deepStrictEqual(loadConfig(null), {});
  writeConfig(root, { firesAt: 0.9 });
  assert.deepStrictEqual(loadConfig(root), { firesAt: 0.9 });
  rmSync(f.base, { recursive: true, force: true });
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
