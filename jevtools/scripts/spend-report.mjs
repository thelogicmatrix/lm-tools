#!/usr/bin/env node
// Read-only report over usage receipts from local Jev callers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSpend, summarizeSpend, spendPath } from './spend.mjs';

const args = process.argv.slice(2);
const sinceAt = args.indexOf('--since');
const since = sinceAt < 0 ? null : args[sinceAt + 1];
if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error('usage: spend-report.mjs [--json] [--since YYYY-MM-DD]');
  process.exit(2);
}
const legacyPath = process.env.JEV_LEGACY_SPEND_LOG || (process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'claude-router', 'spend.jsonl')
  : path.join(os.homedir(), '.local', 'state', 'claude-router', 'spend.jsonl'));
const lines = (file) => {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const legacy = lines(legacyPath).map((line) => JSON.parse(line))
  .filter((row) => !since || row.t >= since);
const allRows = readSpend(spendPath());
const rows = allRows.filter((row) => !since || row.t >= since);
const report = {
  ...summarizeSpend(rows),
  legacy_unclassified: {
    calls: legacy.length,
    reported_cost: Number(legacy.reduce((sum, row) => sum + (Number(row.c) || 0), 0).toFixed(12)),
  },
  external_unallocated: ['Hindsight reranker'],
};

// A run rate needs seven complete UTC days of records. Partial first-day data is not projected.
const today = new Date();
const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
const start = end - 7 * 86_400_000;
const first = Math.min(...allRows.map((row) => Date.parse(row.t)));
report.projected_30d = first <= start
  ? Number((allRows.filter((row) => { const t = Date.parse(row.t); return t >= start && t < end; })
    .reduce((sum, row) => sum + (typeof row.cost === 'number' ? row.cost : 0), 0) * 30 / 7).toFixed(6))
  : null;

if (args.includes('--json')) console.log(JSON.stringify(report));
else {
  console.log(`Jev local reported cost: $${report.reported_cost.toFixed(6)} across ${report.calls} calls`);
  if (report.unreported_calls) console.log(`${report.unreported_calls} calls have no billed usage receipt`);
  for (const [label, list] of [['activity', report.by_activity], ['tool', report.by_tool], ['session', report.by_session]]) {
    console.log(`\nBy ${label}`);
    for (const row of list) console.log(`  ${row.name}: $${row.reported_cost.toFixed(6)} (${row.calls} calls)`);
  }
  console.log(`\nLegacy router log, unclassified: $${report.legacy_unclassified.reported_cost.toFixed(6)} (${report.legacy_unclassified.calls} calls)`);
  console.log('Hindsight reranker: unallocated, outside this local tracker');
  console.log(report.projected_30d === null
    ? '30-day run rate: available after seven complete UTC days of journal coverage'
    : `30-day run rate from the last seven complete UTC days: $${report.projected_30d.toFixed(4)}`);
}
