#!/usr/bin/env node
// Sweep the LinkedIn JD cache and diff Jev against Orion's own regex gates.
//
// WHY THIS CORPUS. It is the only body here with a free mechanical baseline to disagree with.
// run.mjs already decides, in code, whether each JD demands 3+ years, bars non-citizens, demands
// fluent Chinese or asks for consulting/banking pedigree. Running the same four questions in
// English and diffing gives a measure of RECALL, which is otherwise unobtainable: every
// disagreement is a short list a human can actually read.
//
// It is also stale evidence. run.mjs says citizenBar was "validated over all 810 JDs in the
// LinkedIn detail cache, the pattern fires 3 times and every one is a real bar". The cache is now
// 5,379 JDs and it fires 10 times. Nobody has looked at the other 7.
//
// READ-ONLY, and it touches no network but Jev's. li_details.json is li_fetch.mjs's read-through
// sourcing cache; the slow part of sourcing is fetching UNSEEN ids from LinkedIn, not reading the
// file. `orion blast` reads docs/job-search/_blast.json and never opens this at all.
//
// Usage:
//   node jevjd.mjs --limit 150 --json probe.json     # probe before spending the full sweep
//   node jevjd.mjs --json jd-tags.json               # all of it, ~$0.20, ~5.5 min
//   node jevjd.mjs --selftest

import fs from 'node:fs';
import assert from 'node:assert';
import { askJev, runPool, noulsFrom, firedTags, toText, isNoul } from './lib.mjs';
import { TAGS, SCORES, CHOICES } from './questions.mjs';
// ponytail: absolute import into home's orion skill. orion is frozen with the job hunt, so a
// cross-repo path is the whole fix. Upgrade path: copy prefilter.mjs and run.mjs in here.
import { yearsAsked, pedigreeAsked, citizenBar, languageBar }
  from 'file:///C:/Users/thelo/.claude/skills/orion/lib/run.mjs';

const CACHE = 'C:/Users/thelo/job-search/cache/li_details.json';
const CONCURRENCY = 6;
const FIRES_AT = 0.5;
// ⚠ MEASURED 2026-09-22: the usable state tops out around 11,400 tokens (~58,800 chars of English),
// NOT the 32K the model is listed with. Past that the API refuses outright with
// `max_tokens_exceeded`, which is the good failure: nothing is silently truncated.
//
// This cap was 14,000 and that was a mistake. The corpus's longest JD is 24,296 chars, so 25,000
// truncates nothing at all, and the limits probe found head-truncation at 14k already losing a
// real years demand on 1 of the 4 JDs over 16k. Cutting a document you do not have to cut trades a
// silent recall loss for nothing: the cost is per token either way, and a JD that fits costs the
// same whether or not a cap exists.
const MAX_CHARS = 25000;


const IDS = Object.keys(TAGS);
const SCORE_IDS = Object.keys(SCORES);
const CHOICE_IDS = Object.keys(CHOICES);
const questions = {
  ...Object.fromEntries(IDS.map((id) => [id, { type: 'noul', instructions: TAGS[id] }])),
  ...Object.fromEntries(SCORE_IDS.map((id) => [id, { type: 'score', ...SCORES[id] }])),
  ...Object.fromEntries(CHOICE_IDS.map((id) => [id, { type: 'choice', ...CHOICES[id] }])),
};

export function stateFor(r) {
  const body = toText(r.jd_text).slice(0, MAX_CHARS);
  return `Employer: ${r.company ?? ''}\nRole title: ${r.title ?? ''}\nLocation: ${r.location ?? ''}\n\n${body}`;
}

// Orion's own verdicts on the same JD, so the diff is against the real functions rather than a
// reimplementation of them. yearsAsked's threshold is 3 per brief.md as corrected 2026-08-05.
export function regexVerdict(r) {
  const t = r.jd_text ?? '';
  return {
    demands_3plus_years: yearsAsked(t) >= 3,
    requires_citizenship: Boolean(citizenBar(t)),
    requires_chinese_fluency: Boolean(languageBar(t)),
    demands_elite_pedigree: Boolean(pedigreeAsked(t)),
  };
}
const COMPARABLE = ['demands_3plus_years', 'requires_citizenship', 'requires_chinese_fluency', 'demands_elite_pedigree'];

// One retry on a transient failure. At ~4,900 calls a 0.1% blip is five lost rows, and losing them
// silently would bias every rate reported below. A second failure is recorded, never hidden.
async function askWithRetry(state, key) {
  try {
    return await askJev(state, questions, key);
  } catch (e) {
    if (/HTTP (429|5\d\d)/.test(e.message)) {
      await new Promise((r) => setTimeout(r, 1500));
      return askJev(state, questions, key);
    }
    throw e;
  }
}

// Scores and choices do not reduce to a noul, so they are kept in their own shape. A score is
// normalised over GAPS, not levels: the top of a four-level rubric is index 3, so divide by 3.
// Dividing by the level count silently caps every axis at 0.75 and raises no error.
export function extras(answers) {
  const out = {};
  for (const id of SCORE_IDS) {
    const a = answers?.[id];
    // A score is a position on the criteria index, 0 to length - 1, so NaN or anything outside
    // that is no answer rather than a level. `typeof === 'number'` let both through.
    const top = SCORES[id].criteria.length - 1;
    out[id] = (a && Number.isFinite(a.score) && a.score >= 0 && a.score <= top)
      ? { level: Math.round(a.score * 100) / 100,
          norm: Math.round(a.score / top * 100) / 100,
          confidence: isNoul(a.confidence) ? a.confidence : null }
      : null;
  }
  for (const id of CHOICE_IDS) {
    const a = answers?.[id];
    out[id] = (a && typeof a.choice === 'string')
      ? { choice: a.choice, confidence: a.confidence ?? null } : null;
  }
  return out;
}

function report(rows, elapsedMs) {
  const ok = rows.filter((r) => r.tags);
  const failed = rows.filter((r) => r.error);

  console.log(`\n  ${'tag'.padEnd(28)} fires   rate`);
  for (const id of IDS) {
    const n = ok.filter((r) => r.tags[id] !== null && r.tags[id] >= FIRES_AT).length;
    const rate = n / ok.length;
    // Flag the two failure modes the email sweep taught: a tag that fires on nearly everything
    // cannot filter, and one that never fires is either wrong or asking about nothing.
    const flag = rate > 0.85 ? '  <- near-constant, filters nothing'
      : rate < 0.005 ? '  <- never fires, check the wording' : '';
    console.log(`  ${id.padEnd(28)}${String(n).padStart(5)}  ${(rate * 100).toFixed(1)}%${flag}`);
  }

  for (const id of SCORE_IDS) {
    const vs = ok.map((r) => r.extras?.[id]?.norm).filter((v) => typeof v === 'number').sort((a, b) => a - b);
    if (vs.length) {
      console.log(`  ${id.padEnd(28)}        median ${vs[Math.floor(vs.length / 2)].toFixed(2)}`
        + `  top decile ${vs[Math.floor(vs.length * 0.9)].toFixed(2)}`);
    }
  }
  for (const id of CHOICE_IDS) {
    const counts = {};
    for (const r of ok) { const c = r.extras?.[id]?.choice; if (c) counts[c] = (counts[c] ?? 0) + 1; }
    console.log(`  ${id.padEnd(28)}        `
      + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
  }

  // The diff. Agreement is uninteresting; the two disagreement columns are the whole point.
  console.log(`\n  ${'gate'.padEnd(28)} regex   jev  both  regex-only  jev-only`);
  for (const id of COMPARABLE) {
    let rx = 0; let jv = 0; let both = 0; let rOnly = 0; let jOnly = 0;
    for (const r of ok) {
      const a = r.regex[id];
      const b = r.tags[id] !== null && r.tags[id] >= FIRES_AT;
      if (a) rx++;
      if (b) jv++;
      if (a && b) both++;
      else if (a) rOnly++;
      else if (b) jOnly++;
    }
    console.log(`  ${id.padEnd(28)}${String(rx).padStart(5)} ${String(jv).padStart(5)} ${String(both).padStart(5)}`
      + `  ${String(rOnly).padStart(10)}  ${String(jOnly).padStart(8)}`);
  }

  const cost = ok.reduce((s, r) => s + (r.cost ?? 0), 0);
  const secs = elapsedMs / 1000;
  console.log(`\n  swept           ${ok.length} JDs`);
  console.log(`  failed          ${failed.length}`);
  console.log(`  wall clock      ${secs.toFixed(0)}s  (${(ok.length / secs).toFixed(1)} JDs/sec at concurrency ${CONCURRENCY})`);
  console.log(`  cost            $${cost.toFixed(4)}  ($${(cost / ok.length * 1000).toFixed(3)} per 1,000 JDs)`);
  if (failed.length) for (const f of failed.slice(0, 5)) console.log(`    ${String(f.title).slice(0, 44)}: ${f.error}`);
}

export function selftest() {
  assert.deepStrictEqual(Object.keys(noulsFrom({}, IDS)), IDS, 'every tag present even on an empty answer set');
  assert.strictEqual(noulsFrom({}, IDS).is_mlm_or_direct_sales, null);
  assert.strictEqual(noulsFrom({ demands_3plus_years: { noul: 0.874 } }, IDS).demands_3plus_years, 0.87);
  // ⚠ NaN IS A NUMBER. A shape-only guard let it through, it serialised to null and failed every
  // comparison, so a nonsense answer read as "did not fire". Out of range is broken the same way.
  for (const bad of [NaN, Infinity, 1.5, -0.1, '0.9']) {
    assert.strictEqual(noulsFrom({ demands_3plus_years: { noul: bad } }, IDS).demands_3plus_years, null,
      `noul ${bad} is no answer, never a value`);
  }
  assert.strictEqual(noulsFrom({ demands_3plus_years: { noul: 0 } }, IDS).demands_3plus_years, 0, 'and 0 is a real answer');
  assert.strictEqual(noulsFrom({ demands_3plus_years: { noul: 1 } }, IDS).demands_3plus_years, 1, 'and so is 1');
  assert.deepStrictEqual(firedTags({ a: 0.5, b: 0.49, c: null }).map(([k]) => k), ['a']);
  // Every comparable tag must exist as a question, or the diff silently compares against nothing.
  for (const id of COMPARABLE) assert.ok(TAGS[id], `${id} has no question`);
  // No id may appear in two primitive groups: the answer map is keyed by id, so a collision means
  // one question silently overwrites the other and a whole field goes missing from the sweep.
  const all = [...IDS, ...SCORE_IDS, ...CHOICE_IDS];
  assert.strictEqual(new Set(all).size, all.length, 'duplicate question id across nouls/scores/choices');
  assert.strictEqual(Object.keys(questions).length, all.length);
  // A score normalises over gaps, not levels: the top of a 4-level rubric is 1.0, not 0.75.
  assert.strictEqual(extras({ archetype_fit: { score: 3 } }).archetype_fit.norm, 1);
  assert.strictEqual(extras({ marketing_adjacency: { score: 1 } }).marketing_adjacency.norm, 0.5);
  // A fractional level is normal, not an error.
  assert.strictEqual(extras({ archetype_fit: { score: 1.5 } }).archetype_fit.norm, 0.5);
  // Missing score and choice answers are null, never a default that reads as a real answer.
  assert.strictEqual(extras({}).archetype_fit, null);
  // A score outside the criteria index, or NaN, is no answer. archetype_fit has four levels, 0 to 3.
  for (const bad of [NaN, 3.5, -1]) {
    assert.strictEqual(extras({ archetype_fit: { score: bad } }).archetype_fit, null, `score ${bad} is no answer`);
  }
  assert.strictEqual(extras({ archetype_fit: { score: 2, confidence: NaN } }).archetype_fit.confidence, null,
    'a NaN confidence is recorded as none');
  assert.strictEqual(extras({}).work_arrangement, null);
  assert.strictEqual(extras({ work_arrangement: { choice: 'hybrid' } }).work_arrangement.choice, 'hybrid');
  // The state is truncated to the head, and the header survives truncation: a JD longer than the
  // cap must still tell Jev the employer and title, which is where the band and archetype live.
  const long = { company: 'Acme', title: 'Analyst', location: 'SG', jd_text: 'x'.repeat(40000) };
  const s = stateFor(long);
  assert.ok(s.length < MAX_CHARS + 200);
  assert.ok(s.startsWith('Employer: Acme'));
  assert.ok(s.includes('Role title: Analyst'));
  // Markup in a JD body is cleaned before it becomes state.
  assert.ok(!stateFor({ jd_text: '<p>Hello</p>' }).includes('<p>'));
  // regexVerdict must tolerate a row with no text rather than throwing mid-sweep.
  assert.deepStrictEqual(regexVerdict({}), { demands_3plus_years: false, requires_citizenship: false,
    requires_chinese_fluency: false, demands_elite_pedigree: false });
  // ...and must actually fire on a real demand, or the whole baseline is silently all-false.
  assert.strictEqual(regexVerdict({ jd_text: 'We need at least 5 years of experience.' }).demands_3plus_years, true);
  assert.strictEqual(regexVerdict({ jd_text: 'Applicants must be Singaporean citizens.' }).requires_citizenship, true);
  return 'jevjd selftest OK';
}

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : argv[i + 1]; };

if (flag('selftest')) { console.log(selftest()); process.exit(0); }

// ⚠ THE >200 FILTER IS LOAD-BEARING, not tidiness. Measured 2026-09-22: given an EMPTY state Jev
// returns a mean noul of 0.48 with 3 of 6 questions over 0.5, and whitespace gives 0.39. It does
// not answer "no" to a question about nothing, it answers from a prior. Unrelated prose correctly
// scores 0.04, so this is specifically an empty-input failure. A failed JD fetch would therefore
// become a set of confident tags rather than a visible gap. Never sweep an empty state.
const all = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const usable = (Array.isArray(all) ? all : Object.values(all))
  .filter((r) => r && String(r.jd_text ?? '').length > 200);
const subset = usable.slice(0, Number(opt('limit')) || usable.length);

const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('OPENROUTER_API_KEY not set; see docs/runbooks/secret-courier.md'); process.exit(1); }

console.log(selftest());
console.log(`sweeping ${subset.length} of ${usable.length} usable JDs, ${CONCURRENCY} at a time`);
const t0 = Date.now();
let last = 0;
const rows = await runPool(subset, async (r) => {
  try {
    const { answers, cost } = await askWithRetry(stateFor(r), key);
    return { title: r.title, company: r.company, jd_url: r.jd_url,
      tags: noulsFrom(answers, IDS), extras: extras(answers), regex: regexVerdict(r), cost };
  } catch (e) {
    return { title: r.title, company: r.company, jd_url: r.jd_url, tags: null, error: e.message };
  }
}, CONCURRENCY, (done, total) => {
  if (done - last >= 250 || done === total) { console.error(`  ${done}/${total}`); last = done; }
});
report(rows, Date.now() - t0);

if (opt('json')) {
  fs.writeFileSync(opt('json'), JSON.stringify(rows.map(({ cost, ...r }) => r), null, 2));
  console.log(`\nraw answers written to ${opt('json')}`);
}
