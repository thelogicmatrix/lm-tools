import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHeader } from '../scripts/index.mjs';
import { OUTAGE_MS, DEDUPE_MS, DEDUPE_KEEP_MS, RANKED_N, RB_KEEP, SHORTLIST, STALE_LINE, ageLabel, breakerOpen, claimPrompt, codexEnvelope, dedupeFile, dedupeRecord,
  failNotice, isDuplicate, keyFor, loadCorpus, markOutage, matchedBlock, narrow, parse, readKey, readOutage, route,
  tripsBreaker } from '../scripts/router.mjs';

// The router's regression net, moved here from router.mjs's inline selftest (#37). `--selftest` on
// router.mjs still runs this file.
test('router selftest', async () => {
  const a = assert;
  const books = [
    { file: 'powershell.md', type: 'standard', purpose: 'How to write PowerShell here.' },
    { file: 'secret-transfer.md', type: 'procedure', purpose: 'Move a secret without it hitting chat.' },
  ];
  a.strictEqual(parse('**Type:** reference\nno purpose', 'p.md').purpose, null);

  // An injected entry is labelled with its type.
  a.ok(matchedBlock([{ ...books[0], p: 0.9 }]).includes('standard'));

  // Freshness: each routed runbook shows its age. A fixed now, so the case does not rot.
  const NOW = new Date('2026-10-01T12:00:00Z');
  a.strictEqual(parse('**Type:** reference\n**Purpose:** P.\n**Verified:** 2026-09-25\n', 'v.md').verified, '2026-09-25');
  a.strictEqual(parse('**Type:** reference\n**Purpose:** P.\n', 'u.md').verified, null);
  a.strictEqual(ageLabel('2026-09-25', NOW), 'verified 6 days ago');
  a.strictEqual(ageLabel('2026-09-30', NOW), 'verified 1 day ago');
  a.strictEqual(ageLabel('2026-10-01', NOW), 'verified today');
  a.strictEqual(ageLabel(null, NOW), 'never verified');
  const fresh = { file: 'f.md', type: 'reference', purpose: 'F.', verified: '2026-09-25', p: 0.9 };
  const old = { file: 'o.md', type: 'reference', purpose: 'O.', verified: '2026-08-01', p: 0.9 };
  const none = { file: 'n.md', type: 'reference', purpose: 'N.', verified: null, p: 0.9 };
  a.ok(matchedBlock([fresh], NOW).includes('(reference, 0.90, verified 6 days ago)'));
  a.ok(!matchedBlock([fresh], NOW).includes(STALE_LINE));
  a.ok(matchedBlock([fresh, old], NOW).includes(STALE_LINE));
  a.ok(matchedBlock([none], NOW).includes('never verified'));
  a.ok(matchedBlock([none], NOW).includes(STALE_LINE));
  // The cutoff, pinned by value: 30 days is still fresh, 31 is stale.
  a.ok(!matchedBlock([{ ...fresh, verified: '2026-09-01' }], NOW).includes(STALE_LINE), '30 days is not stale');
  a.ok(matchedBlock([{ ...fresh, verified: '2026-08-31' }], NOW).includes(STALE_LINE), '31 days is stale');
  // An invalid date reads as never verified, never as NaN days.
  a.strictEqual(ageLabel('2026-13-45', NOW), 'never verified');
  a.ok(matchedBlock([{ ...fresh, verified: '2026-13-45' }], NOW).includes(STALE_LINE), 'an invalid date is stale');
  a.ok(STALE_LINE.includes('verified over 30 days ago, or never'));

  // The walk itself is the thing under test here, so this runs against a real directory rather
  // than a mocked readdir. A retired fact must not route.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbr-'));
  try {
    fs.writeFileSync(path.join(tmp, 'live.md'), '**Type:** standard\n**Purpose:** Still true.');
    fs.writeFileSync(path.join(tmp, 'tomb.md'),
      '**Type:** procedure\n**Status:** retired 2026-09-23 — why\n**Purpose:** Dead process.');
    fs.mkdirSync(path.join(tmp, 'archive'));
    fs.writeFileSync(path.join(tmp, 'archive', 'dead.md'), '**Type:** standard\n**Purpose:** Superseded.');
    fs.writeFileSync(path.join(tmp, 'parked.md'),
      '**Type:** procedure\n**Status:** dormant 2026-09-24, parked\n**Purpose:** Parked process.');
    // .git and retired/ are never walked. Each holds a file with a valid header, so a walk that
    // entered either would route it. Measured on the live corpus: 277 of 291 directories walked
    // were inside docs/runbooks/.git.
    for (const d of ['.git', 'retired']) {
      fs.mkdirSync(path.join(tmp, d));
      fs.writeFileSync(path.join(tmp, d, 'inside.md'), '**Type:** standard\n**Purpose:** Must not route.');
    }
    a.deepStrictEqual(loadCorpus(tmp, parse, RB_KEEP).map((x) => x.file), ['live.md'],
      'no archive, .git or retired directory, and no retired or dormant Status line, may route');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  // --- one parse, index.mjs's ---
  // The router reads a runbook exactly as the index and the lint do: the header inside 800 bytes,
  // a purpose on its first physical line (the lint rejects a wrapped one), and retirement by the
  // strict RETIRED_RE rather than any Status line mentioning the word.
  {
    const wrapped = '**Type:** standard\n**Purpose:** One\ntwo.\n\n## X\nbody';
    a.strictEqual(parse(wrapped, 'p.md').purpose, parseHeader(wrapped).purpose, 'the purpose the index shows');
    a.strictEqual(parse(wrapped, 'p.md').purpose, 'One');
    const late = `**Type:** reference\n**Purpose:** The real one.\n\n${'x'.repeat(900)}\n**Purpose:** A body line.`;
    a.strictEqual(parse(late, 'l.md').purpose, 'The real one.', 'a body Purpose past the header is not read');
    a.strictEqual(parse('**TYPE:** standard\n**Purpose:** P.', 'c.md').type, 'standard', 'a label in capitals still reads');
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rbr-'));
    try {
      // A Status line in the body is prose, not a retirement, and the index lists this file too.
      fs.writeFileSync(path.join(tmp2, 'live.md'),
        `**Type:** standard\n**Purpose:** Live.\n\n${'x'.repeat(900)}\n**Status:** retired 2026-01-01 — a quoted example`);
      a.deepStrictEqual(loadCorpus(tmp2, parse, RB_KEEP).map((x) => x.file), ['live.md']);
    } finally { fs.rmSync(tmp2, { recursive: true, force: true }); }
  }

  // --- the outage breaker ---
  // A full failure on a reason worth retrying is an outage. For OUTAGE_MS after one, the API is not
  // called at all, so a dead endpoint costs one prompt its 4 s budget, not every prompt.
  {
    a.strictEqual(OUTAGE_MS, 60_000, 'about a minute, pinned by value');
    a.strictEqual(breakerOpen(null, 1_000), false, 'no marker, no breaker');
    a.strictEqual(breakerOpen({ t: 1_000 }, 1_000 + OUTAGE_MS - 1), true, 'inside the window');
    a.strictEqual(breakerOpen({ t: 1_000 }, 1_000 + OUTAGE_MS), false, 'the window expires');
    a.strictEqual(breakerOpen({ t: 5_000 }, 1_000), false, 'a marker from the future is a clock step, not an outage');
    a.strictEqual(breakerOpen({ t: 'x' }, 1_000), false, 'a corrupt marker reads as none');
    // What trips it, pinned by reason. A bad request or a missing key fails fast and the same way
    // every time, so there is no latency for the breaker to save.
    for (const why of ['timeout', 'http 503', 'http 429']) a.strictEqual(tripsBreaker({ mode: 'fallback', why, attempts: 3 }), true, why);
    a.strictEqual(tripsBreaker({ mode: 'fallback', why: 'fetch failed', thrown: true, attempts: 3 }), true, 'a network error');
    for (const why of ['http 400', 'http 401', 'no answers', 'no key']) a.strictEqual(tripsBreaker({ mode: 'fallback', why, attempts: 1 }), false, why);
    a.strictEqual(tripsBreaker({ mode: 'matched', attempts: 2 }), false, 'a recovery is not an outage');
    // The marker round trip, on a real file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbr-'));
    try {
      const f = path.join(dir, 'sub', 'outage.json');
      a.strictEqual(readOutage(f), null, 'an absent marker is null');
      markOutage(f, 42);
      a.deepStrictEqual(readOutage(f), { t: 42 });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    // An open breaker skips the call and says so, with 0 attempts. A short prompt still skips.
    let calls = 0;
    const never = async () => { calls += 1; throw new Error('the breaker should have skipped the call'); };
    const skipped = await route('a real task of sufficient length', books, 'k', never, { skipApi: 'api down' });
    a.deepStrictEqual([skipped.mode, skipped.why, skipped.attempts, calls], ['fallback', 'api down', 0, 0]);
    a.strictEqual(skipped.text, failNotice('api down', 0));
    a.strictEqual((await route('ok', books, 'k', never, { skipApi: 'api down' })).mode, 'skipped');
  }

  // --- every failure path must NAME the gap, never dump the index ---
  // This asserted the opposite until 2026-09-22, when the full-index fallback turned out to cost
  // more than the router saves. A failure now injects the notice and nothing else. The document
  // names are the discriminator: the old behaviour grows back one entry at a time, and any entry
  // at all is the finding.
  // The retry tests inject a tiny budget and no delay so the suite does not spend four real
  // seconds proving a timeout. `count` wraps a stub so a call count can be asserted, which is the
  // whole point of the non-retryable cases: the outcome would look identical either way.
  const TASK = 'a real task of sufficient length';
  const FAST = { budgetMs: 150, delayMs: 0 };
  const count = (fn) => { const w = (...args) => { w.n += 1; return fn(...args); }; w.n = 0; return w; };
  const timesOut = () => (_u, o) => new Promise((_r, rej) => o.signal.addEventListener('abort', () => {
    const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
  }));

  // A timeout is a failure like the rest, not an empty injection. The abort lands at once here, so
  // the attempt count does not depend on the clock. Waiting for the real abort is the budget
  // block's job, further down.
  const slow = await route(TASK, books, 'k', async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, FAST);
  for (const [f, why, attempts] of [
    [await route(TASK, books, null), 'no key', 0],
    [await route(TASK, books, 'k', async () => ({ ok: false, status: 500 }), FAST), 'http 500', 3],
    [await route(TASK, books, 'k', async () => ({ ok: true, json: async () => ({}) }), FAST), 'no answers', 1],
    [await route(TASK, books, 'k', async () => { throw new Error('boom'); }, FAST), 'boom', 3],
    [slow, 'timeout', 3],
  ]) {
    a.strictEqual(f.mode, 'fallback');
    // The reason carries through to the text, so the reader is told which failure this was.
    a.strictEqual(f.why, why);
    a.strictEqual(f.attempts, attempts, `${why} should have taken ${attempts} attempts`);
    a.strictEqual(f.text, failNotice(why, attempts), 'every failure path injects the notice');
    // And the notice says how many, so a blip and an outage do not read the same.
    a.ok(f.text.includes(`${attempts} attempt${attempts === 1 ? '' : 's'}`));
    // Pinned by name, because walking the injected text for entries it happens to hold cannot see
    // the entries a regrown fallback would add.
    for (const b of books) a.ok(!f.text.includes(b.file.replace(/\.md$/, '')),
      `a failure must not name ${b.file}`);
    a.ok(f.text.length < 400, 'the notice stays short, that is the whole point of it');
    a.ok(f.text.includes('read the runbooks folder directly') && !f.text.includes('docs/memory'),
      'and must say what to read instead');
  }

  // --- retry: a transient failure must not cost the session its routing ---
  const answers = { ok: true, json: async () => ({ answers: { [keyFor(books[0])]: { noul: 0.9 } } }) };
  const flaky = count(async () => (flaky.n === 1 ? { ok: false, status: 503 } : answers));
  const recovered = await route(TASK, books, 'k', flaky, FAST);
  a.strictEqual(recovered.mode, 'matched', 'a 503 on the first call must not become a notice');
  a.ok(recovered.text.includes('powershell'));
  a.strictEqual(recovered.attempts, 2, 'and the attempt number must survive, or a degrading API '
    + 'looks healthy from the stderr line');
  a.strictEqual(flaky.n, 2, 'it must stop calling once it has an answer');

  // Three in a row is an outage, and three is where it stops.
  const dead = count(async () => ({ ok: false, status: 503 }));
  a.strictEqual((await route(TASK, books, 'k', dead, FAST)).mode, 'fallback');
  a.strictEqual(dead.n, 3, 'exactly three attempts, no more');

  // --- a failure that cannot succeed on a second try gets exactly ONE call ---
  // Asserting the count, not the outcome: the notice looks the same whether it cost one call or
  // three, and the whole point of the distinction is the latency the user does not spend.
  for (const [label, stub] of [
    ['a 400', count(async () => ({ ok: false, status: 400 }))],
    ['a 200 with no answers', count(async () => ({ ok: true, json: async () => ({}) }))],
  ]) {
    a.strictEqual((await route(TASK, books, 'k', stub, FAST)).mode, 'fallback');
    a.strictEqual(stub.n, 1, `${label} fails the same way every time and must be tried once`);
  }
  const noKey = count(async () => answers);
  a.strictEqual((await route(TASK, books, null, noKey, FAST)).attempts, 0);
  a.strictEqual(noKey.n, 0, 'a missing key must not call out at all');
  // A 429 is the one 4xx worth retrying.
  const rate = count(async () => ({ ok: false, status: 429 }));
  await route(TASK, books, 'k', rate, FAST);
  a.strictEqual(rate.n, 3, 'a 429 is rate limiting, not a malformed request');

  // --- the budget bounds the whole sequence, not each attempt ---
  // A short injected budget rather than a real one, so this costs 150ms and not 4 seconds.
  //
  // ⚠ WALL TIME ON A BUSY MACHINE CARRIES PAUSES THAT ARE NOT THE ROUTER'S (#22). Measured
  // 2026-09-29 with 32 CPU-bound processes on 16 cores: a 150 ms budget took 153 ms at best and
  // 341 ms at worst, and late timers used up the last share, leaving two attempts rather than
  // three. That is the budget holding, so this block asks for at least two, and the clock-free
  // timeout case above pins three. Each timing takes up to three runs and keeps the first that
  // meets its bound. The regressions this guards fail every run, not some: a per-attempt timeout
  // that ignores the budget takes three budgets, and a first attempt that eats the budget leaves
  // one attempt.
  const timed = async (opts, fits) => {
    let run;
    for (let i = 0; i < 3; i++) {
      const stub = count(timesOut());
      const t = Date.now();
      const r = await route(TASK, books, 'k', stub, opts);
      run = { r, n: stub.n, ms: Date.now() - t };
      if (fits(run)) break;
    }
    return run;
  };
  const over = await timed(FAST, (x) => x.n >= 2 && x.ms < FAST.budgetMs + 150);
  a.strictEqual(over.r.why, 'timeout');
  a.ok(over.n >= 2 && over.n <= 3, `the first attempt must not eat the whole budget, took ${over.n} attempts`);
  a.ok(over.ms < FAST.budgetMs + 150, `three attempts must fit the budget, took ${over.ms}ms`);
  // Each attempt's timeout is derived from the budget rather than declared beside it, so there is
  // no second constant to drift. Halving the budget halves the time spent.
  const smaller = await timed({ budgetMs: 60, delayMs: 0 }, (x) => x.ms < over.ms);
  a.ok(smaller.ms < over.ms, `a smaller budget must actually spend less time, took ${smaller.ms}ms against ${over.ms}ms`);

  // --- a short prompt is the one deliberate "less than before", and must never call out ---
  let called = false;
  const shortRes = await route('ok', books, 'k', async () => { called = true; return { ok: true, json: async () => ({}) }; });
  a.strictEqual(shortRes.mode, 'skipped');
  a.strictEqual(shortRes.text, '', 'a continuation injects nothing');
  a.strictEqual(called, false, 'and costs no API call');
  // The boundary itself: 11 chars skips, 12 chars routes. Whitespace does not buy length.
  // A key is required throughout, because the no-key check sits ahead of the length check and
  // would otherwise answer 'fallback' for reasons that have nothing to do with length.
  const boom = async () => { throw new Error('the length gate should have returned first'); };
  a.strictEqual((await route('12345678901', books, 'k', boom)).mode, 'skipped');
  a.strictEqual((await route('   ok   ', books, 'k', boom)).mode, 'skipped');
  a.strictEqual((await route('123456789012', books, 'k', async () => ({ ok: true, json: async () => ({}) })).then((r) => r.mode)),
    'fallback', '12 chars is long enough to get past the gate and reach the API');

  // --- the happy path injects only the hits ---
  const okRes = await route('write a powershell script', books, 'k', async () => ({
    ok: true,
    json: async () => ({ answers: { [keyFor(books[0])]: { noul: 0.9 },
      [keyFor(books[1])]: { noul: 0.1 } } }),
  }));
  a.strictEqual(okRes.mode, 'matched');
  a.ok(okRes.text.includes('powershell'));
  a.ok(!okRes.text.includes('secret-transfer'), 'a non-match must not be injected');
  // A missing answer scores 0 rather than passing the threshold.
  const partial = await route('something long enough to match', books, 'k', async () => ({
    ok: true, json: async () => ({ answers: {} }),
  }));
  a.strictEqual(partial.mode, 'matched');
  a.strictEqual(partial.text, '', 'no answers means no matches, and an empty injection is correct here');
  // Pinned by value, and the set changed on 2026-09-22: procedures joined, which let
  // index.mjs stop pushing all 43 of them at every SessionStart. Deliberately still an
  // exact set rather than a "has procedure" check, because the two types NOT here are the finding.
  // A postmortem or a residual routing on a live prompt would hand the session a dead process with
  // a relevance score on it, which is what their SessionStart tombstone lines exist to prevent.
  a.deepStrictEqual([...RB_KEEP].sort(), ['procedure', 'reference', 'standard']);
  // ⚠ narrow() on a corpus larger than the shortlist, not the two-document fixture. That one
  // returns early on `books.length <= n` and would pass while the shortlist was broken, which is
  // the one thing this check exists to catch. Fixed in memory, so the check runs the same with no
  // runbooks folder at all (CI) and with a large one: 37 fillers, one lexically obvious match, and
  // two standards that share no word with the prompt.
  {
    const corpus = [
      ...Array.from({ length: 37 }, (_, i) => ({ file: `filler-${i}.md`, type: i % 2 ? 'reference' : 'procedure',
        purpose: `Notes on topic${i} and subject${i}.` })),
      { file: 'torrent-vpn-netns.md', type: 'procedure',
        purpose: 'Fix a torrent client that stopped downloading after the vpn container restarted.' },
      { file: 'key-handling.md', type: 'standard', purpose: 'Keep credentials out of chat transcripts.' },
      { file: 'shell-quoting.md', type: 'standard', purpose: 'Quote strings carefully in shell scripts.' },
    ];
    const stds = corpus.filter((b) => b.type === 'standard');
    const got = narrow('torrent client stopped downloading after I restarted the vpn container', corpus);
    a.ok(got.length < corpus.length, 'narrow must actually narrow');
    // Pinned by name, not by count: a standard dropped on vocabulary is the measured failure
    // (a credentials standard shares no word with a token prompt and BM25 ranks it far down).
    for (const s of stds) a.ok(got.includes(s), `every standard rides along, missing ${s.file}`);
    a.ok(got.some((b) => b.file.includes('torrent')),
      'the lexically obvious document must survive the shortlist');
    a.ok(got.length <= SHORTLIST + stds.length, 'the shortlist is bounded');
  }
  // --- the double-fire guard ---
  // Pinned by value, because every field of the key is load-bearing. A guard that keys on the
  // prompt alone would swallow the same question asked in a second session, and one that keys on
  // the session alone would swallow every prompt after the first.
  {
    const h = 'abc';
    a.strictEqual(isDuplicate(h, 1_000, null), false, 'nothing seen yet is not a duplicate');
    a.strictEqual(isDuplicate(h, 1_000, { promptHash: h, t: 999 }), true, 'same hash, 1ms apart');
    a.strictEqual(isDuplicate(h, 1_000, { promptHash: 'xyz', t: 999 }), false, 'a different prompt routes');
    a.strictEqual(isDuplicate(h, 1_000 + DEDUPE_MS, { promptHash: h, t: 1_000 }), false, 'the window expires');
    // The field name is load-bearing, not cosmetic: an output-redaction guard blocks a `key` holding
    // 8+ opaque characters, so a state file written with that name blocks the tool call that
    // prints it. Pinned by value so a rename back is caught here rather than mid-session.
    a.deepStrictEqual(Object.keys(dedupeRecord(h, 1)), ['promptHash', 't'],
      'the dedupe record never uses a credential-named field');
  }
  // --- the Codex envelope ---
  // Pinned by value at every level. Codex drops stdout it cannot parse into this exact shape
  // without printing a reason, so a misspelt key is a router that silently matches nothing on
  // one harness while still working on the other. `UserPromptSubmit` is the event name Codex
  // sends and the one it expects back, taken from captured Codex hook payloads.
  {
    const env = codexEnvelope('BLOCK');
    a.deepStrictEqual(Object.keys(env), ['hookSpecificOutput']);
    a.deepStrictEqual(env.hookSpecificOutput,
      { hookEventName: 'UserPromptSubmit', additionalContext: 'BLOCK' });
  }
  // --- readKey, the same match as jevtools/scripts/lib.mjs ---
  // Unanchored, a commented old line or a quoted value won and every prompt got a 401. Dummy
  // strings only, checked with a.ok so a failure never prints a value, and the file is injected so
  // the real ~/.jev.env is never read.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbr-key-'));
    const kf = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
    const V = 'OPENROUTER_API_KEY';
    try {
      a.ok(readKey({}, kf('commented', `# ${V}=stale-old\n${V}=dummy-live\n`)) === 'dummy-live', 'a commented earlier line is skipped');
      a.ok(readKey({}, kf('double', `${V}="dummy-double"\n`)) === 'dummy-double', 'double quotes are stripped');
      a.ok(readKey({}, kf('single', `${V}='dummy-single'\n`)) === 'dummy-single', 'single quotes are stripped');
      a.ok(readKey({}, kf('export', `  export ${V}=dummy-export\r\n`)) === 'dummy-export', 'an export prefix, indented, with CRLF');
      a.ok(readKey({}, kf('suffix', `OLD_${V}=dummy-suffix\n`)) === null, 'a longer name ending in the same text is not the key');
      a.ok(readKey({ [V]: 'dummy-env' }, kf('env', `${V}=dummy-file\n`)) === 'dummy-env', 'the env var takes precedence');
      a.ok(readKey({}, path.join(dir, 'absent')) === null, 'a missing file gives null');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

// ⚠ A PIPE LEFT OPEN MUST NOT HANG THE HOOK. The hook reads its payload from stdin, and a caller
// that never closes it used to hold the router until the harness killed it at 15 s. The deadline
// is index.mjs's readInput, 500 ms. Home and cwd are an empty temp dir, so there is no runbooks
// folder and no key file, and the run ends silently after the read: nothing is posted.
test('the hook ends on its stdin deadline when stdin is never closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbr-stdin-'));
  const router = fileURLToPath(new URL('../scripts/router.mjs', import.meta.url));
  // The temp dir can sit inside a git repo (a home folder under git), so git is stopped above it.
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, OPENROUTER_API_KEY: '', GIT_CEILING_DIRECTORIES: path.dirname(dir) };
  const t0 = Date.now();
  const child = spawn(process.execPath, [router], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const killer = setTimeout(() => child.kill(), 10_000);
  const code = await new Promise((r) => child.on('close', r));
  clearTimeout(killer);
  const ms = Date.now() - t0;
  child.stdin.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(code, 0, `the hook exits 0 rather than being killed, after ${ms} ms`);
  assert.ok(ms < 5_000, `and inside the deadline plus start-up, took ${ms} ms`);
  assert.strictEqual(out, '', 'with no runbooks folder it injects nothing');
});

// The `prefix` field is gone (#37). It was left over from two corpora, so every key still reads
// `rb_`, which is what the recorded run files and check.mjs's lookups expect.
test('keys read rb_ with no prefix on the entry, and loadCorpus takes no prefix', async () => {
  const { keyFor, loadCorpus, parse, RB_KEEP } = await import('../scripts/router.mjs');
  assert.strictEqual(keyFor({ file: 'shell-quoting.md' }), 'rb_shell_quoting_md');
  assert.strictEqual(keyFor({ file: 'sub/Key Handling.md' }), 'rb_sub_key_handling_md');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbr-prefix-'));
  try {
    fs.writeFileSync(path.join(dir, 'live.md'), '**Type:** standard\n**Purpose:** Still true.');
    const out = loadCorpus(dir, parse, RB_KEEP);
    assert.deepStrictEqual(out.map((x) => x.file), ['live.md']);
    assert.ok(!Object.hasOwn(out[0], 'prefix'), 'no prefix rides on the entry');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// #102. One shared dedupe.json let another session's prompt overwrite the record between this
// session's two hook copies, so the second copy routed and injected again. Each session now has
// its own file, and a first write in a session prunes files a day old.
test('dedupe is per session: interleaved claims still drop each duplicate copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-dedupe-'));
  try {
    const t = 1_000_000;
    assert.strictEqual(claimPrompt('sess-A', 'deploy the app', { dir, now: t }), true, 'A copy 1 routes');
    assert.strictEqual(claimPrompt('sess-B', 'fix the backup', { dir, now: t + 5 }), true, 'B copy 1 routes');
    assert.strictEqual(claimPrompt('sess-A', 'deploy the app', { dir, now: t + 10 }), false, 'A copy 2 is dropped');
    assert.strictEqual(claimPrompt('sess-B', 'fix the backup', { dir, now: t + 15 }), false, 'B copy 2 is dropped');
    assert.strictEqual(claimPrompt('sess-A', 'next task', { dir, now: t + 20 }), true, 'a new prompt in A routes');
    assert.notStrictEqual(dedupeFile('sess-A', dir), dedupeFile('sess-B', dir), 'one file per session');
    assert.match(path.basename(dedupeFile('sess-A', dir)), /^dedupe-[0-9a-f]{12}\.json$/);
    assert.strictEqual(fs.readdirSync(dir).length, 2, 'two sessions, two files');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dedupe prunes day-old session files and the legacy shared file, and keeps fresh ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-dedupe-'));
  try {
    const now = Date.now();
    const old = new Date(now - DEDUPE_KEEP_MS - 60_000);
    for (const name of ['dedupe-aaaaaaaaaaaa.json', 'dedupe.json']) {
      fs.writeFileSync(path.join(dir, name), '{}');
      fs.utimesSync(path.join(dir, name), old, old);
    }
    fs.writeFileSync(path.join(dir, 'dedupe-bbbbbbbbbbbb.json'), '{}');
    fs.writeFileSync(path.join(dir, 'outage.json'), '{}');
    fs.utimesSync(path.join(dir, 'outage.json'), old, old);
    assert.strictEqual(DEDUPE_KEEP_MS, 86_400_000, 'a day, pinned by value');
    claimPrompt('sess-C', 'a prompt', { dir, now });
    assert.deepStrictEqual(fs.readdirSync(dir).sort(),
      ['dedupe-bbbbbbbbbbbb.json', path.basename(dedupeFile('sess-C', dir)), 'outage.json'].sort(),
      'only day-old dedupe files go, and nothing else in the state dir');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('route names the files it injected and the top scores under the bar', async (t) => {
  process.env.JEV_SPEND_DISABLED = '1';
  t.after(() => { delete process.env.JEV_SPEND_DISABLED; });
  const books = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => ({ file: `${n}.md`, type: 'reference', purpose: `About ${n}.` }));
  const scores = { a: 0.91, b: 0.85, c: 0.79, d: 0.4, e: 0.3, f: 0.2, g: 0.1 };
  const answers = Object.fromEntries(books.map((b) => [keyFor(b), { noul: scores[b.file[0]] }]));
  const stub = async () => ({ ok: true, status: 200, json: async () => ({ answers }) });
  const r = await route('a real task of sufficient length', books, 'k', stub, { narrow: false });
  assert.strictEqual(r.mode, 'matched');
  assert.strictEqual(r.hits, 2);
  assert.deepStrictEqual(r.files, ['a.md', 'b.md']);
  assert.strictEqual(RANKED_N, 5);
  assert.deepStrictEqual(r.ranked, [
    { file: 'a.md', p: 0.91 }, { file: 'b.md', p: 0.85 }, { file: 'c.md', p: 0.79 },
    { file: 'd.md', p: 0.4 }, { file: 'e.md', p: 0.3 }]);
});
