// Latency benchmark. Two claims to test: that a call is 70-500ms end to end, and that adding
// questions barely changes the response time because they evaluate in parallel against one state.
// Both matter for Orion, and the second decides whether a rubric can be wide for free.
import fs from 'node:fs';
import path from 'node:path';

const ENDPOINT = 'https://openrouter.ai/api/v1/systemone';
const MODEL = 'jev-latest';
const TRIALS = 7;
// ponytail: absolute path into home's job-search data, which stayed in home when this moved.
const DOCS = 'C:/Users/thelo/docs/job-search';

const jf = JSON.parse(fs.readFileSync(path.join(DOCS, '_jds.json'), 'utf8'));
const jd = Object.values(jf.jds).find((e) => e.chars > 3500 && e.chars < 4500);
const state = jd.text;

// A pool of distinct yes/no questions so a wider set is genuinely more work, not the same
// question repeated (which a server could legitimately collapse).
const BANK = [
  'The role is based in Singapore', 'The role involves process automation',
  'The employer is a financial institution', 'The role requires a degree',
  'The role mentions artificial intelligence', 'The role is customer facing',
  'The posting names a specific software tool', 'The role involves managing people',
  'The role mentions remote or hybrid work', 'The posting states a salary range',
  'The role involves data analysis', 'The posting mentions equity or stock options',
];
const questions = (n) => Object.fromEntries(
  BANK.slice(0, n).map((q, i) => [`q${i}`, { type: 'noul', instructions: q }]));

const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)];

const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }

console.log(`state: ${jd.chars} chars (~${Math.round(jd.chars / 4)} tokens), ${TRIALS} trials each\n`);
console.log('  questions   median     p90      min      max   cost/call');
for (const n of [1, 3, 6, 12]) {
  const body = JSON.stringify({ model: MODEL, state, questions: questions(n) });
  const ms = []; let cost = 0;
  for (let i = 0; i < TRIALS; i++) {
    const t0 = performance.now();
    const res = await fetch(ENDPOINT, { method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body });
    const j = await res.json();
    ms.push(performance.now() - t0);
    if (!res.ok) { console.error(`  n=${n} HTTP ${res.status}`, JSON.stringify(j).slice(0, 160)); break; }
    cost = j.usage?.cost ?? 0;
  }
  if (!ms.length) continue;
  console.log(`  ${String(n).padStart(9)}   ${pct(ms,0.5).toFixed(0).padStart(6)}ms `
    + `${pct(ms,0.9).toFixed(0).padStart(6)}ms ${Math.min(...ms).toFixed(0).padStart(6)}ms `
    + `${Math.max(...ms).toFixed(0).padStart(6)}ms   ${cost ? '$'+cost.toFixed(6) : 'n/a'}`);
}
