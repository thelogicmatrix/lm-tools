// Confidence-gated escalation, as a reusable module rather than a script.
//
// THE PATTERN (opportunity 10). Jev answers everything; only the uncertain tail reaches a full
// model. Measured 2026-09-22 against a job-board prefilter's own years-asked regex over 220 JDs: agreement was 98.4%
// at confidence 0.95+, 88.9% at 0.80-0.95, and 58-67% below 0.80. So the expensive model never sees
// the ~90% that is already settled, and cost lands only where the answer is genuinely close.
//
// This is not a product, it is a wrapper for the other sweeps. The JD-specific CLI over it lives in the
// author's private tree. Anything else that produces {tags, extras} can call `selectUncertain` and `escalate`.
//
// ⚠ THE VERIFIER IS NOT GROUND TRUTH. Asked the same question twice, Jev moved at most 0.08 while
// headless Haiku moved 0.35. A disagreement means "a human should read this one", never "the big
// model was right".

import { isNoul, postText, TIMEOUT_MS } from './lib.mjs';

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

// Through lib.mjs's postText, so the verifier gets the same timeout, retry and status-first error as
// every Jev call. `retry` passes through to it.
export async function askVerifier(question, context, key, model = DEFAULT_MODEL, retry = {}) {
  const text = await postText(CHAT, key, { model, max_tokens: 120, temperature: 0,
    messages: [{ role: 'user', content: prompt(question, context) }] }, TIMEOUT_MS, retry);
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
