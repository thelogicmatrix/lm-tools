#!/usr/bin/env node
// Escalate the answers Jev was unsure about to a full LLM, instead of to a person.
//
// WHY THIS WORKS. Confidence predicts correctness sharply: bucketed against Orion's yearsAsked
// regex over 220 JDs on 2026-09-22, Jev agreed 98.4% of the time at confidence 0.95+ but only
// 58-67% below 0.80. So the expensive model never has to see the 90% Jev is sure about, and the
// sweep stops needing a human in it at all.
//
// The economics only work because the escalated set is small. On the JD corpus roughly 5-10% of
// answers fall under the threshold, so a $0.25 Jev sweep plus a few hundred LLM calls still costs
// less than reading any of it yourself, and far less than sending the whole corpus to the LLM.
//
// ⚠ THE VERIFIER IS NOT GROUND TRUTH. It is a second opinion from a system with its own failure
// modes, and the drift measurement is the reason to distrust it: asked the same question twice,
// Jev moved at most 0.080 while headless Haiku moved 0.35 on "is the role customer facing". A
// disagreement means "read this one", never "the LLM was right".
//
// Usage:
//   node jevescalate.mjs --in jev_jd_tags.json --out verified.json
//   node jevescalate.mjs --in tags.json --below 0.9 --limit 50     # wider net, small probe
//   node jevescalate.mjs --selftest

import fs from 'node:fs';
import assert from 'node:assert';
import { runPool, isNoul, postText } from './lib.mjs';

const CHAT = 'https://openrouter.ai/api/v1/chat/completions';
// Cheap, fast and strong enough to arbitrate a yes/no about a document it is handed. Overridable
// because the right answer changes: check Artificial Analysis rather than trusting this default.
const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';
const CONCURRENCY = 4;
const DEFAULT_BELOW = 0.8;

// A tag's confidence, where the primitive reports one. Nouls do not, so a noul is escalated on its
// DISTANCE FROM 0.5 instead: 0.51 is a coin flip dressed as an answer, 0.98 is not. This is the
// only place the two primitives need different treatment and getting it wrong would either
// escalate everything or nothing.
// Invalid is treated as missing on both inputs: a NaN confidence gave NaN, which fails the
// escalation comparison and so never escalated, and a NaN value did the same.
export function uncertainty(value, confidence) {
  if (isNoul(confidence)) return 1 - confidence;
  if (!isNoul(value)) return 1;                     // missing or invalid is maximally uncertain
  return 1 - Math.abs(value - 0.5) * 2;             // 0.5 -> 1.0, 0 or 1 -> 0.0
}

// Which (row, tag) pairs are worth a second opinion. Returns pairs, not rows: a JD can be certain
// on nine tags and a coin flip on the tenth, and re-asking all ten would waste most of the spend.
export function toEscalate(rows, below) {
  const out = [];
  for (const [i, r] of rows.entries()) {
    if (!r.tags) continue;
    for (const [tag, value] of Object.entries(r.tags)) {
      const conf = r.extras?.[tag]?.confidence;
      if (uncertainty(value, conf) > 1 - below) out.push({ i, tag, value });
    }
  }
  return out;
}

const PROMPT = (title, company, question, body) =>
  `You are verifying a single yes/no classification of a job posting. Answer with ONLY a JSON `
  + `object: {"answer": true|false, "confidence": 0.0-1.0, "why": "<12 words max>"}. No prose, no `
  + `code fences.\n\nQUESTION: ${question}\n\nEMPLOYER: ${company}\nTITLE: ${title}\n\nPOSTING:\n${body}`;

async function askLLM(prompt, key, model) {
  const body = JSON.parse(await postText(CHAT, key, { model, max_tokens: 120, temperature: 0,
    messages: [{ role: 'user', content: prompt }] }));
  return { text: body.choices?.[0]?.message?.content ?? '', cost: body.usage?.cost ?? 0 };
}

// The verifier is a text model, so its output is a string that is usually but not always JSON.
// Parsing has to survive a code fence and leading prose, and must return null rather than a
// default when it cannot: a failed parse recorded as `false` is a silent wrong answer.
export function parseVerdict(text) {
  const s = String(text ?? '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (typeof o.answer !== 'boolean') return null;
    return { answer: o.answer,
      confidence: typeof o.confidence === 'number' ? o.confidence : null,
      why: String(o.why ?? '').slice(0, 80) };
  } catch { return null; }
}

export function selftest() {
  // A reported confidence is used directly.
  assert.strictEqual(uncertainty(0.9, 0.95), 0.050000000000000044);
  assert.strictEqual(uncertainty(0.9, 1), 0);
  // A noul with no confidence escalates on distance from 0.5, not on its value.
  assert.strictEqual(uncertainty(0.5, undefined), 1);
  assert.strictEqual(uncertainty(1, undefined), 0);
  assert.strictEqual(uncertainty(0, undefined), 0, 'a confident NO is as certain as a confident yes');
  assert.ok(Math.abs(uncertainty(0.75, undefined) - 0.5) < 1e-9);
  // A missing answer is maximally uncertain, never quietly certain.
  assert.strictEqual(uncertainty(null, undefined), 1);
  assert.strictEqual(uncertainty(undefined, undefined), 1);
  // ⚠ An invalid number is missing, not certain. NaN made uncertainty NaN, which fails the escalation
  // comparison, so the least trustworthy answer was the one never sent for a second opinion.
  for (const bad of [NaN, Infinity, 1.5, -0.1]) {
    assert.strictEqual(uncertainty(bad, undefined), 1, `noul ${bad} is maximally uncertain`);
    assert.strictEqual(uncertainty(1, bad), 0, `confidence ${bad} is ignored and the noul decides`);
  }
  // Escalation picks PAIRS, so a row certain on one tag and unsure on another contributes once.
  const rows = [{ tags: { a: 0.99, b: 0.52 } }, { tags: { a: 0.01, b: 0.98 } }];
  const esc = toEscalate(rows, 0.8);
  assert.deepStrictEqual(esc.map((e) => `${e.i}.${e.tag}`), ['0.b']);
  // A row that failed the sweep has no tags and must not be escalated as if it were uncertain.
  assert.deepStrictEqual(toEscalate([{ error: 'boom' }], 0.8), []);
  // Parsing survives a code fence and leading prose, and refuses rather than defaulting.
  assert.deepStrictEqual(parseVerdict('```json\n{"answer":true,"confidence":0.9,"why":"x"}\n```'),
    { answer: true, confidence: 0.9, why: 'x' });
  assert.deepStrictEqual(parseVerdict('Sure! {"answer":false,"confidence":0.4,"why":"y"}'),
    { answer: false, confidence: 0.4, why: 'y' });
  assert.strictEqual(parseVerdict('I cannot answer that.'), null);
  assert.strictEqual(parseVerdict('{"answer":"yes"}'), null, 'a non-boolean answer is a failed parse');
  assert.strictEqual(parseVerdict('{broken'), null);
  assert.strictEqual(parseVerdict(null), null);
  return 'jevescalate selftest OK';
}

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : argv[i + 1]; };
if (flag('selftest')) { console.log(selftest()); process.exit(0); }

const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }
const model = opt('model') ?? DEFAULT_MODEL;
const below = Number(opt('below')) || DEFAULT_BELOW;

const rows = JSON.parse(fs.readFileSync(opt('in'), 'utf8'));
// The JD bodies are not in the tags file, deliberately; re-read them from the cache the sweep used.
const cacheRaw = JSON.parse(fs.readFileSync('C:/Users/thelo/job-search/cache/li_details.json', 'utf8'));
const byUrl = new Map((Array.isArray(cacheRaw) ? cacheRaw : Object.values(cacheRaw))
  .filter((r) => r && r.jd_url).map((r) => [r.jd_url, r]));

// The EXACT wording the sweep used, not a paraphrase: a verifier asked a slightly different
// question is measuring a different thing and its disagreements mean nothing.
const { TAGS: TAG_QUESTIONS } = await import('./questions.mjs');

let pairs = toEscalate(rows, below);
if (opt('limit')) pairs = pairs.slice(0, Number(opt('limit')));
const scored = rows.filter((r) => r.tags).length;
const totalAnswers = scored * Object.keys(rows.find((r) => r.tags)?.tags ?? {}).length;
console.log(selftest());
console.log(`${scored} rows, ${totalAnswers} answers; escalating ${pairs.length} `
  + `(${(pairs.length / totalAnswers * 100).toFixed(1)}%) below confidence ${below} to ${model}`);

let last = 0;
const results = await runPool(pairs, async (p) => {
  const row = rows[p.i];
  const jd = byUrl.get(row.jd_url);
  const question = TAG_QUESTIONS[p.tag];
  if (!jd || !question) return { ...p, skipped: !jd ? 'no jd text' : 'unknown tag' };
  try {
    const { text, cost } = await askLLM(
      PROMPT(row.title, row.company, question, String(jd.jd_text).slice(0, 12000)), key, model);
    return { ...p, verdict: parseVerdict(text), raw: text.slice(0, 120), cost };
  } catch (e) { return { ...p, error: e.message }; }
}, CONCURRENCY, (done, total) => {
  if (done - last >= 50 || done === total) { console.error(`  ${done}/${total}`); last = done; }
});

const parsed = results.filter((r) => r.verdict);
const agree = parsed.filter((r) => r.verdict.answer === (r.value >= 0.5));
const cost = results.reduce((s, r) => s + (r.cost ?? 0), 0);
console.log(`\n  verified        ${parsed.length}`);
console.log(`  unparseable     ${results.filter((r) => !r.verdict && !r.error && !r.skipped).length}`);
console.log(`  skipped         ${results.filter((r) => r.skipped).length}`);
console.log(`  failed          ${results.filter((r) => r.error).length}`);
console.log(`  LLM agrees      ${agree.length}/${parsed.length} (${(agree.length / parsed.length * 100).toFixed(1)}%)`);
console.log(`  cost            $${cost.toFixed(4)}`);

// Per-tag, because a tag the verifier disagrees with often is a badly worded question, which is a
// different fix from a model that is simply unsure.
const byTag = {};
for (const r of parsed) {
  byTag[r.tag] ??= { n: 0, agree: 0 };
  byTag[r.tag].n++;
  if (r.verdict.answer === (r.value >= 0.5)) byTag[r.tag].agree++;
}
console.log('\n  tag                          escalated  agrees');
for (const [t, s] of Object.entries(byTag).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${t.padEnd(30)}${String(s.n).padStart(6)}  ${(s.agree / s.n * 100).toFixed(0)}%`);
}

if (opt('out')) {
  fs.writeFileSync(opt('out'), JSON.stringify(results, null, 2));
  console.log(`\nverdicts written to ${opt('out')}`);
}
