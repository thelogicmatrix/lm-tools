import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyFor, route } from '../scripts/router.mjs';

test('live routing and purpose-line checks get distinct spend rows', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'runbook-spend-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'calls.jsonl');
  const prev = process.env.JEV_SPEND_LOG;
  process.env.JEV_SPEND_LOG = file;
  t.after(() => { if (prev === undefined) delete process.env.JEV_SPEND_LOG;
    else process.env.JEV_SPEND_LOG = prev; });
  const book = { file: 'commute.md', type: 'reference', purpose: 'Commute facts' };
  const fetch = async () => ({ ok: true, json: async () => ({
    answers: { [keyFor(book)]: { noul: 0.9 } },
    usage: { cost: 0.0002, input_tokens: 4000, output_tokens: 20 },
  }) });
  await route('How long is my commute?', [book], 'dummy', fetch,
    { narrow: false, spend: { activity: 'active_route', session: 'hook-session' } });
  await route('How long is my commute?', [book], 'dummy', fetch,
    { narrow: false, spend: { activity: 'purpose_test', session: 'check-session', target: 'commute.md' } });
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map((row) => [row.tool, row.activity, row.session, row.target, row.cost]), [
    ['runbooks', 'active_route', 'hook-session', null, 0.0002],
    ['runbooks', 'purpose_test', 'check-session', 'commute.md', 0.0002],
  ]);
  process.env.JEV_SPEND_DISABLED = '1';
  t.after(() => { delete process.env.JEV_SPEND_DISABLED; });
  await route('How long is my commute?', [book], 'dummy', fetch,
    { narrow: false, spend: { activity: 'active_route' } });
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
});
