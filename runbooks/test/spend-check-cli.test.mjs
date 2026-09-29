import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('check.mjs marks a paid purpose-line probe as purpose_test', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'purpose-spend-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(join(dir, 'docs', 'runbooks'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'runbooks', 'commute.md'),
    '# Commute\n\n**Type:** reference\n**Purpose:** How long my commute to work takes.\n');
  const fetchStub = `globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    return new Response(JSON.stringify({
      answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { noul: 0.9 }])),
      usage: { cost: 0.0002, input_tokens: 4000 }
    }), { status: 200 });
  };`;
  const file = join(dir, 'calls.jsonl');
  const cli = join(import.meta.dirname, '..', 'scripts', 'check.mjs');
  const result = spawnSync(process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(fetchStub)}`, cli,
      'commute.md', 'how long is my commute to work'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: dir, USERPROFILE: dir,
      LOCALAPPDATA: dir, JEV_SPEND_LOG: file, OPENROUTER_API_KEY: 'dummy' } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const row = JSON.parse(readFileSync(file, 'utf8').trim());
  assert.equal(row.activity, 'purpose_test');
  assert.equal(row.target, 'commute.md');
  assert.equal(row.cost, 0.0002);
});
