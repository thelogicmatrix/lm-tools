// The network half of lib.mjs, with `fetch` replaced so nothing is spent.
//   node scripts/jev-sweep/lib.test.mjs
import assert from 'node:assert';
import { askJev, isNoul } from './lib.mjs';

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

console.log('lib selftest OK');
