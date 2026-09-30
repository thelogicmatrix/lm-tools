import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_FILE, claimRunbooks, clearSent, readSent, scopeOf, sentFile } from '../scripts/session.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'session.mjs');
const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-sent-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('scopeOf separates a subagent from its parent, and is null without a session', () => {
  assert.equal(scopeOf({ session_id: 's1' }), 's1\0');
  assert.equal(scopeOf({ session_id: 's1', agent_id: 'a1' }), 's1\0a1');
  assert.notEqual(sentFile(scopeOf({ session_id: 's1' }), 'd'), sentFile(scopeOf({ session_id: 's1', agent_id: 'a1' }), 'd'));
  assert.equal(scopeOf({}), null);
  assert.equal(scopeOf(null), null);
  assert.equal(scopeOf({ session_id: 7 }), null);
});

test('a runbook is claimed once per scope', (t) => {
  const dir = tmp(t);
  assert.deepEqual(claimRunbooks('s\0', ['a.md', 'b.md'], { dir }), ['a.md', 'b.md']);
  assert.deepEqual(claimRunbooks('s\0', ['b.md', 'c.md', 'c.md'], { dir }), ['c.md']);
  assert.deepEqual(claimRunbooks('s\0', ['a.md'], { dir }), []);
  assert.deepEqual(readSent('s\0', dir), ['a.md', 'b.md', 'c.md']);
  // Another conversation starts clean.
  assert.deepEqual(claimRunbooks('s\0agent', ['a.md'], { dir }), ['a.md']);
});

test('no scope means no dedupe and no file', (t) => {
  const dir = tmp(t);
  assert.deepEqual(claimRunbooks(null, ['a.md'], { dir }), ['a.md']);
  assert.deepEqual(claimRunbooks(null, ['a.md'], { dir }), ['a.md']);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a corrupt ledger reads as empty, and an unwritable dir still returns the files', (t) => {
  const dir = tmp(t);
  fs.writeFileSync(sentFile('s\0', dir), '{not json');
  assert.deepEqual(readSent('s\0', dir), []);
  const blocked = path.join(dir, 'file-not-dir');
  fs.writeFileSync(blocked, 'x');
  assert.deepEqual(claimRunbooks('s\0', ['a.md'], { dir: blocked }), ['a.md']);
});

test('the first write in a scope prunes state files older than a day, and nothing else', (t) => {
  const dir = tmp(t);
  const old = Date.now() - 2 * 86_400_000;
  for (const name of ['sent-0123456789ab.json', 'triggers-0123456789ab.json', 'sent-0123456789ab.json.41.tmp', 'dedupe-0123456789ab.json', 'notes.json']) {
    fs.writeFileSync(path.join(dir, name), '{}');
    fs.utimesSync(path.join(dir, name), old / 1000, old / 1000);
  }
  claimRunbooks('s\0', ['a.md'], { dir });
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, ['dedupe-0123456789ab.json', 'notes.json', path.basename(sentFile('s\0', dir))].sort());
  assert.ok(STATE_FILE.test('triggers-0123456789ab.json'));
  assert.ok(!STATE_FILE.test('dedupe-0123456789ab.json'));
});

test('clearSent forgets one scope only', (t) => {
  const dir = tmp(t);
  claimRunbooks('s\0', ['a.md'], { dir });
  claimRunbooks('s\0agent', ['a.md'], { dir });
  clearSent('s\0', { dir });
  assert.deepEqual(readSent('s\0', dir), []);
  assert.deepEqual(readSent('s\0agent', dir), ['a.md']);
  clearSent(null, { dir });
});

test('--clear reads the scope from stdin, and bad stdin exits 0', (t) => {
  const dir = tmp(t);
  const env = { ...process.env, LOCALAPPDATA: dir, HOME: dir, USERPROFILE: dir };
  const state = path.join(dir, 'claude-router');
  claimRunbooks('s9\0', ['a.md'], { dir: state });
  const ok = spawnSync(process.execPath, [SCRIPT, '--clear'], { input: JSON.stringify({ session_id: 's9' }), env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(readSent('s9\0', state), []);
  const bad = spawnSync(process.execPath, [SCRIPT, '--clear'], { input: 'not json', env, encoding: 'utf8' });
  assert.equal(bad.status, 0, bad.stderr);
  assert.equal(bad.stdout, '');
});
