import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHECK = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check.mjs');

// No runbooks folder resolves here: its own git repo, with HOME and USERPROFILE pointed at it.
// None of these reach the API, so the no-key path is never hit.
// `files` seeds docs/runbooks, which makes it the runbooks folder.
function run(t, args, files = {}) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'runbooks-check-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', base]);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(base, 'docs', 'runbooks'), { recursive: true });
    writeFileSync(join(base, 'docs', 'runbooks', name), text);
  }
  const env = { ...process.env, HOME: base, USERPROFILE: base, LOCALAPPDATA: base, RUNBOOKS_DIR: '' };
  return spawnSync(process.execPath, [CHECK, ...args], { cwd: base, env, encoding: 'utf8' });
}

test('a bad command line gets the usage line even with no runbooks folder', (t) => {
  const r = run(t, []);
  assert.match(r.stderr, /^usage: check\.mjs /);
  assert.equal(r.status, 2);
});

test('a good command line with no runbooks folder still says so', (t) => {
  for (const args of [['x.md', 'a prompt long enough'], ['--changed']]) {
    const r = run(t, args);
    assert.match(r.stderr, /^No runbooks folder found/, args.join(' '));
    assert.equal(r.status, 2);
  }
});

test('a pushed purpose over the lint cap fails before any scoring', (t) => {
  const purpose = Array.from({ length: 26 }, (_, i) => `w${i}`).join(' ');
  const r = run(t, ['long.md', 'a prompt long enough'], { 'long.md': `# Long\n\n**Type:** reference\n**Purpose:** ${purpose}\n\nBody.\n` });
  assert.match(r.stderr, /^long\.md: purpose is 26 words, keep it to 25/);
  assert.equal(r.status, 1);
});

// #105. --changed with a stub router: global fetch is replaced by a preload that prints STUB CALL
// and answers with no scores, and the key is a fake. `books` runbooks each carry `pos` prompts and
// `neg` --not prompts under a stale ledger fingerprint, so every one of them reads as changed.
function runChanged(t, { books, pos, neg }, args) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'runbooks-check-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', base]);
  const dir = join(base, 'docs', 'runbooks');
  mkdirSync(dir, { recursive: true });
  const ledger = {};
  for (let i = 0; i < books; i++) {
    writeFileSync(join(dir, `rb${i}.md`), `# Rb ${i}\n\n**Type:** reference\n**Purpose:** Topic ${i} lookup.\n\nBody.\n`);
    ledger[`rb${i}.md`] = { purpose: 'stale', prompts: Array.from({ length: pos }, (_, j) => `topic ${i} prompt ${j}`),
      not: Array.from({ length: neg }, (_, j) => `unrelated ${i} prompt ${j}`) };
  }
  writeFileSync(join(dir, '.router-ledger.json'), JSON.stringify(ledger));
  const stub = join(base, 'stub-fetch.mjs');
  writeFileSync(stub, "globalThis.fetch = async () => { console.log('STUB CALL'); return new Response(JSON.stringify({ answers: {} }), { status: 200 }); };\n");
  const env = { ...process.env, HOME: base, USERPROFILE: base, LOCALAPPDATA: base, RUNBOOKS_DIR: '',
    OPENROUTER_API_KEY: 'stub', JEV_SPEND_DISABLED: '1' };
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, CHECK, '--changed', ...args],
    { cwd: base, env, encoding: 'utf8' });
  return { ...r, lines: r.stdout.split(/\r?\n/), calls: r.stdout.split(/\r?\n/).filter((l) => l === 'STUB CALL').length };
}

test('--changed prints the call count and cost before the first call', (t) => {
  const r = runChanged(t, { books: 3, pos: 2, neg: 1 }, []);
  assert.equal(r.lines[0], 'at most 9 Jev calls (6 prompts, 3 --not prompts), about $0.0036', r.stdout);
  assert.equal(r.calls, 9, 'one call per prompt');
  assert.ok(r.lines.indexOf('STUB CALL') > 0, 'no call before the count line');
});

test('--changed above 20 calls exits without --yes and makes no call', (t) => {
  const r = runChanged(t, { books: 7, pos: 2, neg: 1 }, []);
  assert.equal(r.lines[0], 'at most 21 Jev calls (14 prompts, 7 --not prompts), about $0.0084');
  assert.match(r.stderr, /^21 calls is over the 20-call cap, rerun with --yes/);
  assert.equal(r.status, 2);
  assert.equal(r.calls, 0);
});

test('--changed above 20 calls runs with --yes', (t) => {
  const r = runChanged(t, { books: 7, pos: 2, neg: 1 }, ['--yes']);
  assert.equal(r.calls, 21);
});

test('--changed --dry prints the count and still makes no call, even above the cap', (t) => {
  const r = runChanged(t, { books: 7, pos: 2, neg: 1 }, ['--dry']);
  assert.equal(r.lines[0], 'at most 21 Jev calls (14 prompts, 7 --not prompts), about $0.0084');
  assert.equal(r.status, 0);
  assert.equal(r.calls, 0);
  assert.ok(r.lines.includes('  would re-run: rb6.md'));
});
