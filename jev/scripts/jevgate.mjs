#!/usr/bin/env node
// The MLM gate, as a reusable step for the sourcing path.
//
// WHY THIS EXISTS. prefilter.mjs's `isMlm` matches an emoji, a phrase list and a list of employer
// names, and its own comment concedes the name list "is inherently a treadmill — these outfits
// rebrand — so it is here for the volume it removes today, not as a permanent solution". This is
// the permanent half: a judgement that generalises to employers no list contains.
//
// MEASURED 2026-09-22 against the regex's 167 positives and a 400-row control from the same pool:
//
//   bare question (no criteria)        105/167  63%   1/400 false positives
//   criteria defining the poles        134/167  80%   3/400
//   criteria that also list the tells  165/167  99%   2/400      <- what is used here
//
// ⚠ THIS DOES NOT REPLACE `isMlm`, IT UNIONS WITH IT. The regex still sees what no per-row
// judgement can: one employer posting 47 near-identical rows. Keep both, and treat a hit from
// either as a candidate. Removing the regex would trade a cross-item signal for nothing.
//
//   node jevgate.mjs --pool <run.json> --stamp        <- stage 2.6, writes mlmNoul onto the run
//   node jevgate.mjs --pool <ats_sweep.json> [--out flags.json] [--threshold 0.5]
//   node jevgate.mjs --selftest

import fs from 'node:fs';
import assert from 'node:assert';
import { askJev, runPool, readKey, isNoul } from './lib.mjs';
import { MLM_QUESTION } from './questions.mjs';
// ponytail: absolute import into home's orion skill. orion is frozen with the job hunt, so a
// cross-repo path is the whole fix. Upgrade path: copy prefilter.mjs and run.mjs in here.
import { isMlm, titleForRules } from 'file:///C:/Users/thelo/.claude/skills/orion/lib/prefilter.mjs';

const CONCURRENCY = 12;
// 0.5 was measured at 99% recall / 0.5% false positives. Lowering it to 0.35 bought nothing on the
// coached variant (166 vs 165) while raising false positives, so the default stays where the
// evidence is.
const DEFAULT_THRESHOLD = 0.5;

export const stateFor = (r) => `Employer: ${r.company ?? ''}\nJob title: ${titleForRules(r)}`;

// The whole point of the gate: a row is a candidate if EITHER signal fires. `by` records which,
// because a jev-only hit is a new employer the name list has never seen and is worth reading.
export function verdict(row, noul, threshold = DEFAULT_THRESHOLD) {
  const rx = isMlm(String(row.title ?? ''), String(row.company ?? ''));
  // An invalid noul (NaN, out of range) is no answer, never a cleared one. Kept as null so the
  // stamp below skips it rather than writing NaN, which JSON would serialise as null anyway.
  const n = isNoul(noul) ? noul : null;
  const jv = n !== null && n >= threshold;
  return { flagged: rx || jv, by: rx && jv ? 'both' : rx ? 'regex' : jv ? 'jev' : null, noul: n };
}

export async function flagPool(rows, key, { threshold = DEFAULT_THRESHOLD, onDone } = {}) {
  return runPool(rows, async (r) => {
    try {
      const { answers, cost } = await askJev(stateFor(r), { mlm: MLM_QUESTION }, key);
      // `id` rides along so --stamp can write the number back onto the right row. Without it the
      // only join available is company+title, which is not unique in a pool that deliberately keeps
      // near-identical rows from one employer.
      return { id: r.id, ...verdict(r, answers.mlm?.noul, threshold), company: r.company, title: r.title, cost };
    } catch (e) {
      // A failed call must NOT silently become "not MLM". Fall back to the regex alone and say so.
      // It also carries no noul, so --stamp writes nothing and bucketPool falls back to the regex.
      return { id: r.id, ...verdict(r, null, threshold), company: r.company, title: r.title, error: e.message };
    }
  }, CONCURRENCY, onDone);
}

// --- --stamp: the number goes back onto the run, the decision does not ---
//
// The gate writes `mlmNoul` and nothing else. bucketPool compares it against MLM_NOUL_SCREEN in
// config.mjs, so the threshold can move and apply to a run already in flight, which is the rule
// prefilter.mjs's own header states: buckets are derived on demand and never stored. A `flagged`
// boolean written here would freeze the threshold at whatever it was the day the sweep ran.
//
// Rows whose call FAILED carry no noul and are deliberately left untouched rather than stamped
// with a zero. An absent stamp reads as "the judgement did not fire", and bucketPool falls back to
// the regex alone. A zero would read as "judged, and clean", which is a different claim entirely
// and one no call was made to support.
//
// Pure, so the write is tested without spending a call. Returns the new pool plus a count, and
// never mutates its input: the caller writes the file, this decides what goes in it.
export function stampPool(pool, results) {
  const byId = new Map(results.filter((r) => isNoul(r.noul)).map((r) => [r.id, r.noul]));
  let stamped = 0;
  const next = pool.map((row) => {
    if (!byId.has(row?.id)) return row;
    stamped++;
    return { ...row, mlmNoul: byId.get(row.id) };
  });
  return { pool: next, stamped };
}

export function selftest() {
  assert.ok(MLM_QUESTION.criteria.true && MLM_QUESTION.criteria.false, 'coached criteria required');
  assert.strictEqual(MLM_QUESTION.type, 'noul');
  // Either signal flags. This is the union the header argues for.
  const mlmRow = { company: 'ROYAL ORG PTE. LTD.', title: 'Entry Level Marketing Associate' };
  const cleanRow = { company: 'Keppel', title: 'Analyst, Investment' };
  assert.strictEqual(verdict(mlmRow, 0.01).flagged, true, 'regex alone still flags');
  assert.strictEqual(verdict(mlmRow, 0.01).by, 'regex');
  assert.strictEqual(verdict(cleanRow, 0.99).flagged, true, 'jev alone still flags');
  assert.strictEqual(verdict(cleanRow, 0.99).by, 'jev');
  assert.strictEqual(verdict(mlmRow, 0.99).by, 'both');
  assert.strictEqual(verdict(cleanRow, 0.10).flagged, false);
  // ⚠ A failed call must fall back to the regex, never to "clean".
  assert.strictEqual(verdict(mlmRow, null).flagged, true, 'a null noul must not clear a regex hit');
  assert.strictEqual(verdict(cleanRow, null).flagged, false);
  // An invalid noul is no answer, the same as a failed call: it neither flags on its own nor
  // clears a regex hit, and it is recorded as null rather than as the broken number.
  for (const bad of [NaN, 1.5, -0.1]) {
    assert.deepStrictEqual(verdict(cleanRow, bad), { flagged: false, by: null, noul: null }, `noul ${bad} is no answer`);
    assert.strictEqual(verdict(mlmRow, bad).flagged, true, `noul ${bad} must not clear a regex hit`);
  }
  // The threshold is inclusive at the boundary.
  assert.strictEqual(verdict(cleanRow, 0.5).flagged, true);
  assert.strictEqual(verdict(cleanRow, 0.49).flagged, false);
  // The state carries the employer, which is where most of the signal lives.
  assert.ok(stateFor(mlmRow).includes('ROYAL ORG'));

  // --- stamping ---
  const pool = [{ id: 1, title: 'A' }, { id: 2, title: 'B' }, { id: 3, title: 'C', mlmNoul: 0.1 }];
  const { pool: out, stamped } = stampPool(pool, [
    { id: 1, noul: 0.92 },
    { id: 2, noul: null, error: 'timeout' },
    { id: 3, noul: 0.77 },
  ]);
  assert.strictEqual(stamped, 2, 'only rows with a number are stamped');
  assert.strictEqual(out[0].mlmNoul, 0.92);
  // ⚠ A failed call leaves the row exactly as it was. Not zero: absent and zero are different
  // claims, and only one of them was earned by a call.
  assert.ok(!('mlmNoul' in out[1]), 'a failed call must not stamp anything, not even 0');
  assert.strictEqual(out[2].mlmNoul, 0.77, 'a re-run overwrites a previous stamp');
  // The input is untouched, so a failed write cannot leave a half-stamped pool in memory.
  assert.strictEqual(pool[0].mlmNoul, undefined, 'stampPool must not mutate its input');
  assert.strictEqual(pool[2].mlmNoul, 0.1);
  // Every other field survives, because this writes back over orion's live run file.
  assert.strictEqual(out[0].title, 'A');
  assert.strictEqual(out.length, pool.length, 'no row is added or lost');
  // A result for a row that is not in the pool is ignored rather than appended.
  assert.strictEqual(stampPool(pool, [{ id: 99, noul: 0.9 }]).stamped, 0);
  // A NaN would be written as a number and serialised as null over the live run file.
  assert.strictEqual(stampPool(pool, [{ id: 1, noul: NaN }, { id: 2, noul: 1.5 }]).stamped, 0, 'an invalid noul is never stamped');
  return 'jevgate selftest OK';
}

if (process.argv.includes('--selftest')) { console.log(selftest()); process.exit(0); }

const opt = (n) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? null : process.argv[i + 1]; };
const key = readKey();
if (!key) { console.error('no OPENROUTER_API_KEY in the environment and none in ~/.jev.env'); process.exit(1); }
const poolPath = opt('pool');
if (!poolPath) { console.error('--pool <file.json> required'); process.exit(1); }

const raw = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
const rows = (Array.isArray(raw) ? raw : (raw.pool ?? Object.values(raw).find((v) => Array.isArray(v))))
  .filter((r) => r && String(r.title ?? '').trim().length > 3);

console.log(selftest());
console.log(`gating ${rows.length} rows at threshold ${Number(opt('threshold')) || DEFAULT_THRESHOLD}`);
let last = 0;
const out = await flagPool(rows, key, {
  threshold: Number(opt('threshold')) || DEFAULT_THRESHOLD,
  onDone: (d, t) => { if (d - last >= 500 || d === t) { console.error(`  ${d}/${t}`); last = d; } },
});

const flagged = out.filter((r) => r.flagged);
const by = { regex: 0, jev: 0, both: 0 };
for (const r of flagged) by[r.by]++;
console.log(`\n  flagged        ${flagged.length} of ${out.length}`);
console.log(`    regex only   ${by.regex}`);
console.log(`    jev only     ${by.jev}   <- employers the name list has never seen`);
console.log(`    both         ${by.both}`);
console.log(`  failed calls   ${out.filter((r) => r.error).length} (fell back to the regex)`);
console.log(`  cost           $${out.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(4)}`);

console.log('\n  new employers flagged by jev alone:');
const seen = new Set();
for (const r of flagged.filter((r) => r.by === 'jev').sort((a, b) => b.noul - a.noul)) {
  if (seen.has(r.company)) continue;
  seen.add(r.company);
  if (seen.size > 15) break;
  console.log(`  ${r.noul.toFixed(2)}  ${String(r.company).slice(0, 32).padEnd(32)} ${String(r.title).slice(0, 40)}`);
}

if (opt('out')) {
  fs.writeFileSync(opt('out'), JSON.stringify(out.map(({ cost, ...r }) => r), null, 2));
  console.log(`\nwritten to ${opt('out')}`);
}

// --stamp writes the nouls back into the pool file this read, which for a real run is orion's live
// state. Guarded rather than trusting: only a file with a `pool` array is stamped, because the
// script also accepts a bare array export and a bare array has no run to put back.
// Written to a temp file and renamed, so a crash mid-write leaves the run intact rather than
// truncated. A truncated run file is the one failure orion cannot recover from on its own.
if (process.argv.includes('--stamp')) {
  if (!Array.isArray(raw?.pool)) {
    console.error('--stamp needs a run file with a `pool` array; got a bare array or another shape');
    process.exit(1);
  }
  const { pool, stamped } = stampPool(raw.pool, out);
  const tmp = `${poolPath}.stamping`;
  fs.writeFileSync(tmp, JSON.stringify({ ...raw, pool }, null, 2));
  fs.renameSync(tmp, poolPath);
  console.log(`\nstamped mlmNoul on ${stamped} of ${raw.pool.length} rows in ${poolPath}`);
  console.log('bucketPool screens these at MLM_NOUL_SCREEN; nothing is rejected until it runs.');
}
