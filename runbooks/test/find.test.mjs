import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIND_N, find, judge, lines, slash } from '../scripts/find.mjs';
import { keyFor } from '../scripts/router.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'find.mjs');
const books = [
  { file: 'torrent-vpn.md', type: 'procedure', purpose: 'The torrent client stops downloading after the vpn container restarts.' },
  { file: 'backup-prune.md', type: 'procedure', purpose: 'The nightly backup pruned nothing.' },
  { file: 'secrets.md', type: 'standard', purpose: 'Keep credential values out of the transcript.' },
  { file: 'quoting.md', type: 'standard', purpose: 'Quote paths in the shell.' },
];

test('find ranks the lexical matches first and appends every standard', () => {
  const got = find('the vpn container restarted and torrent stalled', books).map((b) => b.file);
  assert.deepEqual(got, ['torrent-vpn.md', 'secrets.md', 'quoting.md']);
});

test('a standard that matched is listed once, in its ranked place', () => {
  const got = find('credential values in the transcript', books).map((b) => b.file);
  assert.deepEqual(got, ['secrets.md', 'quoting.md']);
});

test('an empty phrase or an empty corpus finds nothing', () => {
  assert.deepEqual(find('', books), []);
  assert.deepEqual(find('   ', books), []);
  assert.deepEqual(find('vpn', []), []);
});

test('find caps the lexical matches at n', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ file: `v${i}.md`, type: 'reference', purpose: `vpn note ${i}` }));
  assert.equal(FIND_N, 8);
  assert.equal(find('vpn', many).length, 8);
  assert.equal(find('vpn', many, 3).length, 3);
});

test('lines prints an absolute forward-slash path, a tab, the purpose', () => {
  assert.deepEqual(lines([books[1]], 'C:\\r\\docs'), ['C:/r/docs/backup-prune.md\tThe nightly backup pruned nothing.']);
  assert.equal(slash('a\\b/c'), 'a/b/c');
});

test('judge returns the ranked scores, and says why when there are none', async (t) => {
  process.env.JEV_SPEND_DISABLED = '1';
  t.after(() => { delete process.env.JEV_SPEND_DISABLED; });
  const answers = { [keyFor(books[0])]: { noul: 0.93 }, [keyFor(books[2])]: { noul: 0.2 } };
  const stub = async () => ({ ok: true, status: 200, json: async () => ({ answers }) });
  const j = await judge('the torrent client stalls after a vpn restart', books, 'k', stub, {});
  assert.equal(j.ok, true);
  assert.deepEqual(j.ranked[0], { file: 'torrent-vpn.md', p: 0.93 });
  const none = await judge('the torrent client stalls after a vpn restart', books, null, stub, {});
  assert.deepEqual(none, { ok: false, why: 'no key', ranked: [] });
  const short = await judge('vpn', books, 'k', stub, {});
  assert.deepEqual(short, { ok: false, why: 'short prompt', ranked: [] });
});

// The fixture is its own git repo with HOME pointed at it, so no real runbooks folder and no real
// key file can leak in. This is spec gate 8: the default mode needs no key and no network.
function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rb-find-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', base]);
  const docs = path.join(base, 'docs', 'runbooks');
  fs.mkdirSync(docs, { recursive: true });
  for (const b of books) fs.writeFileSync(path.join(docs, b.file), `# T\n**Type:** ${b.type}\n**Purpose:** ${b.purpose}\n`);
  const env = { ...process.env, HOME: base, USERPROFILE: base, LOCALAPPDATA: base, RUNBOOKS_DIR: '', OPENROUTER_API_KEY: '' };
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: base, env, encoding: 'utf8' });
  return { base, docs, run };
}

test('the CLI default mode prints path and purpose with no key', (t) => {
  const f = fixture(t);
  const r = f.run('the nightly backup pruned nothing again');
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim().split('\n');
  assert.equal(out[0], `${slash(path.join(f.docs, 'backup-prune.md'))}\tThe nightly backup pruned nothing.`);
  assert.equal(out.length, 3, 'one match and the two standards');
});

test('the CLI prints JSON on --json', (t) => {
  const f = fixture(t);
  const r = f.run('the nightly backup pruned nothing again', '--json');
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.deepEqual(rows[0], { path: slash(path.join(f.docs, 'backup-prune.md')), type: 'procedure', purpose: 'The nightly backup pruned nothing.' });
});

test('the CLI exits 2 with no phrase, 1 with --judge and no key, 0 and silent with no runbooks folder', (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 2);
  const j = f.run('the nightly backup pruned nothing again', '--judge');
  assert.equal(j.status, 1);
  assert.match(j.stderr, /no score \(no key\)/);
  fs.rmSync(path.join(f.base, 'docs'), { recursive: true, force: true });
  const gone = f.run('the nightly backup pruned nothing again');
  assert.equal(gone.status, 0);
  assert.equal(gone.stdout, '');
});
