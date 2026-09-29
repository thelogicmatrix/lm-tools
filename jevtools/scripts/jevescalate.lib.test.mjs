// jevescalate.lib's offline tests, moved out of the library's --selftest branch.
import test from 'node:test';
import assert from 'node:assert';
import { ATTEMPTS } from './lib.mjs';
import { askVerifier, groupByRow, parseVerdict, selectUncertain, summarise, uncertainty } from './jevescalate.lib.mjs';

test('uncertainty, selection by row, verdict parsing and the summary', async () => {
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
});

// The verifier call goes through lib.mjs's postText, so it gets the same timeout, retry and status-first
// error as every Jev call rather than a copy of them.
test('askVerifier retries a 503 and parses the verdict, and a 401 is final', async () => {
  const realFetch = globalThis.fetch;
  const sent = [];
  try {
    globalThis.fetch = async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      if (sent.length === 1) return new Response('busy', { status: 503 });
      const content = '{"answer":true,"confidence":0.8,"why":"stated"}';
      return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0.0002 } }), { status: 200 });
    };
    const r = await askVerifier('q', 'ctx', 'k', 'm', { baseDelayMs: 0 });
    assert.deepStrictEqual(r, { verdict: { answer: true, confidence: 0.8, why: 'stated' }, cost: 0.0002 });
    assert.strictEqual(sent.length, 2, 'the 503 was asked again');
    assert.strictEqual(sent[1].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.deepStrictEqual([sent[1].auth, sent[1].body.model, sent[1].body.max_tokens], ['Bearer k', 'm', 120]);

    sent.length = 0;
    globalThis.fetch = async (url, init) => { sent.push(url); return new Response('bad key', { status: 401 }); };
    await assert.rejects(() => askVerifier('q', 'ctx', 'k', undefined, { baseDelayMs: 0 }), { message: 'HTTP 401: bad key', status: 401 });
    assert.strictEqual(sent.length, 1, 'a 401 is not retried');

    sent.length = 0;
    globalThis.fetch = async (url) => { sent.push(url); return new Response('down', { status: 500 }); };
    await assert.rejects(() => askVerifier('q', 'ctx', 'k', undefined, { baseDelayMs: 0 }), /^Error: HTTP 500: down/);
    assert.strictEqual(sent.length, ATTEMPTS, 'a permanent 500 uses its attempts');
  } finally {
    globalThis.fetch = realFetch;
  }
});
