#!/usr/bin/env node
// Does Noul `criteria` close the MLM gap?
//
// The titles sweep lost to the regex on MLM: 71 genuine direct-sales rows the regex caught and Jev
// missed, scored 0.27-0.45, against 12 the other way that were mostly false positives on real
// employers. The question asked was a bare statement with no definition of what a direct-sales
// outfit looks like, and `criteria` exists to supply exactly that. It went unused all day.
//
// Three variants of the SAME question, against the same rows:
//   bare      what the sweep used
//   defined   criteria naming what yes and no mean
//   coached   criteria that also hand over the employer-level knowledge the regex encodes
//             (emoji in the title, "Org"/"Ventures"/"Marketing Group" names, entry-level marketing
//             with no product, weekly pay, post-NS pitches)
//
// Measured on the regex's 167 positives (recall) AND a control of non-MLM rows from the same pool
// (false-positive rate), because a variant that tags everything would look like a win on recall
// alone. That is the mistake `feedback_mutation_runs_need_a_control` exists to prevent.

import fs from 'node:fs';
import assert from 'node:assert';
import { askJev, runPool } from './lib.mjs';
// ponytail: absolute import into home's orion skill. orion is frozen with the job hunt, so a
// cross-repo path is the whole fix. Upgrade path: copy prefilter.mjs and run.mjs in here.
import { isMlm, titleForRules } from 'file:///C:/Users/thelo/.claude/skills/orion/lib/prefilter.mjs';

const CACHE = 'C:/Users/thelo/job-search/cache/ats_sweep_2026-08-13.json';
const CONCURRENCY = 12;
const CONTROL_N = 400;

const Q = 'Taken together, this employer name and job title are typical of a multi-level marketing, '
  + 'network marketing or door-to-door direct sales operation rather than a salaried role';

const VARIANTS = {
  bare: { type: 'noul', instructions: Q },
  defined: {
    type: 'noul',
    instructions: Q,
    criteria: {
      true: 'A recruitment-driven sales operation: the "job" is selling or signing up customers '
        + 'face to face, pay depends on volume, the employer is a small unbranded outfit, and the '
        + 'posting sells the lifestyle rather than the work',
      false: 'A salaried position at a business that sells an identifiable product or service, where '
        + 'the posting describes duties, a team and a function',
    },
  },
  coached: {
    type: 'noul',
    instructions: Q,
    criteria: {
      true: 'A recruitment-driven direct-sales operation. Strong tells, any one of which is enough: '
        + 'an emoji or hashtag in the job title; an employer name built from generic words like '
        + 'Org, Organization, Ventures, Holdings, Marketing Group or Marketing Solutions with no '
        + 'identifiable product; an entry-level "marketing" or "brand ambassador" title at a firm '
        + 'that markets nothing in particular; urgency or scarcity language such as URGENT, '
        + 'limited slots or immediate start; pitches aimed at fresh graduates or the recently '
        + 'discharged from national service; promises of fast promotion, travel, weekly pay or '
        + 'uncapped earnings in place of a described job',
      false: 'A salaried role at a business with an identifiable product or service, including real '
        + 'sales and marketing jobs at such businesses. A recognisable company name, a specific '
        + 'function, or a named product or platform all point here.',
    },
  },
};

export function selftest() {
  // All three variants must ask the IDENTICAL question, or this measures wording and not criteria.
  for (const v of Object.values(VARIANTS)) assert.strictEqual(v.instructions, Q);
  assert.strictEqual(VARIANTS.bare.criteria, undefined, 'the control variant must carry no criteria');
  for (const k of ['defined', 'coached']) {
    // ⚠ The keys are `true`/`false`, NOT `yes`/`no`. Using yes/no returns HTTP 400
    // invalid_union and every call in the run fails, which is how this was found.
    assert.ok(VARIANTS[k].criteria.true && VARIANTS[k].criteria.false, `${k} needs both poles`);
  }
  return 'exp-criteria selftest OK';
}
if (process.argv.includes('--selftest')) { console.log(selftest()); process.exit(0); }

const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }

const raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const rows = (Array.isArray(raw) ? raw : Object.values(raw).find((v) => Array.isArray(v)))
  .filter((r) => r && String(r.title ?? '').trim().length > 3);

const positives = rows.filter((r) => isMlm(String(r.title ?? ''), String(r.company ?? '')));
// Control: evenly sampled non-MLM rows, so the false-positive rate is measured on the same pool
// rather than on hand-picked easy negatives.
const negativesAll = rows.filter((r) => !isMlm(String(r.title ?? ''), String(r.company ?? '')));
const step = Math.floor(negativesAll.length / CONTROL_N);
const negatives = negativesAll.filter((_, i) => i % step === 0).slice(0, CONTROL_N);

console.log(selftest());
console.log(`regex positives ${positives.length}, control negatives ${negatives.length}`);

const state = (r) => `Employer: ${r.company ?? ''}\nJob title: ${titleForRules(r)}`;
// One call per row carrying ALL THREE variants, so every variant sees a byte-identical state and
// the comparison cannot drift. This is what "questions are free" buys.
const questions = Object.fromEntries(Object.entries(VARIANTS).map(([k, v]) => [k, v]));

const all = [...positives.map((r) => ({ r, truth: true })), ...negatives.map((r) => ({ r, truth: false }))];
let last = 0;
const out = await runPool(all, async ({ r, truth }) => {
  try {
    const { answers, cost } = await askJev(state(r), questions, key);
    return { company: r.company, title: r.title, truth, cost,
      v: Object.fromEntries(Object.keys(VARIANTS).map((k) => [k, answers[k]?.noul ?? null])) };
  } catch (e) { return { company: r.company, title: r.title, truth, error: e.message }; }
}, CONCURRENCY, (d, t) => { if (d - last >= 150 || d === t) { console.error(`  ${d}/${t}`); last = d; } });

const ok = out.filter((r) => r.v);
const pos = ok.filter((r) => r.truth);
const neg = ok.filter((r) => !r.truth);
console.log(`\nscored ${ok.length} (${pos.length} regex-MLM, ${neg.length} control), `
  + `failed ${out.filter((r) => r.error).length}, cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(4)}`);

for (const thr of [0.35, 0.5]) {
  console.log(`\n  at threshold ${thr}`);
  console.log(`  variant    recall on regex-MLM   false positives on control   mean(MLM)  mean(control)`);
  for (const k of Object.keys(VARIANTS)) {
    const hit = pos.filter((r) => r.v[k] !== null && r.v[k] >= thr).length;
    const fp = neg.filter((r) => r.v[k] !== null && r.v[k] >= thr).length;
    const mp = pos.reduce((s, r) => s + (r.v[k] ?? 0), 0) / pos.length;
    const mn = neg.reduce((s, r) => s + (r.v[k] ?? 0), 0) / neg.length;
    console.log(`  ${k.padEnd(10)} ${String(hit).padStart(4)}/${pos.length} `
      + `(${(hit / pos.length * 100).toFixed(0)}%)`.padEnd(12)
      + `${String(fp).padStart(8)}/${neg.length} (${(fp / neg.length * 100).toFixed(1)}%)`.padEnd(22)
      + `   ${mp.toFixed(3)}      ${mn.toFixed(3)}`);
  }
}

// Separation matters more than either rate on its own: a variant that lifts both equally has
// learned nothing, it has just become more agreeable.
console.log('\n  variant    separation (mean MLM minus mean control)');
for (const k of Object.keys(VARIANTS)) {
  const mp = pos.reduce((s, r) => s + (r.v[k] ?? 0), 0) / pos.length;
  const mn = neg.reduce((s, r) => s + (r.v[k] ?? 0), 0) / neg.length;
  console.log(`  ${k.padEnd(10)} ${(mp - mn).toFixed(3)}`);
}

const outPath = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify(out.map(({ cost, ...r }) => r), null, 2));
  console.log(`\nwritten to ${outPath}`);
}
