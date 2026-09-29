// Resume, the per-call journal, --concurrency and the no-retry codes, through the real CLI against
// a stub Jev server on localhost that counts every call. Nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sweepId } from './lib/journal.mjs';

const CLI = fileURLToPath(new URL('./jevchecker.mjs', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jevchecker-resume-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Twelve lines of 7000 characters pack three to a call against the 24,000-character budget, so a
// full sweep is four calls of three questions.
const bodyFile = path.join(tmp, 'body.txt');
fs.writeFileSync(bodyFile, Array.from({ length: 12 }, (_, i) => `line ${i} ${'x'.repeat(7000)}`).join('\n'));
const sweepFile = path.join(tmp, 'sweep.json');
fs.writeFileSync(sweepFile, JSON.stringify({ name: 'resume', chunk: { type: 'lines' },
  checks: [{ id: 'grounded', type: 'noul', instructions: 'supported by the source' }] }));
const ALL = Array.from({ length: 12 }, (_, i) => `c${i}__grounded`);

// `plan(n, keys)` decides the reply to request n (1-based): 'ok', 'partial' (drops the first
// answer), 'hang' (never replies), or an HTTP status. Every request is counted with its keys.
async function stub(plan) {
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      const keys = Object.keys(JSON.parse(raw).questions);
      requests.push(keys);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const step = plan(requests.length, keys);
      if (step === 'hang') return;
      if (typeof step === 'object') await new Promise((r) => setTimeout(r, step.delay));
      inFlight--;
      if (typeof step === 'number') return res.writeHead(step).end('refused');
      const answered = step === 'partial' ? keys.slice(1) : keys;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        answers: Object.fromEntries(answered.map((k) => [k, { noul: 0.9 }])), usage: { cost: 0.001 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/`, requests, max: () => maxInFlight,
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

// The CLI with Jev's endpoint redirected to the stub, before the script loads.
function cli(s, args, { until } = {}) {
  const mock = `const real = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (!String(url).startsWith('https://openrouter.ai/')) throw new Error('unexpected host ' + url);
  return real(${JSON.stringify(s.url)}, init);
};`;
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(mock)}`, CLI,
    bodyFile, '--sweep', sweepFile, '--text', ...args], {
    env: { ...process.env, OPENROUTER_API_KEY: 'stub-key', JEV_SPEND_DISABLED: '1', JEVCHECKER_JOURNAL_DIR: tmp },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return new Promise((resolve) => {
    const timer = until && setInterval(() => { if (until()) { clearInterval(timer); child.kill(); } }, 20);
    child.on('close', (code) => { if (timer) clearInterval(timer); resolve({ code, out }); });
  });
}

const journalFile = () => fs.readdirSync(tmp).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(tmp, f));

test('a run killed midway, then resumed, pays only for the unanswered rows', async () => {
  // Run 1, one call at a time: call 1 answers, call 2 drops one answer, call 3 hangs and the run is
  // killed while it waits. Five of twelve rows are answered and on disk.
  const s1 = await stub((n) => (n === 1 ? 'ok' : n === 2 ? 'partial' : 'hang'));
  const killed = await cli(s1, ['--concurrency', '1'], { until: () => s1.requests.length === 3 });
  await s1.close();
  assert.notEqual(killed.code, 0, `the first run was killed: ${killed.out}`);
  const [journal] = journalFile();
  assert.ok(journal, 'the journal survived the kill');
  const onDisk = fs.readFileSync(journal, 'utf8').trim().split('\n').map((l) => Object.keys(JSON.parse(l).answers));
  assert.deepEqual(onDisk, [ALL.slice(0, 3), ALL.slice(4, 6)], 'each answered call was written as it landed');

  // Run 2 resumes. It asks exactly the seven unanswered rows, in three calls, and nothing else.
  const s2 = await stub(() => 'ok');
  const resumed = await cli(s2, ['--resume']);
  await s2.close();
  assert.equal(resumed.code, 0, resumed.out);
  const asked = s2.requests.flat();
  assert.deepEqual(asked.sort(), [ALL[3], ...ALL.slice(6)].sort(), 'only the unanswered rows were asked again');
  assert.equal(s2.requests.length, 3, 'packed into three calls');
  assert.match(resumed.out, /resume: 12 chunks, 3 calls, \$0\.003000, 5 answers resumed from the journal/);
  assert.match(resumed.out, /0 candidates to read/);
  assert.ok(!/UNANSWERED/.test(resumed.out), 'every row is answered now');
  assert.deepEqual(journalFile(), [], 'a fully answered sweep deletes its journal');

  // The control: the same sweep without --resume asks all twelve again.
  const s3 = await stub(() => 'ok');
  const fresh = await cli(s3, []);
  await s3.close();
  assert.equal(fresh.code, 0, fresh.out);
  assert.deepEqual(s3.requests.flat().sort(), [...ALL].sort(), 'without --resume every row is asked');
});

test('a partial run keeps its journal and says how to resume, and a finished one exits 0', async () => {
  // A 400 is final, so call 2 fails outright. A 503 would be retried and recover.
  const s = await stub((n) => (n === 2 ? 400 : 'ok'));
  const partial = await cli(s, ['--concurrency', '1']);
  await s.close();
  assert.equal(partial.code, 0, `some rows unanswered is a sweep that ran: ${partial.out}`);
  assert.match(partial.out, /3 UNANSWERED/);
  assert.match(partial.out, /Run again with --resume to ask only these 3/);
  assert.ok(!partial.out.includes('NOTHING ANSWERED'));
  assert.equal(journalFile().length, 1, 'the journal stays while rows are unanswered');
  const s2 = await stub(() => 'ok');
  const done = await cli(s2, ['--resume']);
  await s2.close();
  assert.equal(done.code, 0, done.out);
  assert.deepEqual(s2.requests.flat().sort(), ALL.slice(3, 6).sort(), 'the resume asks only the failed call');
  assert.deepEqual(journalFile(), []);
});

test('--concurrency sets the calls in flight, and a bad value exits 1 before any call', async () => {
  for (const n of [1, 3]) {
    const s = await stub(() => ({ delay: 150 }));
    const r = await cli(s, ['--concurrency', String(n)]);
    await s.close();
    assert.equal(r.code, 0, r.out);
    assert.equal(s.max(), n, `--concurrency ${n}`);
  }
  for (const bad of [['--concurrency', '0'], ['--concurrency', 'two'], ['--concurrency', '1.5'], ['--concurrency']]) {
    const s = await stub(() => 'ok');
    const r = await cli(s, bad);
    await s.close();
    assert.equal(r.code, 1, `${bad.join(' ')}: ${r.out}`);
    assert.match(r.out, /--concurrency takes a whole number of 1 or more/);
    assert.equal(s.requests.length, 0, 'and nothing was sent');
  }
});

test('a 400 or 401 is asked once per call, never retried, and all failing is NOTHING ANSWERED', async () => {
  for (const status of [400, 401]) {
    const s = await stub(() => status);
    const r = await cli(s, []);
    await s.close();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /NOTHING ANSWERED/);
    assert.equal(s.requests.length, 4, `four calls, one attempt each, on a ${status}`);
    for (const f of journalFile()) fs.rmSync(f);
  }
});

test('the journal id changes with the body, the checks and the source', () => {
  const chunks = [{ id: 'c0', text: 'a' }];
  const checks = [{ id: 'k', type: 'noul', instructions: 'i' }];
  const base = sweepId(chunks, checks, null);
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(sweepId([{ id: 'c0', text: 'a' }], [{ id: 'k', type: 'noul', instructions: 'i' }], null), base);
  assert.notEqual(sweepId([{ id: 'c0', text: 'b' }], checks, null), base);
  assert.notEqual(sweepId(chunks, [{ ...checks[0], instructions: 'j' }], null), base);
  assert.notEqual(sweepId(chunks, checks, 'source'), base);
});
