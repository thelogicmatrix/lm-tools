// Confidence-gated escalation, as a reusable module rather than a script.
//
// THE PATTERN (opportunity 10). Jev answers everything; only the uncertain tail reaches a full
// model. Measured 2026-09-22 against Orion's own yearsAsked regex over 220 JDs: agreement was 98.4%
// at confidence 0.95+, 88.9% at 0.80-0.95, and 58-67% below 0.80. So the expensive model never sees
// the ~90% that is already settled, and cost lands only where the answer is genuinely close.
//
// This is not a product, it is a wrapper for the other sweeps. jevescalate.mjs is the JD-specific CLI
// over it; anything else that produces {tags, extras} can call `selectUncertain` and `escalate`.
//
// ⚠ THE VERIFIER IS NOT GROUND TRUTH. Asked the same question twice, Jev moved at most 0.08 while
// headless Haiku moved 0.35. A disagreement means "a human should read this one", never "the big
// model was right".

import { isNoul, TIMEOUT_MS } from './lib.mjs';

const CHAT = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';

// How unsure an answer is, on one scale for both primitives.
// A Score or Choice reports confidence directly. A NOUL DOES NOT, so it is scored on distance from
// 0.5 instead: 0.51 is a coin flip wearing an answer's clothes, 0.98 is not. That is a proxy for
// "torn", which is not the same thing as "unsure", and it is the weakest link in this module.
// Invalid is treated as missing on both inputs. A NaN made the uncertainty NaN, which fails the
// escalation comparison, so the least trustworthy answer was the one never escalated.
export function uncertainty(value, confidence) {
  if (isNoul(confidence)) return 1 - confidence;
  if (!isNoul(value)) return 1;                      // missing or invalid is maximally uncertain
  return 1 - Math.abs(value - 0.5) * 2;
}

// ⚠ THE NOUL PROXY THRESHOLD IS DELIBERATELY TIGHT, and the first version was not.
// A noul carries no confidence, so it is scored on distance from 0.5. At `below = 0.8` that flags
// everything between 0.1 and 0.9, which on the real JD sweep was 32,421 of 126,958 answers (25.5%)
// — and a noul of 0.85 is not in practice an uncertain answer. Measured 2026-09-22: escalating all
// of those at $0.00093 a call is $30.15, against $4.39 to send all 4,883 JDs to the LLM once. The
// pattern inverted. `noulBand` keeps the proxy to the genuinely torn middle.
const DEFAULT_NOUL_BAND = 0.25;   // only 0.25-0.75 counts as torn

// Returns (row, field) PAIRS. A row can be certain on nine fields and a coin flip on the tenth, so
// the field granularity is right for SELECTION — but see groupByRow before spending on it.
export function selectUncertain(rows, { below = 0.8, fields = null, noulBand = DEFAULT_NOUL_BAND } = {}) {
  const out = [];
  for (const [i, r] of rows.entries()) {
    if (!r?.tags) continue;                          // a failed sweep row is not an uncertain one
    for (const [field, value] of Object.entries(r.tags)) {
      if (fields && !fields.includes(field)) continue;
      const conf = r.extras?.[field]?.confidence;
      if (typeof conf === 'number') {
        // A real confidence figure: use the threshold as stated.
        if (1 - conf > 1 - below) out.push({ i, field, value });
      } else if (value === null || value === undefined) {
        out.push({ i, field, value });                       // a missing answer always escalates
      } else if (Math.abs(value - 0.5) <= noulBand) {
        out.push({ i, field, value });                       // the torn middle only
      }
    }
  }
  return out;
}

// ⚠ SPEND BY ROW, NOT BY PAIR. This is the fix for the inversion above: if eight tags on one JD are
// uncertain, that is ONE call asking eight questions, not eight calls each re-reading the document.
// The document is what costs; the questions are nearly free — the same economics as the Jev side.
// 32,421 pairs collapse to at most one call per row this way.
export function groupByRow(pairs) {
  const byRow = new Map();
  for (const p of pairs) {
    if (!byRow.has(p.i)) byRow.set(p.i, []);
    byRow.get(p.i).push(p);
  }
  return [...byRow.entries()].map(([i, ps]) => ({ i, fields: ps }));
}

// The verifier is a text model, so its output is usually but not always JSON. A failed parse must
// return null, never a default: recording an unparseable reply as `false` is a silent wrong answer.
export function parseVerdict(text) {
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (typeof o.answer !== 'boolean') return null;
    return { answer: o.answer,
      confidence: typeof o.confidence === 'number' ? o.confidence : null,
      why: String(o.why ?? '').slice(0, 80) };
  } catch { return null; }
}

export const prompt = (question, context) =>
  'You are verifying a single yes/no classification. Answer with ONLY a JSON object: '
  + '{"answer": true|false, "confidence": 0.0-1.0, "why": "<12 words max>"}. No prose, no code '
  + `fences.\n\nQUESTION: ${question}\n\nMATERIAL:\n${context}`;

// Timeout and status-first parse for the same reasons as lib.mjs's postText. Kept inline because
// `fetchImpl` is injectable here.
export async function askVerifier(question, context, key, model = DEFAULT_MODEL, fetchImpl = fetch) {
  const res = await fetchImpl(CHAT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 120, temperature: 0,
      messages: [{ role: 'user', content: prompt(question, context) }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
  const body = JSON.parse(text);
  return { verdict: parseVerdict(body.choices?.[0]?.message?.content ?? ''), cost: body.usage?.cost ?? 0 };
}

// `resolve(pair)` returns { question, context } for a pair, or null to skip it. The caller owns
// that, because only the caller knows where its source text lives.
export async function escalate(pairs, resolve, key, { model = DEFAULT_MODEL, runPool, concurrency = 4, onDone } = {}) {
  return runPool(pairs, async (p) => {
    const r = resolve(p);
    if (!r) return { ...p, skipped: 'no material' };
    try {
      const { verdict, cost } = await askVerifier(r.question, r.context, key, model);
      return { ...p, verdict, cost };
    } catch (e) { return { ...p, error: e.message }; }
  }, concurrency, onDone);
}

export function summarise(results) {
  const parsed = results.filter((r) => r.verdict);
  const agree = parsed.filter((r) => r.verdict.answer === (r.value >= 0.5));
  return {
    escalated: results.length,
    verified: parsed.length,
    unparseable: results.filter((r) => !r.verdict && !r.error && !r.skipped).length,
    failed: results.filter((r) => r.error).length,
    skipped: results.filter((r) => r.skipped).length,
    agreed: agree.length,
    agreementRate: parsed.length ? agree.length / parsed.length : null,
    cost: results.reduce((s, r) => s + (r.cost ?? 0), 0),
  };
}

export async function selftest() {
  const a = (await import('node:assert')).default;
  // Reported confidence is used directly.
  assert_close(uncertainty(0.9, 0.95), 0.05);
  a.strictEqual(uncertainty(0.9, 1), 0);
  // A noul with no confidence escalates on distance from 0.5, both directions equally.
  a.strictEqual(uncertainty(0.5, undefined), 1);
  a.strictEqual(uncertainty(1, undefined), 0);
  a.strictEqual(uncertainty(0, undefined), 0, 'a confident NO is as certain as a confident yes');
  a.strictEqual(uncertainty(null, undefined), 1, 'a missing answer must never read as certain');
  for (const bad of [NaN, Infinity, 1.5, -0.1]) {
    a.strictEqual(uncertainty(bad, undefined), 1, `an invalid noul ${bad} is maximally uncertain`);
    a.strictEqual(uncertainty(0.99, bad), 0.020000000000000018, `an invalid confidence ${bad} falls back to the noul`);
  }

  // Pairs, not rows: one certain field and one uncertain contributes exactly once.
  const rows = [{ tags: { a: 0.99, b: 0.52 } }, { tags: { a: 0.01, b: 0.98 } }];
  a.deepStrictEqual(selectUncertain(rows, { below: 0.8 }).map((p) => `${p.i}.${p.field}`), ['0.b']);
  // A failed sweep row is skipped rather than treated as uncertain.
  a.deepStrictEqual(selectUncertain([{ error: 'boom' }]), []);
  // `fields` narrows the spend to the tags that matter.
  a.deepStrictEqual(selectUncertain(rows, { below: 0.8, fields: ['a'] }), []);
  // A reported confidence beats the noul proxy: a decisive 0.99 with LOW confidence still escalates.
  a.strictEqual(selectUncertain([{ tags: { x: 0.99 }, extras: { x: { confidence: 0.2 } } }],
    { below: 0.8 }).length, 1);
  // ⚠ The noul band is the fix for the $30-versus-$4 inversion: 0.85 is NOT torn and must not
  // escalate, while 0.55 is. The first version flagged everything from 0.1 to 0.9.
  a.strictEqual(selectUncertain([{ tags: { x: 0.85 } }], { below: 0.8 }).length, 0);
  a.strictEqual(selectUncertain([{ tags: { x: 0.15 } }], { below: 0.8 }).length, 0);
  a.strictEqual(selectUncertain([{ tags: { x: 0.55 } }], { below: 0.8 }).length, 1);
  a.strictEqual(selectUncertain([{ tags: { x: null } }], { below: 0.8 }).length, 1, 'missing always escalates');
  // Grouping collapses per-field pairs into one call per row, which is where the money is.
  const grouped = groupByRow([{ i: 0, field: 'a' }, { i: 0, field: 'b' }, { i: 3, field: 'a' }]);
  a.strictEqual(grouped.length, 2);
  a.strictEqual(grouped[0].fields.length, 2);
  a.deepStrictEqual(grouped.map((g) => g.i), [0, 3]);

  // Parsing survives a fence and leading prose, and refuses rather than defaulting.
  a.deepStrictEqual(parseVerdict('```json\n{"answer":true,"confidence":0.9,"why":"x"}\n```'),
    { answer: true, confidence: 0.9, why: 'x' });
  a.strictEqual(parseVerdict('{"answer":"yes"}'), null, 'a non-boolean answer is a failed parse');
  a.strictEqual(parseVerdict('I cannot answer that.'), null);
  a.strictEqual(parseVerdict(null), null);

  // The summary counts an unparseable reply separately from a failure and from agreement.
  const s = summarise([
    { value: 0.6, verdict: { answer: true } },
    { value: 0.6, verdict: { answer: false } },
    { value: 0.6, error: 'x' }, { value: 0.6 }, { value: 0.6, skipped: 'no material' },
  ]);
  a.strictEqual(s.verified, 2); a.strictEqual(s.agreed, 1); a.strictEqual(s.agreementRate, 0.5);
  a.strictEqual(s.failed, 1); a.strictEqual(s.unparseable, 1); a.strictEqual(s.skipped, 1);

  function assert_close(x, y) { a.ok(Math.abs(x - y) < 1e-9, `${x} != ${y}`); }
  return 'jevescalate.lib selftest OK';
}

if (process.argv[1] && process.argv[1].endsWith('jevescalate.lib.mjs') && process.argv.includes('--selftest')) {
  console.log(await selftest());
}
