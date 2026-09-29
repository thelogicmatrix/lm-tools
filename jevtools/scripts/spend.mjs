// Local Jev usage journal. A response's usage block is the only source of billed cost.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const RUN = crypto.randomUUID();
let warned = false;
const numeric = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
export const spendPath = (env = process.env, home = os.homedir()) =>
  env.JEV_SPEND_LOG || path.join(home, '.local', 'state', 'jev-spend', 'calls.jsonl');
export const sessionId = (env = process.env) => env.CODEX_THREAD_ID
  || env.CODEX_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || null;
const caller = () => path.basename(process.argv[1] || 'unknown', '.mjs');

export function recordSpend(entry, options = {}) {
  const env = options.env || process.env;
  const file = options.file || spendPath(env);
  if (env.JEV_SPEND_DISABLED === '1') return false;
  // Stubbed API responses in the repository's executable tests are not provider spend.
  if ((process.argv[1] || '').endsWith('.test.mjs') && !options.file && !env.JEV_SPEND_LOG) return false;
  const row = {
    t: new Date().toISOString(), tool: entry.tool || caller(),
    activity: entry.activity || 'tool',
    session: Object.hasOwn(entry, 'session') ? entry.session : sessionId(env),
    run: RUN, target: entry.target || null, status: entry.status || 'ok',
    model: entry.model || 'jev-latest',
    cost: numeric(entry.usage?.cost),
    input_tokens: numeric(entry.usage?.input_tokens),
    output_tokens: numeric(entry.usage?.output_tokens),
    questions: numeric(entry.questions),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
    return true;
  } catch (error) {
    if (!warned) { console.error(`jev spend: could not write usage journal (${error.code || error.message})`); warned = true; }
    return false;
  }
}

export function readSpend(file = spendPath()) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function summarizeSpend(rows) {
  const money = (n) => Number(n.toFixed(12));
  const group = (field) => {
    const sums = new Map();
    for (const row of rows) {
      const name = row[field] || 'unassigned';
      const value = sums.get(name) || { name, calls: 0, reported_cost: 0, unreported_calls: 0 };
      value.calls++;
      if (typeof row.cost === 'number' && Number.isFinite(row.cost)) value.reported_cost += row.cost;
      else value.unreported_calls++;
      sums.set(name, value);
    }
    return [...sums.values()].map((row) => ({ ...row, reported_cost: money(row.reported_cost) }))
      .sort((a, b) => b.reported_cost - a.reported_cost || a.name.localeCompare(b.name));
  };
  return {
    calls: rows.length,
    reported_cost: money(rows.reduce((sum, row) => sum + (typeof row.cost === 'number' && Number.isFinite(row.cost) ? row.cost : 0), 0)),
    unreported_calls: rows.filter((row) => typeof row.cost !== 'number' || !Number.isFinite(row.cost)).length,
    by_activity: group('activity'), by_tool: group('tool'), by_session: group('session'),
    by_target: group('target'),
  };
}
