import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askJev } from './lib.mjs';

test('the shared Jev client records each response under its calling tool', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-client-spend-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prevLog = process.env.JEV_SPEND_LOG;
  const prevFetch = globalThis.fetch;
  process.env.JEV_SPEND_LOG = join(dir, 'calls.jsonl');
  t.after(() => { globalThis.fetch = prevFetch;
    if (prevLog === undefined) delete process.env.JEV_SPEND_LOG;
    else process.env.JEV_SPEND_LOG = prevLog; });
  globalThis.fetch = async () => new Response(JSON.stringify({ answers: {},
    usage: { cost: 0.00004, input_tokens: 900 } }), { status: 200 });
  await askJev('sample', { q: { type: 'noul', instructions: 'Sample' } }, 'dummy',
    { spend: { tool: 'jevchecker', session: 'session-a' } });
  const rows = readFileSync(process.env.JEV_SPEND_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual([rows[0].tool, rows[0].session, rows[0].cost, rows[0].questions],
    ['jevchecker', 'session-a', 0.00004, 1]);
  globalThis.fetch = async () => new Response('bad request', { status: 400 });
  await assert.rejects(() => askJev('sample', {}, 'dummy',
    { spend: { tool: 'jevchecker', session: 'session-a' } }), /HTTP 400/);
  const afterFailure = readFileSync(process.env.JEV_SPEND_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(afterFailure.length, 2);
  assert.equal(afterFailure[1].cost, null);
  assert.equal(afterFailure[1].status, 'unreported');
  let attempts = 0;
  globalThis.fetch = async () => ++attempts === 1
    ? new Response('retry', { status: 503 })
    : new Response(JSON.stringify({ answers: {}, usage: { cost: 0.00005 } }), { status: 200 });
  await askJev('sample', {}, 'dummy',
    { attempts: 2, baseDelayMs: 0, spend: { tool: 'jevchecker', session: 'session-a' } });
  const afterRetry = readFileSync(process.env.JEV_SPEND_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(afterRetry.slice(2).map((row) => [row.status, row.cost]),
    [['unreported', null], ['ok', 0.00005]],
    'a retried attempt may be billed even when a later attempt succeeds');
});
