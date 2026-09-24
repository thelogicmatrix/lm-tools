#!/usr/bin/env node
// How well does Jev judge a job from a TITLE AND A COMPANY NAME, and nothing else?
//
// This is the minimum-context test. The JD sweep gave it 3,400 characters a row; here it gets
// about 50, which is all `prefilter.mjs` gets too. That makes the comparison exact: the regex and
// the model see the same bytes, so any difference is judgement rather than access to more text.
//
// The corpus forces it anyway. 7,623 rows from the 2026-08-13 board sweep, and the median
// `description` length is 0 — most ATS list endpoints return no body at all, which is the whole
// reason prefilter.mjs judges titles in the first place.
//
// It is also the right corpus for the MLM signals. On the LinkedIn JD sweep they fired at under
// 0.5% and `recruits_your_network` never fired at all, because LinkedIn does not carry those
// postings. prefilter.mjs found ~75 MLM rejects on the 2026-08-05 BOARD run, one employer posting
// 47 near-identical "Entry Level Marketing Associate" rows. If the signals work, they work here.
//
//   node titles.mjs --limit 200 --json probe.json
//   node titles.mjs --json titles-tags.json
//   node titles.mjs --selftest

import fs from 'node:fs';
import assert from 'node:assert';
import { askJev, runPool, noulsFrom } from './lib.mjs';
// ponytail: absolute import into home's orion skill. orion is frozen with the job hunt, so a
// cross-repo path is the whole fix. Upgrade path: copy prefilter.mjs and run.mjs in here.
import { classify, isMlm, titleForRules } from 'file:///C:/Users/thelo/.claude/skills/orion/lib/prefilter.mjs';

const CACHE = 'C:/Users/thelo/job-search/cache/ats_sweep_2026-08-13.json';
// Higher than the JD sweep: a ~50-character state is nearly all latency and no tokens, so the
// limit here is round trips rather than anything server-side.
const CONCURRENCY = 12;
const FIRES_AT = 0.5;

// Deliberately phrased as judgements about a TITLE, not about a job. Asking "does this role require
// three years" of a bare title would be asking the model to invent, and inviting the empty-state
// failure the limits probe found: given nothing to read, Jev answers from a prior rather than
// saying no.
const TAGS = {
  too_senior: 'This job title names a manager, lead, principal, head, director or C-suite seat',
  excluded_function: 'This title names software engineering, sales, customer success, or recruitment as the job function',
  not_fulltime: 'This title says the position is an internship, traineeship, part-time, casual or seasonal',
  ai_ml_engineering: 'This title names an AI engineer, ML engineer, data scientist or research scientist seat',
  archetype_signal: 'This title mentions automation, operations, process improvement, digitalisation, transformation, analytics or internal tooling',

  // The MLM and scam signals, judged on the employer name as much as the title. prefilter.mjs reads
  // the employer for exactly this rule and no other, because that is where most of the signal is.
  mlm_or_direct_sales: 'Taken together, this employer name and job title are typical of a multi-level marketing, network marketing or door-to-door direct sales operation rather than a salaried role',
  mass_posted_filler: 'This looks like one of many near-identical postings from the same employer, written to attract volume rather than to describe a specific job',
  promise_in_title: 'The title itself makes a promise about earnings, rapid promotion, travel or lifestyle, rather than naming the work',
  shell_company_name: 'The employer name is generic or vague in the way a shell or rebranding outfit is, rather than a recognisable business',
};
const IDS = Object.keys(TAGS);
const questions = Object.fromEntries(IDS.map((id) => [id, { type: 'noul', instructions: TAGS[id] }]));

// EXACTLY what prefilter.mjs judges, so the diff is honest: its own titleForRules, which unions the
// stored title with a Workday URL slug, plus the company, which only its mlm rule is allowed to see.
export function stateFor(r) {
  const t = titleForRules(r);
  return `Employer: ${r.company ?? ''}\nJob title: ${t}${r.location ? `\nLocation: ${r.location}` : ''}`;
}

export function regexVerdict(r) {
  const c = classify(titleForRules(r), r.company);
  return { bucket: c.bucket, reason: c.reason, mlm: isMlm(String(r.title ?? ''), String(r.company ?? '')) };
}

export function selftest() {
  assert.deepStrictEqual(Object.keys(noulsFrom({}, IDS)), IDS);
  assert.strictEqual(noulsFrom({}, IDS).mlm_or_direct_sales, null);
  // The state must carry the employer, because the MLM judgement lives there as much as in the
  // title, and must carry the slug-unioned title rather than the stored one.
  const s = stateFor({ company: 'ROYAL ORG PTE. LTD.', title: 'Entry Level Marketing Associate' });
  assert.ok(s.includes('ROYAL ORG'));
  assert.ok(s.includes('Entry Level Marketing Associate'));
  // A Workday slug that names a band the stored title hides must reach the state, since that is
  // what prefilter.mjs judges. Real shape from the 07-30 pool.
  const wd = { company: 'Keppel', title: 'Associate, Investment',
    url: 'https://x.wd3.myworkdayjobs.com/en-US/Careers/job/Singapore/Associate--Assistant-Vice-President--Investment_JR1' };
  assert.ok(/Assistant Vice President/i.test(stateFor(wd)), 'the posting slug must reach the state');
  // And the regex side agrees it is a band, so the diff is comparing like with like.
  assert.strictEqual(regexVerdict(wd).reason, 'seniority');
  assert.strictEqual(regexVerdict({ company: 'Acme', title: 'Sales Executive' }).reason, 'function');
  assert.strictEqual(regexVerdict({ company: 'Acme', title: 'Marketing Intern' }).reason, 'not-fulltime');
  assert.strictEqual(regexVerdict({ company: 'Acme', title: 'Digital Automation Engineer (RPA)' }).bucket, 'read');
  assert.strictEqual(regexVerdict({ company: 'ROYAL ORG PTE. LTD.', title: 'Marketing Associate' }).mlm, true);
  assert.strictEqual(regexVerdict({ company: 'Keppel', title: 'Analyst' }).mlm, false);
  return 'titles sweep selftest OK';
}

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : argv[i + 1]; };
if (flag('selftest')) { console.log(selftest()); process.exit(0); }

const raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const rowsIn = (Array.isArray(raw) ? raw : Object.values(raw).find((v) => Array.isArray(v)))
  // A title is the whole state here, so an empty one would be the empty-state trap: Jev would
  // answer from a prior and every tag would be noise.
  .filter((r) => r && String(r.title ?? '').trim().length > 3);
const subset = rowsIn.slice(0, Number(opt('limit')) || rowsIn.length);

const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }

console.log(selftest());
console.log(`sweeping ${subset.length} titles, ${CONCURRENCY} at a time`);
const t0 = Date.now();
let last = 0;
const rows = await runPool(subset, async (r) => {
  try {
    const { answers, cost } = await askJev(stateFor(r), questions, key);
    return { title: r.title, company: r.company, source: r.source,
      tags: noulsFrom(answers, IDS), regex: regexVerdict(r), cost };
  } catch (e) {
    return { title: r.title, company: r.company, tags: null, error: e.message };
  }
}, CONCURRENCY, (done, total) => {
  if (done - last >= 500 || done === total) { console.error(`  ${done}/${total}`); last = done; }
});

const ok = rows.filter((r) => r.tags);
const on = (r, id) => r.tags[id] !== null && r.tags[id] >= FIRES_AT;

console.log(`\n  ${'tag'.padEnd(22)} fires   rate`);
for (const id of IDS) {
  const n = ok.filter((r) => on(r, id)).length;
  console.log(`  ${id.padEnd(22)}${String(n).padStart(6)}  ${(n / ok.length * 100).toFixed(1)}%`);
}

// The diff, against prefilter's own buckets. Each pair is (what the regex concluded, what Jev said).
const PAIRS = [
  ['too_senior', (v) => v.reason === 'seniority'],
  ['excluded_function', (v) => v.reason === 'function'],
  ['not_fulltime', (v) => v.reason === 'not-fulltime'],
  ['mlm_or_direct_sales', (v) => v.mlm],
];
console.log(`\n  ${'decision'.padEnd(22)} regex   jev  both  regex-only  jev-only`);
for (const [id, pred] of PAIRS) {
  let rx = 0; let jv = 0; let both = 0; let rOnly = 0; let jOnly = 0;
  for (const r of ok) {
    const a = pred(r.regex); const b = on(r, id);
    if (a) rx++;
    if (b) jv++;
    if (a && b) both++; else if (a) rOnly++; else if (b) jOnly++;
  }
  console.log(`  ${id.padEnd(22)}${String(rx).padStart(6)}${String(jv).padStart(6)}${String(both).padStart(6)}`
    + `  ${String(rOnly).padStart(10)}  ${String(jOnly).padStart(8)}`);
}

// prefilter's three buckets, against how Jev would have bucketed. This is the number that decides
// whether the auto bucket could ever be replaced, and the answer is expected to be no.
const buckets = { auto: 0, veto: 0, read: 0 };
for (const r of ok) buckets[r.regex.bucket]++;
console.log(`\n  prefilter buckets: auto ${buckets.auto}, veto ${buckets.veto}, read ${buckets.read}`);

const cost = ok.reduce((s, r) => s + (r.cost ?? 0), 0);
const secs = (Date.now() - t0) / 1000;
console.log(`  swept           ${ok.length} titles`);
console.log(`  failed          ${rows.filter((r) => r.error).length}`);
console.log(`  wall clock      ${secs.toFixed(0)}s  (${(ok.length / secs).toFixed(1)}/sec at concurrency ${CONCURRENCY})`);
console.log(`  cost            $${cost.toFixed(4)}  ($${(cost / ok.length * 1000).toFixed(4)} per 1,000 titles)`);

if (opt('json')) {
  fs.writeFileSync(opt('json'), JSON.stringify(rows.map(({ cost: _c, ...r }) => r), null, 2));
  console.log(`\nwritten to ${opt('json')}`);
}
