// The network half of lib.mjs, with `fetch` replaced so nothing is spent.
//   node scripts/jev-sweep/lib.test.mjs
import assert from 'node:assert';
import { askJev, isNoul, toText } from './lib.mjs';

const realFetch = globalThis.fetch;
try {
  // A gateway error page is HTML. Parsed before the status check it threw `Unexpected token '<'`
  // and the status was lost. The error must name the status.
  globalThis.fetch = async () => new Response('<html>Bad Gateway</html>', { status: 502 });
  await assert.rejects(() => askJev('s', {}, 'k'), /^Error: HTTP 502: <html>Bad Gateway/, 'a 502 names its status');

  // ⚠ A WEDGED CALL MUST END. The mock never answers and honours the abort signal, as real fetch
  // does. It holds a timer the way a real open socket holds the event loop, because the timeout's
  // own timer is unref'd and would otherwise let the process exit before it fires.
  globalThis.fetch = (_url, init) => new Promise((_, reject) => {
    const socket = setTimeout(() => {}, 10_000);
    init.signal.addEventListener('abort', () => { clearTimeout(socket); reject(init.signal.reason); });
  });
  const t0 = Date.now();
  await assert.rejects(() => askJev('s', {}, 'k', { timeoutMs: 50 }), /no response after 0\.05 s/, 'a hung call times out');
  assert.ok(Date.now() - t0 < 2000, 'and does so near the timeout, not whenever the socket gives up');

  // The happy path still returns answers and cost.
  globalThis.fetch = async () => new Response(JSON.stringify({ answers: { q: { noul: 0.7 } }, usage: { cost: 0.0001 } }), { status: 200 });
  assert.deepStrictEqual(await askJev('s', {}, 'k'), { answers: { q: { noul: 0.7 } }, cost: 0.0001 });
} finally {
  globalThis.fetch = realFetch;
}

// isNoul, pinned by value on both edges of its domain.
assert.deepStrictEqual([0, 0.5, 1].map(isNoul), [true, true, true]);
assert.deepStrictEqual([NaN, Infinity, -0.01, 1.01, '0.5', null, undefined].map(isNoul),
  [false, false, false, false, false, false, false]);

// toText, moved here from jevmail's selftest when jevmail stopped using it (postman sends text
// since lm-tools #6). The JD sweeps in the author's private tree still feed it raw bodies.
// Quoted-printable, in the order that actually matters: a soft line break decoded after =XX
// glues the words either side of it together.
assert.strictEqual(toText('applic=\r\nation'), 'application');
assert.strictEqual(toText('a=3Db'), 'a=b');
// Markup goes, and the words inside it survive.
assert.strictEqual(toText('<p>Thank you for <b>applying</b></p>'), 'Thank you for applying');
assert.strictEqual(toText('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>Regret</body></html>'), 'Regret');
// Script and style bodies are not prose. Stripping tags alone would leave the CSS behind as
// "content" and it reads like text to a model.
assert.strictEqual(toText('<style>body{color:red}</style>Hello'), 'Hello');
assert.strictEqual(toText('<script>var x="apply now"</script>Hi'), 'Hi');
assert.strictEqual(toText('<!-- hidden -->Visible'), 'Visible');
// MIME scaffolding is not content. Real shapes from the 2026-09-22 window.
assert.strictEqual(toText('--91ae4e6db3e694e7bbe369bdae65a8975dab85b2404766f66bf0923ccdf9\nHello'), 'Hello');
assert.strictEqual(toText('Content-Transfer-Encoding: quoted-printable\nHello'), 'Hello');
assert.strictEqual(toText('Content-Type: text/plain; charset="utf-8"\nHello'), 'Hello');
assert.strictEqual(toText('------------------------------=\nHello'), 'Hello');
// ...but a "Content-Type" mentioned mid-sentence must survive: the patterns are line-anchored
// for exactly this reason.
assert.strictEqual(toText('We discussed Content-Type: json in the call'), 'We discussed Content-Type: json in the call');
// Entities, including the numeric ones Workday emits.
assert.strictEqual(toText('Tom &amp; Jerry&#39;s'), "Tom & Jerry's");
assert.strictEqual(toText('a&nbsp;b'), 'a b');
// An unknown entity becomes a space rather than surviving as literal junk.
assert.strictEqual(toText('a&zzz;b'), 'a b');
// Plain text passes through untouched, which is the common case (median ratio was 1.00).
assert.strictEqual(toText('Thanks for your application.'), 'Thanks for your application.');
assert.strictEqual(toText(null), '');

console.log('lib selftest OK');
