import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSpend, summarizeSpend } from './spend.mjs';

test('Jev calls record reported cost by tool, session and activity without prompt text', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-spend-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'calls.jsonl');
  recordSpend({ tool: 'jevmail', activity: 'tool', session: 'session-one',
    usage: { cost: 0.00012, input_tokens: 2500, output_tokens: 10 }, questions: 8,
    status: 'ok' }, { file });
  recordSpend({ tool: 'jevchecker', activity: 'tool', session: null,
    usage: null, questions: 2, status: 'unreported' }, { file, env: {} });
  recordSpend({ tool: 'jevclick', usage: { cost: 0.00003 }, questions: 1 },
    { file, env: { CODEX_THREAD_ID: 'thread-two' } });
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].tool, rows[0].activity, rows[0].session, rows[0].cost,
    rows[0].input_tokens, rows[0].questions],
  ['jevmail', 'tool', 'session-one', 0.00012, 2500, 8]);
  assert.equal(rows[1].cost, null, 'unknown billed cost must not be reported as zero');
  assert.equal(rows[1].session, null, 'an unknown session stays unknown');
  assert.equal(rows[2].session, 'thread-two', 'the harness thread identifies a CLI caller');
  assert.ok(rows.every((row) => !('prompt' in row) && !('state' in row)));
  const report = summarizeSpend(rows);
  assert.equal(report.reported_cost, 0.00015);
  assert.equal(report.unreported_calls, 1);
  assert.deepEqual(report.by_tool.map((row) => [row.name, row.calls]),
    [['jevmail', 1], ['jevclick', 1], ['jevchecker', 1]]);
});

test('stubbed CLI calls can disable the journal', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-spend-disabled-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'calls.jsonl');
  assert.equal(recordSpend({ tool: 'jevchecker', usage: { cost: 1 } },
    { file, env: { JEV_SPEND_DISABLED: '1' } }), false);
  assert.throws(() => readFileSync(file), { code: 'ENOENT' });
});
