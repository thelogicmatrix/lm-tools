#!/usr/bin/env node
// Does Jev's ranking track Nathan's? That is the whole question this script answers, and it is
// meant to be thrown away once answered.
//
// The evaluation set is 52 roles that carry BOTH a hand score (docs/job-search/_orion.json, the
// board) and full JD text (docs/job-search/_jds.json), joined on `board:<slug>`. Each one gets six
// atomic questions in ONE Jev call, and this file's own coefficients turn the six answers into a
// 0-10 that is compared against the score Nathan gave it.
//
// ⚠ THE SET IS RANGE-TRUNCATED, and a good correlation is therefore weaker evidence than it looks.
// The board only keeps rows that cleared the apply floor of 5, so the histogram is 4:1 5:3 6:1 7:9
// 8:22 9:16. This measures agreement on ORDERING among rows already known to be decent. It cannot
// show that Jev rejects a bad row, because there are almost no bad rows left to reject. The 2s and
// 3s live in docs/job-search/runs/*.md with no stored JD text, so testing that half needs a re-fetch.
//
// Usage:
//   node calibrate.mjs --dry            print one payload, call nothing
//   node calibrate.mjs                  run the whole set
//   node calibrate.mjs --limit 5        run the first five
//   node calibrate.mjs --selftest       check the maths, call nothing
//
// The key comes from OPENROUTER_API_KEY in the environment. Vault item proj/jev. Pass it with
// --env-file, never -e, and never let it reach a transcript.

import fs from 'node:fs';
import assert from 'node:assert';
import path from 'node:path';

const ENDPOINT = 'https://openrouter.ai/api/v1/systemone';
const MODEL = 'jev-latest';
const CONCURRENCY = 6;
// ponytail: absolute path into home's job-search data, which stayed in home when this moved.
const DOCS = 'C:/Users/thelo/docs/job-search';

// --- the rubric ------------------------------------------------------------------------------
// Six atomic questions. Jev's own guidance is that a question asking for extended reasoning or
// weighing independent factors should be decomposed, so "rate this role 0-10" is exactly the wrong
// shape and is what stage 4 does today.
//
// EVERY AXIS IS ORIENTED SO HIGHER IS BETTER. Score levels must be genuinely ordered for the
// primitive to mean anything, which is why band fit and developer depth are Nouls rather than
// Scores: seniority is not monotonic for Nathan (a Manager seat is worse than an Analyst one, but
// so is a warehouse-floor seat), and "how much developer depth" runs the wrong way.
const QUESTIONS = {
  years_headroom: {
    type: 'score',
    instructions: 'How few years of prior experience this job description demands of the applicant',
    criteria: [
      'Demands three or more years of experience',
      'Demands roughly two years of experience',
      'Demands roughly one year of experience',
      'States no years-of-experience requirement at all',
    ],
  },
  archetype_fit: {
    type: 'score',
    instructions: 'How central process improvement, operations, automation or internal tooling is to this role',
    criteria: [
      'No operations, process or automation content',
      'Incidental operations or tooling work alongside something else',
      'Operations or automation is a named part of the role',
      'The role is primarily process automation, internal tooling or digitalisation',
    ],
  },
  marketing_adjacency: {
    type: 'score',
    instructions: 'How central marketing, communications, campaigns or growth work is to this role',
    criteria: [
      'No marketing, communications or growth content',
      'Marketing sits adjacent to the role but is not its subject',
      'Marketing, communications or growth is the core of the role',
    ],
  },
  band_ok: {
    type: 'noul',
    instructions: 'The seat is at or below the executive, associate or analyst band, rather than a manager, lead, head or director seat',
  },
  not_dev_seat: {
    type: 'noul',
    instructions: 'The role can be performed without writing and maintaining production software as a primary duty',
  },
  ai_differentiator: {
    type: 'noul',
    instructions: 'AI or automation capability would distinguish a candidate for this role, rather than being a baseline requirement the candidate must already meet',
  },
};

// Change a number here when targeting shifts. That is the entire point of the exercise: the
// 2026-08-05 reversal (AI-weighted to marketing-weighted) becomes an edit to this object instead of
// a prompt rewrite. Must sum to 1.
const WEIGHTS = {
  years_headroom: 0.25,
  archetype_fit: 0.22,
  marketing_adjacency: 0.18,
  band_ok: 0.15,
  not_dev_seat: 0.12,
  ai_differentiator: 0.08,
};

// --- combining -------------------------------------------------------------------------------
// A score answer returns a position on the level index, which can land between levels (1.035), so
// normalise by the number of GAPS, not the number of levels. A noul is already 0-1.
export function normalise(name, answer) {
  const q = QUESTIONS[name];
  if (q.type === 'noul') return clamp01(answer.noul);
  const gaps = q.criteria.length - 1;
  return clamp01(answer.score / gaps);
}
const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));

export function combine(answers) {
  let total = 0;
  for (const [name, w] of Object.entries(WEIGHTS)) {
    const a = answers?.[name];
    // A missing answer scores 0 rather than being skipped: silently renormalising over the
    // questions that came back would make a partial response look like a confident low score.
    total += w * (a ? normalise(name, a) : 0);
  }
  return Math.round(total * 10 * 10) / 10;
}

// Mean of the per-question confidences Jev reports, over the questions that carry one (nouls do
// not). Used only to flag rows where the model itself was unsure, never to adjust the score.
export function meanConfidence(answers) {
  const cs = Object.values(answers ?? {}).map((a) => a?.confidence).filter((c) => typeof c === 'number');
  return cs.length ? cs.reduce((s, c) => s + c, 0) / cs.length : null;
}

// --- statistics ------------------------------------------------------------------------------
// Average ranks for ties, which matters here: 22 of 52 rows are hand-scored 8, so a tie-naive rank
// would invent an ordering Nathan never expressed and then measure agreement with it.
export function rank(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = avg;
    i = j + 1;
  }
  return out;
}

export function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export const spearman = (a, b) => pearson(rank(a), rank(b));

// --- the evaluation set ----------------------------------------------------------------------
export function evalSet() {
  const board = JSON.parse(fs.readFileSync(path.join(DOCS, '_orion.json'), 'utf8'));
  const jf = JSON.parse(fs.readFileSync(path.join(DOCS, '_jds.json'), 'utf8'));
  const byId = new Map(Object.values(jf.jds).map((e) => [e.id, e]));
  return board.roles
    .filter((r) => typeof r.score === 'number' && byId.has(`board:${r.slug}`))
    .map((r) => ({ slug: r.slug, company: r.company, role: r.role, hand: r.score,
      // WHEN the score was given, because the rubric behind it changed underneath this set.
      // Targeting reversed on 2026-08-05 (AI-weighted to marketing-weighted) and the years screen
      // went 5 to 3 the same day, so a 9 from July and a 9 from late August are not the same 9.
      appliedAt: r.appliedAt ?? null,
      text: byId.get(`board:${r.slug}`).text }));
}

// The state Jev judges. Title and employer go in with the body because the band and the archetype
// both live in the title, and prefilter.mjs's whole history is about titles carrying the signal.
const stateFor = (row) => `Employer: ${row.company}\nRole title: ${row.role}\n\n${row.text}`;

async function ask(row, key) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, state: stateFor(row), questions: QUESTIONS }),
  });
  if (!res.ok) throw new Error(`${row.slug}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return { answers: body.answers, cost: body.usage?.cost ?? null };
}

// Fixed-size worker pool. Not a dependency and not a queue library: six workers pulling from one
// cursor is the whole requirement.
async function pool(rows, key, onDone) {
  const out = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      try {
        const { answers, cost } = await ask(row, key);
        out.push({ ...row, jev: combine(answers), confidence: meanConfidence(answers), answers, cost });
      } catch (e) {
        out.push({ ...row, error: e.message });
      }
      onDone(out.length, rows.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  return out;
}

// --- report ----------------------------------------------------------------------------------
function report(results) {
  const ok = results.filter((r) => !r.error).sort((a, b) => b.jev - a.jev);
  const failed = results.filter((r) => r.error);
  if (failed.length) {
    console.log(`\n${failed.length} failed:`);
    for (const f of failed) console.log(`  ${f.slug}: ${f.error}`);
  }
  if (ok.length < 3) { console.log('\nToo few results to correlate.'); return; }

  const hand = ok.map((r) => r.hand);
  const jev = ok.map((r) => r.jev);
  const rho = spearman(hand, jev);
  const mae = ok.reduce((s, r) => s + Math.abs(r.hand - r.jev), 0) / ok.length;
  const cost = ok.reduce((s, r) => s + (r.cost ?? 0), 0);

  console.log(`\n  hand   jev   gap  conf  role`);
  for (const r of ok) {
    const gap = r.jev - r.hand;
    console.log(`  ${String(r.hand).padStart(4)}  ${r.jev.toFixed(1).padStart(4)}  `
      + `${(gap >= 0 ? '+' : '') + gap.toFixed(1)}`.padStart(5)
      + `  ${r.confidence === null ? '  - ' : r.confidence.toFixed(2)}`
      + `  ${r.company} — ${r.role}`.slice(0, 70));
  }

  console.log(`\n  rows scored        ${ok.length}`);
  console.log(`  Spearman rho       ${rho.toFixed(3)}`);
  console.log(`  mean abs error     ${mae.toFixed(2)} points`);
  console.log(`  cost               ${cost ? '$' + cost.toFixed(5) : 'not reported'}`);

  // The disagreements are the only part worth reading by hand. A high rho with a nonsense outlier
  // is a worse outcome than a middling rho with explicable ones.
  const worst = [...ok].sort((a, b) => Math.abs(b.jev - b.hand) - Math.abs(a.jev - a.hand)).slice(0, 5);
  console.log('\n  biggest disagreements:');
  for (const r of worst) {
    console.log(`  hand ${r.hand} / jev ${r.jev.toFixed(1)} — ${r.company}, ${r.role}`);
    for (const [name, a] of Object.entries(r.answers)) {
      const v = normalise(name, a);
      console.log(`      ${name.padEnd(20)} ${v.toFixed(2)}`
        + (a.type === 'score' ? ` (level ${Number(a.score).toFixed(2)})` : '')
        + (typeof a.confidence === 'number' ? ` conf ${a.confidence.toFixed(2)}` : ''));
    }
  }

  console.log('\n  ⚠ the set is range-truncated (hand scores 4-9, no 0-3). A strong rho here shows');
  console.log('    agreement on ordering among decent rows, not that Jev rejects a bad one.');
}

// --- self-check --------------------------------------------------------------------------------
export function selftest() {
  assert.strictEqual(Math.round(Object.values(WEIGHTS).reduce((s, w) => s + w, 0) * 1000) / 1000, 1,
    'weights must sum to 1, or the 0-10 output is not on a 0-10 scale');
  // Every weighted question must exist, or a coefficient silently weighs nothing.
  for (const name of Object.keys(WEIGHTS)) assert.ok(QUESTIONS[name], `no question named ${name}`);
  // A score normalises over GAPS, not levels: top level of a 4-level rubric is 1.0, not 0.75.
  assert.strictEqual(normalise('years_headroom', { type: 'score', score: 3 }), 1);
  assert.strictEqual(normalise('years_headroom', { type: 'score', score: 0 }), 0);
  assert.strictEqual(normalise('marketing_adjacency', { type: 'score', score: 1 }), 0.5);
  // A fractional level is the normal case, not an error.
  assert.ok(Math.abs(normalise('years_headroom', { type: 'score', score: 1.5 }) - 0.5) < 1e-9);
  assert.strictEqual(normalise('band_ok', { type: 'noul', noul: 0.42 }), 0.42);
  // All axes at their best is a 10, all at their worst a 0.
  const best = { years_headroom: { type: 'score', score: 3 }, archetype_fit: { type: 'score', score: 3 },
    marketing_adjacency: { type: 'score', score: 2 }, band_ok: { type: 'noul', noul: 1 },
    not_dev_seat: { type: 'noul', noul: 1 }, ai_differentiator: { type: 'noul', noul: 1 } };
  assert.strictEqual(combine(best), 10);
  assert.strictEqual(combine({}), 0, 'no answers must not renormalise into a middling score');
  // A missing answer costs exactly its own weight, it does not redistribute.
  const minusBand = { ...best }; delete minusBand.band_ok;
  assert.strictEqual(combine(minusBand), 8.5);
  // Ties take the average rank, which is the whole reason 22 rows scored 8 do not invent an order.
  assert.deepStrictEqual(rank([8, 8, 9]), [1.5, 1.5, 3]);
  assert.deepStrictEqual(rank([3, 1, 2]), [3, 1, 2]);
  assert.strictEqual(Math.round(spearman([1, 2, 3], [2, 4, 6]) * 1000) / 1000, 1);
  assert.strictEqual(Math.round(spearman([1, 2, 3], [6, 4, 2]) * 1000) / 1000, -1);
  // A flat series has no order to agree with; 0 rather than NaN.
  assert.strictEqual(spearman([5, 5, 5], [1, 2, 3]), 0);
  return 'jev-calibrate selftest OK';
}

// --- main --------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : argv[i + 1]; };

if (flag('selftest')) { console.log(selftest()); process.exit(0); }

const rows = evalSet();
const limit = Number(opt('limit')) || rows.length;
const subset = rows.slice(0, limit);

if (flag('dry')) {
  const r = subset[0];
  console.log(`eval set: ${rows.length} rows with a hand score and stored JD text`);
  const hist = {};
  for (const x of rows) hist[x.hand] = (hist[x.hand] ?? 0) + 1;
  console.log('hand-score histogram:', JSON.stringify(hist));
  console.log(`\nfirst row: ${r.company} — ${r.role} (hand ${r.hand}/10, ${r.text.length} chars)`);
  console.log('\npayload (state truncated for display):');
  console.log(JSON.stringify({ model: MODEL, state: stateFor(r).slice(0, 300) + ' …', questions: QUESTIONS }, null, 2));
  console.log(`\nPOST ${ENDPOINT}   Authorization: Bearer <OPENROUTER_API_KEY>`);
  process.exit(0);
}

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error('OPENROUTER_API_KEY is not set. Vault item proj/jev, field OPENROUTER_API_KEY.');
  console.error('Pass it with --env-file; do not put it on the command line.');
  process.exit(1);
}

console.log(selftest());
console.log(`scoring ${subset.length} roles against ${MODEL} via OpenRouter, ${CONCURRENCY} at a time`);
let last = 0;
const results = await pool(subset, key, (done, total) => {
  // Progress, because a silent run and a hung run look identical.
  if (done - last >= 10 || done === total) { console.log(`  ${done}/${total}`); last = done; }
});
// Persist the raw answers BEFORE reporting. Re-asking Jev to try a different coefficient set is
// pure waste: the answers are the expensive part and the weighting is free arithmetic over them.
const out = opt('out');
if (out) {
  // Drop `text` — the JD bodies are already in _jds.json and would 4x this file for nothing.
  fs.writeFileSync(out, JSON.stringify(results.map(({ text, ...r }) => r), null, 2));
  console.log(`\nraw answers written to ${out}`);
}
report(results);
