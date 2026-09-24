#!/usr/bin/env node
// Find where Jev breaks, on a real corpus rather than a toy.
//
// The sweep scripts measure what Jev says. This measures what it CANNOT do, which is the half that
// belongs in a runbook: every number here is meant to become a line someone reads before designing
// a sweep. Each experiment is independent and prints its own verdict.
//
// Corpus is the LinkedIn JD cache, 4,883 usable bodies, median 3,379 chars, longest 24,296.
//
//   node limits.mjs --only 3        run one experiment
//   node limits.mjs                 all of them, roughly $0.03

import fs from 'node:fs';
import { askJev, runPool, toText } from './lib.mjs';

const CACHE = 'C:/Users/thelo/job-search/cache/li_details.json';
const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }

const all = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const corpus = (Array.isArray(all) ? all : Object.values(all))
  .filter((r) => r && String(r.jd_text ?? '').length > 200);
const body = (r) => toText(r.jd_text);
const med = corpus.find((r) => body(r).length > 3200 && body(r).length < 3600);
const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)];
const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;

const BANK = [
  'The role is based in Singapore', 'The role involves process automation',
  'The employer is a financial institution', 'The role requires a degree',
  'The role mentions artificial intelligence', 'The role is customer facing',
  'The posting names a specific software tool', 'The role involves managing people',
  'The role mentions remote or hybrid work', 'The posting states a salary range',
  'The role involves data analysis', 'The posting mentions equity or stock options',
  'The role requires fluent Mandarin', 'The employer is a startup',
  'The role involves working with external clients', 'The posting mentions overtime',
  'The role requires a professional certification', 'The posting mentions career progression',
  'The role involves budget responsibility', 'The posting mentions training provided',
  'The role requires travel', 'The posting names a named competitor',
  'The role is in a regulated industry', 'The posting mentions headcount or team size',
  'The role involves vendor management', 'The posting mentions a probation period',
  'The role requires shift work', 'The posting mentions medical benefits',
  'The role involves reporting to senior leadership', 'The posting mentions relocation support',
];
const nouls = (n) => Object.fromEntries(BANK.slice(0, n).map((q, i) => [`q${i}`, { type: 'noul', instructions: q }]));

const only = process.argv.includes('--only') ? Number(process.argv[process.argv.indexOf('--only') + 1]) : null;
const run = (n) => only === null || only === n;
let spend = 0;
const timed = async (state, qs) => {
  const t = performance.now();
  const r = await askJev(state, qs, key);
  spend += r.cost ?? 0;
  return { ms: performance.now() - t, ...r };
};

// 1. Does "questions are free" hold past 12? The bench measured 1 to 12 as flat. If it stays flat
// to 30, a sweep vocabulary can be as wide as the design wants, which changes how these are built.
if (run(1)) {
  console.log('\n=== 1. question count vs latency and cost ===');
  const state = body(med);
  console.log(`  state ${state.length} chars | 5 trials each`);
  console.log('  questions   median     p90    cost/call   cost/question');
  for (const n of [1, 6, 12, 20, 30]) {
    const rs = [];
    for (let i = 0; i < 5; i++) rs.push(await timed(state, nouls(n)));
    const c = rs.at(-1).cost ?? 0;
    console.log(`  ${String(n).padStart(9)}  ${pct(rs.map((r) => r.ms), 0.5).toFixed(0).padStart(6)}ms `
      + `${pct(rs.map((r) => r.ms), 0.9).toFixed(0).padStart(6)}ms   $${c.toFixed(6)}   $${(c / n).toFixed(7)}`);
  }
}

// 2. How does it fail when the state exceeds the 32K context? An error is fine; silent truncation
// is not, because a sweep would then quietly judge only the first half of every long document.
if (run(2)) {
  console.log('\n=== 2. state length, and the failure mode past the context limit ===');
  const long = corpus.map(body).sort((a, b) => b.length - a.length)[0];
  for (const chars of [1000, 4000, 14000, 24000, 60000, 200000]) {
    const state = chars <= long.length ? long.slice(0, chars) : long.repeat(Math.ceil(chars / long.length)).slice(0, chars);
    try {
      const r = await timed(state, nouls(6));
      const vals = Object.values(r.answers).map((a) => a.noul);
      console.log(`  ${String(chars).padStart(7)} chars  ${r.ms.toFixed(0).padStart(5)}ms  $${(r.cost ?? 0).toFixed(6)}`
        + `  answers ${vals.length}  mean ${mean(vals).toFixed(2)}`);
    } catch (e) {
      console.log(`  ${String(chars).padStart(7)} chars  REFUSED: ${e.message.slice(0, 110)}`);
    }
  }
  console.log('  (a refusal is the good outcome; an answer at 200k chars would mean silent truncation)');
}

// 3. Does taking the HEAD of a long JD lose the bars? Citizenship, language and employment clauses
// often sit at the bottom of a posting, and jevjd.mjs caps the state at 14k chars from the top. If
// this shows losses, that cap is a bug rather than an optimisation.
if (run(3)) {
  console.log('\n=== 3. head-truncation vs full text, on long JDs ===');
  const longs = corpus.filter((r) => body(r).length > 16000).slice(0, 40);
  const qs = {
    citizen: { type: 'noul', instructions: 'This role is open only to citizens, excluding permanent residents' },
    chinese: { type: 'noul', instructions: 'This role requires fluent or professional-level Mandarin or Chinese' },
    years3: { type: 'noul', instructions: 'This job description requires at least three years of prior work experience' },
    notft: { type: 'noul', instructions: 'This posting is for an internship, part-time, casual or seasonal position' },
  };
  const pairs = await runPool(longs, async (r) => {
    const full = body(r);
    const [a, b] = await Promise.all([timed(full.slice(0, 14000), qs), timed(full, qs)]);
    return { head: a.answers, whole: b.answers };
  }, 4);
  console.log(`  ${longs.length} JDs over 16k chars, head-14k against full text`);
  for (const k of Object.keys(qs)) {
    const moved = pairs.filter((p) => Math.abs(p.head[k].noul - p.whole[k].noul) >= 0.25);
    const lost = pairs.filter((p) => p.whole[k].noul >= 0.5 && p.head[k].noul < 0.5);
    console.log(`  ${k.padEnd(9)} moved>=0.25: ${String(moved.length).padStart(3)}   MISSED by head-only: ${lost.length}`);
  }
}

// 4. Determinism across many documents, not one. The bench measured one document five times
// (spread <=0.03). If drift is larger across a corpus, nothing downstream can be cached or diffed.
if (run(4)) {
  console.log('\n=== 4. run-to-run drift across 40 documents ===');
  const sample = corpus.filter((_, i) => i % 97 === 0).slice(0, 40);
  const qs = nouls(6);
  const drifts = await runPool(sample, async (r) => {
    const st = body(r).slice(0, 8000);
    const [a, b] = await Promise.all([timed(st, qs), timed(st, qs)]);
    return Math.max(...Object.keys(qs).map((k) => Math.abs(a.answers[k].noul - b.answers[k].noul)));
  }, 4);
  console.log(`  max per-document drift: median ${pct(drifts, 0.5).toFixed(3)}  p90 ${pct(drifts, 0.9).toFixed(3)}  worst ${Math.max(...drifts).toFixed(3)}`);
  console.log(`  documents drifting >=0.10 on any question: ${drifts.filter((d) => d >= 0.1).length} of ${drifts.length}`);
}

// 5. The traps that defeated Orion's regexes. Each string is a real failure documented in
// prefilter.mjs or run.mjs. A model that falls for the same ones is no upgrade.
if (run(5)) {
  console.log('\n=== 5. the documented regex traps ===');
  const cases = [
    ['EEO boilerplate naming part-time as a protected status',
      'We do not discriminate on the basis of religion or belief, disability or part-time / fixed-term work, or any other status protected by applicable law. This is a permanent full-time Analyst role.',
      'notft', false],
    ['company age, not a demand ("over 30 years of experience delivering")',
      'Beyondsoft is a provider with over 30 years of experience delivering digital transformation. We seek an Analyst with 1 year of relevant experience.',
      'years3', false],
    ['an 11-year company history beside a real 3-5 year ask',
      'Building on our 11-year history, we are hiring. Requirements: minimum 3-5+ years in operations.',
      'years3', true],
    ['candidate\'s own past internship, not this job\'s terms',
      'Prior related internship or co-op experience is valued. This is a full-time permanent position.',
      'notft', false],
    ['PR accepted beside the citizen word',
      'Must be a Singapore Citizen or Permanent Resident.',
      'citizen', false],
    ['citizens only',
      'Applicants must be Singaporean citizens.',
      'citizen', true],
    ['Mandarin as a plus, not a bar',
      'Mandarin is a plus but not required. English is the working language.',
      'chinese', false],
    ['org unit in the title, the seat is an Analyst',
      'Analyst, Nostro Reconciliation Specialist, Group Ops COO. You will support reconciliation.',
      'senior', false],
  ];
  const qs = {
    citizen: { type: 'noul', instructions: 'This role is open only to citizens, excluding permanent residents' },
    chinese: { type: 'noul', instructions: 'This role requires fluent or professional-level Mandarin or Chinese' },
    years3: { type: 'noul', instructions: 'This job description requires at least three years of prior work experience' },
    notft: { type: 'noul', instructions: 'This posting is for an internship, part-time, casual or seasonal position rather than full-time employment' },
    senior: { type: 'noul', instructions: 'This is a manager, head, director or C-suite seat' },
  };
  let right = 0;
  for (const [label, text, k, want] of cases) {
    const r = await timed(text, qs);
    const got = r.answers[k].noul;
    const ok = (got >= 0.5) === want;
    if (ok) right++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${k.padEnd(8)} ${got.toFixed(2)} (want ${want ? 'yes' : 'no'})  ${label}`);
  }
  console.log(`  ${right}/${cases.length} traps handled`);
}

// 6. What does it do with nothing? A model that answers an empty state confidently is dangerous in
// a sweep, because a failed fetch becomes a confident tag rather than a gap.
if (run(6)) {
  console.log('\n=== 6. empty and junk states ===');
  const qs = nouls(6);
  for (const [label, state] of [['empty string', ''], ['whitespace', '   \n\t  '],
    ['unrelated prose', 'The cat sat on the mat. It was a Tuesday in November and the rain had not stopped.'],
    ['random bytes', Array.from({ length: 400 }, () => String.fromCharCode(33 + Math.floor(Math.random() * 90))).join('')]]) {
    try {
      const r = await timed(state, qs);
      const vals = Object.values(r.answers).map((a) => a.noul);
      console.log(`  ${label.padEnd(16)} mean ${mean(vals).toFixed(2)}  max ${Math.max(...vals).toFixed(2)}`
        + `  answers over 0.5: ${vals.filter((v) => v >= 0.5).length}/${vals.length}`);
    } catch (e) { console.log(`  ${label.padEnd(16)} REFUSED: ${e.message.slice(0, 90)}`); }
  }
  console.log('  (low means are the good outcome; a confident yes on an empty state would be a trap)');
}

// 7. Does confidence predict anything? If low confidence marks the rows where Jev and the regex
// disagree, it is usable for routing: act on the confident ones, read the rest. If it does not,
// it is decoration.
if (run(7)) {
  console.log('\n=== 7. is confidence a usable routing signal? ===');
  const sample = corpus.filter((_, i) => i % 23 === 0).slice(0, 220);
  const qs = { years3: { type: 'score', instructions: 'How many years of prior experience this posting demands',
    criteria: ['No figure stated at all', 'About one year', 'About two years', 'Three or more years'] } };
  // ponytail: absolute import into home's orion skill. orion is frozen with the job hunt, so a
  // cross-repo path is the whole fix. Upgrade path: copy prefilter.mjs and run.mjs in here.
  const { yearsAsked } = await import('file:///C:/Users/thelo/.claude/skills/orion/lib/run.mjs');
  const rows = await runPool(sample, async (r) => {
    const a = (await timed(body(r).slice(0, 14000), qs)).answers.years3;
    return { conf: a.confidence ?? 0, jev: a.score >= 2.5, rx: yearsAsked(r.jd_text) >= 3 };
  }, 6);
  const buckets = [[0, 0.6], [0.6, 0.8], [0.8, 0.95], [0.95, 1.01]];
  console.log('  confidence     n   agrees with regex');
  for (const [lo, hi] of buckets) {
    const b = rows.filter((r) => r.conf >= lo && r.conf < hi);
    if (!b.length) continue;
    const agree = b.filter((r) => r.jev === r.rx).length;
    console.log(`  ${lo.toFixed(2)}-${hi.toFixed(2)}  ${String(b.length).padStart(4)}   ${(agree / b.length * 100).toFixed(1)}%`);
  }
}

console.log(`\ntotal spend for this run: $${spend.toFixed(4)}`);
