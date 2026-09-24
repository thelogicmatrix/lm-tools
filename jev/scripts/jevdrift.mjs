#!/usr/bin/env node
// Find rules stated in two places that disagree.
//
// "One fact, one home" is a stated rule in AGENTS.md with nothing enforcing it, and `brief.md`
// being 40 days stale against a downstream screen is a live instance of the cost.
//
// ARCHITECTURE, and it is the rule this whole day produced: CONTRADICTION IS CROSS-ITEM, so code
// proposes the pairs and Jev judges each pair. A per-chunk sweep cannot find a contradiction because
// neither half is wrong on its own. Code does the enumerating (rare-term overlap, free, exact), Jev
// does the judging (one pair at a time, which is all it can do).
//
// ⚠ AND IT ASKS ABOUT SUFFICIENCY EXPLICITLY. Measured 2026-09-22: handed a document that could not
// answer the question, Jev answered confidently anyway (0.953 on a different company's JD). So
// confidence cannot be read as "the context was enough" and a separate question has to ask.
//
//   node jevdrift.mjs --root docs --pairs 120 --out conflicts.json
//   node jevdrift.mjs --selftest

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { askJev, runPool } from './lib.mjs';

const CONCURRENCY = 6;
const MIN_CHUNK = 320;      // below this a section is a heading and a sentence, not a rule
const MAX_CHUNK = 6000;     // keeps a pair inside the ~11.4k-token measured state ceiling
const STOP = new Set(('the a an and or but if then of to in on for with from by is are was were be '
  + 'this that these those it its as at not no do does done can will would should must may run use '
  + 'used using when where which what who how why all any each per via into out up down over only '
  + 'one two new old same other more most less least also than there here their them they you your '
  + 'we our i me my so such very just now still yet own about after before between during while')
  .split(' '));

// Split a markdown file at ## headings. A rule lives in a section, not a file: `AGENTS.md` states
// a dozen unrelated rules and judging it whole would ask about all of them at once.
export function chunkMarkdown(text, file) {
  const out = [];
  const parts = String(text ?? '').split(/^(?=##\s)/m);
  for (const p of parts) {
    const body = p.trim();
    if (body.length < MIN_CHUNK) continue;
    const heading = body.match(/^#{1,6}\s*(.+)$/m)?.[1]?.trim() ?? '(preamble)';
    out.push({ file, heading, text: body.slice(0, MAX_CHUNK) });
  }
  return out;
}

// Rare terms are what make two sections about the same thing. Frequency across the whole corpus
// does the work: a term in 200 sections is noise, a term in 3 is a topic.
export function rareTerms(chunk, df, totalChunks) {
  const seen = new Set();
  for (const w of chunk.text.toLowerCase().match(/[a-z][a-z0-9_.-]{3,}/g) ?? []) {
    if (STOP.has(w)) continue;
    seen.add(w);
  }
  return [...seen].filter((w) => {
    const n = df.get(w) ?? 0;
    return n >= 2 && n <= Math.max(3, totalChunks * 0.02);
  });
}

// Candidate pairs, ranked by how many rare terms they share. Bounded, because the pair count is
// quadratic and the whole point is to spend the model's budget on the few that might conflict.
export function proposePairs(chunks, limit) {
  const df = new Map();
  for (const c of chunks) {
    for (const w of new Set(c.text.toLowerCase().match(/[a-z][a-z0-9_.-]{3,}/g) ?? [])) {
      if (!STOP.has(w)) df.set(w, (df.get(w) ?? 0) + 1);
    }
  }
  const terms = chunks.map((c) => new Set(rareTerms(c, df, chunks.length)));
  const byTerm = new Map();
  for (const [i, set] of terms.entries()) {
    for (const w of set) { if (!byTerm.has(w)) byTerm.set(w, []); byTerm.get(w).push(i); }
  }
  const score = new Map();
  for (const idxs of byTerm.values()) {
    // A term shared by half the corpus proposes nothing useful and would dominate the ranking.
    if (idxs.length > 12) continue;
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        if (chunks[idxs[a]].file === chunks[idxs[b]].file) continue;   // same file is not two homes
        const k = `${idxs[a]}|${idxs[b]}`;
        score.set(k, (score.get(k) ?? 0) + 1);
      }
    }
  }
  return [...score.entries()]
    .filter(([, n]) => n >= 3)
    .sort((x, y) => y[1] - x[1])
    .slice(0, limit)
    .map(([k, n]) => { const [a, b] = k.split('|').map(Number); return { a: chunks[a], b: chunks[b], shared: n }; });
}

const QUESTIONS = {
  both_state_rules: { type: 'noul',
    instructions: 'Both sections state a rule, standard or instruction, rather than merely describing something' },
  same_subject: { type: 'noul',
    instructions: 'The two sections are giving rules about the same specific subject, not merely related topics' },
  conflict: { type: 'score',
    instructions: 'How far the two sections disagree about what should be done',
    criteria: [
      'They agree, or cover different subjects entirely',
      'One adds detail the other omits, with no disagreement',
      'They overlap and could be read as giving different advice',
      'They state directly incompatible rules: following one breaks the other',
    ] },
  // The explicit sufficiency question the confidence measurement forced. Never inferred.
  enough_context: { type: 'score',
    instructions: 'Whether the two sections shown contain enough to judge if they conflict',
    criteria: [
      'No, both are fragments and the rules are stated elsewhere',
      'Partly, one section is clear and the other is a fragment',
      'Yes, both state their rule fully enough to compare',
    ] },
};

const stateFor = (p) => `=== SECTION A — ${p.a.file} :: ${p.a.heading} ===\n${p.a.text}\n\n`
  + `=== SECTION B — ${p.b.file} :: ${p.b.heading} ===\n${p.b.text}`;

export function selftest() {
  const md = '# Title\nintro\n\n## Rule one\n' + 'x'.repeat(400) + '\n\n## Tiny\nshort\n\n## Rule two\n' + 'y'.repeat(400);
  const cs = chunkMarkdown(md, 'f.md');
  // Two survive. The short preamble and the "Tiny" section are both under MIN_CHUNK, which is the
  // point of that floor: a heading plus one sentence states no rule worth comparing.
  assert.strictEqual(cs.length, 2);
  assert.deepStrictEqual(cs.map((c) => c.heading), ['Rule one', 'Rule two']);
  assert.ok(cs.every((c) => c.text.length >= MIN_CHUNK));
  // Over-long sections are capped so a pair still fits the measured state ceiling.
  assert.ok(chunkMarkdown('## H\n' + 'z'.repeat(20000), 'f.md')[0].text.length <= MAX_CHUNK);
  // A pair must never be two sections of the SAME file: that is one home, not two.
  const chunks = [
    { file: 'a.md', heading: 'x', text: 'citizenbar permanent resident singaporean nationals gate screen ' + 'q'.repeat(400) },
    { file: 'b.md', heading: 'y', text: 'citizenbar permanent resident singaporean nationals gate screen ' + 'r'.repeat(400) },
    { file: 'a.md', heading: 'z', text: 'citizenbar permanent resident singaporean nationals gate screen ' + 's'.repeat(400) },
  ];
  const pairs = proposePairs(chunks, 50);
  assert.ok(pairs.every((p) => p.a.file !== p.b.file), 'no same-file pairs');
  assert.ok(pairs.length >= 1, 'sections sharing rare terms across files must pair');
  // A corpus with nothing in common proposes nothing, rather than pairing at random.
  assert.deepStrictEqual(proposePairs([
    { file: 'a.md', heading: 'x', text: 'alpha bravo charlie delta ' + 'q'.repeat(400) },
    { file: 'b.md', heading: 'y', text: 'echo foxtrot golf hotel ' + 'r'.repeat(400) },
  ], 50), []);
  // Sufficiency is asked, not inferred. This is the guard against the 0.953-on-a-wrong-document
  // failure: if this question ever disappears, the sweep silently starts trusting confidence.
  assert.ok(QUESTIONS.enough_context, 'the sufficiency question must exist');
  assert.strictEqual(QUESTIONS.enough_context.type, 'score');
  assert.strictEqual(QUESTIONS.conflict.criteria.length, 4);
  return 'jevdrift selftest OK';
}

if (process.argv.includes('--selftest')) { console.log(selftest()); process.exit(0); }

const opt = (n) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? null : process.argv[i + 1]; };
const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }

const root = opt('root') ?? 'docs';
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!/^(archive|handoffs)$/.test(e.name)) walk(p); }
    else if (e.name.endsWith('.md')) files.push(p);
  }
})(root);

const chunks = files.flatMap((f) => chunkMarkdown(fs.readFileSync(f, 'utf8'), path.relative(root, f)));
const pairs = proposePairs(chunks, Number(opt('pairs')) || 120);

console.log(selftest());
console.log(`${files.length} files, ${chunks.length} sections, ${pairs.length} candidate pairs`);
console.log('(archive/ and handoffs/ excluded: they are records, not live rules)');

let last = 0;
const out = await runPool(pairs, async (p) => {
  try {
    const { answers, cost } = await askJev(stateFor(p), QUESTIONS, key);
    return { a: `${p.a.file} :: ${p.a.heading}`, b: `${p.b.file} :: ${p.b.heading}`, shared: p.shared,
      rules: answers.both_state_rules.noul, same: answers.same_subject.noul,
      conflict: answers.conflict.score, conflictConf: answers.conflict.confidence ?? null,
      enough: answers.enough_context.score, cost };
  } catch (e) { return { a: p.a.heading, b: p.b.heading, error: e.message }; }
}, CONCURRENCY, (d, t) => { if (d - last >= 30 || d === t) { console.error(`  ${d}/${t}`); last = d; } });

const ok = out.filter((r) => !r.error);
// A real finding needs all four: both state rules, about the same subject, they disagree, and
// there was enough text to tell. Dropping any one of those is how this becomes noise.
const hits = ok.filter((r) => r.rules >= 0.6 && r.same >= 0.6 && r.conflict >= 2 && r.enough >= 1.5)
  .sort((x, y) => y.conflict - x.conflict);
const thin = ok.filter((r) => r.conflict >= 2 && r.enough < 1.5);

console.log(`\n  judged          ${ok.length}`);
console.log(`  conflicts       ${hits.length}`);
console.log(`  too thin to say ${thin.length}  <- would have been false positives on confidence alone`);
console.log(`  cost            $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(4)}`);

for (const h of hits.slice(0, 20)) {
  console.log(`\n  conflict ${h.conflict.toFixed(2)} (conf ${(h.conflictConf ?? 0).toFixed(2)}, context ${h.enough.toFixed(1)}/2)`);
  console.log(`    A  ${h.a}`);
  console.log(`    B  ${h.b}`);
}

if (opt('out')) {
  fs.writeFileSync(opt('out'), JSON.stringify(out, null, 2));
  console.log(`\nwritten to ${opt('out')}`);
}
