// The network half of lib.mjs, with `fetch` replaced so nothing is spent.
//   node scripts/lib.test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ATTEMPTS, CONCURRENCY, askJev, isMain, isNoul, parseArgs, postText, readKey, retryAfterMs, toText } from './lib.mjs';

const realFetch = globalThis.fetch;
try {
  // A gateway error page is HTML. Parsed before the status check it threw `Unexpected token '<'`
  // and the status was lost. The error must name the status.
  globalThis.fetch = async () => new Response('<html>Bad Gateway</html>', { status: 502 });
  await assert.rejects(() => askJev('s', {}, 'k', { baseDelayMs: 0 }), /^Error: HTTP 502: <html>Bad Gateway/, 'a 502 names its status');

  // ⚠ A WEDGED CALL MUST END. The mock never answers and honours the abort signal, as real fetch
  // does. It holds a timer the way a real open socket holds the event loop, because the timeout's
  // own timer is unref'd and would otherwise let the process exit before it fires.
  globalThis.fetch = (_url, init) => new Promise((_, reject) => {
    const socket = setTimeout(() => {}, 10_000);
    init.signal.addEventListener('abort', () => { clearTimeout(socket); reject(init.signal.reason); });
  });
  const t0 = Date.now();
  await assert.rejects(() => askJev('s', {}, 'k', { timeoutMs: 50, baseDelayMs: 0 }), /no response after 0\.05 s/, 'a hung call times out');
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

// readKey. Dummy strings only, and the checks use assert.ok so a failure never prints a value.
// The file path is injected so the real ~/.jev.env is never read.
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-readkey-'));
const keyFile = (name, body) => { const p = path.join(keyDir, name); fs.writeFileSync(p, body); return p; };
try {
  // A commented old line before the live one must not win.
  assert.ok(readKey({}, keyFile('commented', '# OPENROUTER_API_KEY=dummy-old\nOPENROUTER_API_KEY=dummy-live\n')) === 'dummy-live', 'a commented earlier line is skipped');
  // Surrounding quotes are not part of the key. Left in, they give a 401.
  assert.ok(readKey({}, keyFile('double', 'OPENROUTER_API_KEY="dummy-double"\n')) === 'dummy-double', 'double quotes are stripped');
  assert.ok(readKey({}, keyFile('single', "OPENROUTER_API_KEY='dummy-single'\n")) === 'dummy-single', 'single quotes are stripped');
  // A shell-style file with an export prefix, indented, with CRLF endings.
  assert.ok(readKey({}, keyFile('export', '  export OPENROUTER_API_KEY=dummy-export\r\n')) === 'dummy-export', 'an export prefix is allowed');
  // A longer name that ends in the same text is a different key.
  assert.ok(readKey({}, keyFile('suffix', 'OLD_OPENROUTER_API_KEY=dummy-other\n')) === null, 'a suffix match is not the key');
  // The environment wins over the file.
  assert.ok(readKey({ OPENROUTER_API_KEY: 'dummy-env' }, keyFile('env', 'OPENROUTER_API_KEY=dummy-file\n')) === 'dummy-env', 'the env var takes precedence');
  // A missing file is null, never a throw.
  assert.ok(readKey({}, path.join(keyDir, 'absent')) === null, 'a missing file gives null');
} finally {
  fs.rmSync(keyDir, { recursive: true, force: true });
}

// postText retry, against a stub server on localhost. `script` is the response per request in
// order, and the last entry repeats. baseDelayMs 0 keeps the backoff out of the runtime, except
// where the test is about a wait the server asked for.
const stub = async (script) => {
  const hits = [];
  const server = http.createServer((req, res) => {
    const [status, headers = {}, body = ''] = script[Math.min(hits.length, script.length - 1)];
    hits.push(Date.now());
    req.resume();
    res.writeHead(status, headers).end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, hits, close: () => new Promise((r) => server.close(r)) };
};
const OK = [200, {}, 'fine'];
{
  // A 429 with Retry-After waits what the server asked, then succeeds. The backoff is 0 here, so
  // a second request under 0.9 s after the first means the header was ignored.
  const s = await stub([[429, { 'Retry-After': '1' }, 'slow down'], OK]);
  try {
    assert.strictEqual(await postText(s.url, 'k', {}, 5000, { baseDelayMs: 0 }), 'fine');
    assert.strictEqual(s.hits.length, 2, 'a 429 is asked again');
    assert.ok(s.hits[1] - s.hits[0] >= 900, `Retry-After is honoured (waited ${s.hits[1] - s.hits[0]} ms)`);
  } finally { await s.close(); }
}
{
  // 5xx then success. 408 is retried too, on the same list.
  const s = await stub([[503, {}, 'busy'], [408, {}, 'timeout'], OK]);
  try {
    assert.strictEqual(await postText(s.url, 'k', {}, 5000, { baseDelayMs: 0 }), 'fine');
    assert.strictEqual(s.hits.length, 3, 'a 503 and a 408 are each retried');
  } finally { await s.close(); }
}
{
  // Any other 4xx is final. A bad key asked three times is three failures, not a recovery.
  for (const status of [400, 401, 403, 404]) {
    const s = await stub([[status, {}, 'no'], OK]);
    try {
      await assert.rejects(() => postText(s.url, 'k', {}, 5000, { baseDelayMs: 0 }), { message: `HTTP ${status}: no`, status },
        'the error names the status and carries it, so a caller can read a 404 as an answer');
      assert.strictEqual(s.hits.length, 1, `a ${status} is not retried`);
    } finally { await s.close(); }
  }
}
{
  // A server that never recovers is asked ATTEMPTS times and the last status surfaces.
  const s = await stub([[500, {}, 'down']]);
  try {
    await assert.rejects(() => postText(s.url, 'k', {}, 5000, { baseDelayMs: 0 }), /^Error: HTTP 500: down/);
    assert.strictEqual(s.hits.length, ATTEMPTS, 'a permanent 500 is asked ATTEMPTS times, no more');
    assert.strictEqual(ATTEMPTS, 3, 'kept small, because a timed-out call may still be billed');
  } finally { await s.close(); }
}
{
  // A refused connection is a network error and is retried. The port is closed straight after
  // it is bound, so nothing listens on it.
  const s = await stub([OK]);
  await s.close();
  const t0 = Date.now();
  await assert.rejects(() => postText(s.url, 'k', {}, 5000, { baseDelayMs: 100 }), /fetch failed/);
  assert.ok(Date.now() - t0 >= 100, 'a refused connection is backed off and retried');
}
// Retry-After in both of its forms, capped so a hostile header cannot park a sweep.
assert.strictEqual(retryAfterMs('2'), 2000);
assert.strictEqual(retryAfterMs(new Date(10_000).toUTCString(), 7_000), 3000);
assert.strictEqual(retryAfterMs('86400'), 30_000);
assert.deepStrictEqual([retryAfterMs(null), retryAfterMs(''), retryAfterMs('soon')], [null, null, null]);

// parseArgs, the one copy of the `opt` and `flag` every CLI used to carry. A valued flag reads the
// next argument, whatever it is, and an absent one is null, never undefined.
{
  const { opt, flag } = parseArgs(['--in', 'a.json', '--json', '--top', '5', 'body.txt']);
  assert.deepStrictEqual([opt('in'), opt('top'), opt('out'), opt('json')], ['a.json', '5', null, '--top']);
  assert.deepStrictEqual([flag('json'), flag('in'), flag('out'), flag('a.json')], [true, true, false, false]);
  assert.strictEqual(parseArgs(['--last']).opt('last'), undefined, 'a trailing valued flag has no value');
  assert.strictEqual(CONCURRENCY, 6, 'one concurrency for every sweep, pinned by value');
}

// isMain, compared on real paths. A plugin reached through a junction runs with argv[1] on the
// junction path while node resolves import.meta.url to the target, and a plain compare then never
// ran main() (runbooks #32).
{
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ismain-')));
  try {
    fs.mkdirSync(path.join(dir, 'real'));
    const file = path.join(dir, 'real', 'cli.mjs');
    fs.writeFileSync(file, '');
    fs.writeFileSync(path.join(dir, 'real', 'other.mjs'), '');
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), 'junction');
    const url = pathToFileURL(file).href;
    assert.strictEqual(isMain(url, file), true, 'the file itself');
    assert.strictEqual(isMain(url, path.join(dir, 'link', 'cli.mjs')), true, 'the same file through a junction');
    assert.strictEqual(isMain(url, path.join(dir, 'real', 'other.mjs')), false, 'another file');
    assert.strictEqual(isMain(url, path.join(dir, 'real', 'absent.mjs')), false, 'a path that does not exist');
    assert.strictEqual(isMain(url, undefined), false, 'no argv[1], as under `node -e`');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('lib selftest OK');
