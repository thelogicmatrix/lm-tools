// jevdrift's offline tests, moved out of the script's --selftest branch.
import test from 'node:test';
import assert from 'node:assert';
import { MAX_CHUNK, MIN_CHUNK, QUESTIONS, chunkMarkdown, proposePairs } from './jevdrift.mjs';

test('chunking, same-file pairs never propose, and the sufficiency question exists', () => {
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
});
