// jevclick's offline tests, moved out of the script's --selftest branch. Invented data only, and the
// failure test redirects the Jev endpoint to a stub on localhost, so nothing is sent or spent.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXIT_CALL_FAILED, PAGE_CHECKS, askPage, buildState, fromT3, parseSnapshot, snapshotText, toCriteria } from './jevclick.mjs';

// The child CLI runs answer from a stub and must not enter the live spend ledger.
process.env.JEV_SPEND_DISABLED = '1';
const JEVCLICK = fileURLToPath(new URL('./jevclick.mjs', import.meta.url));

test('snapshot parsing, the state budget and T3 snapshots', () => {
  const snap = [
    '- generic [ref=e1]',
    '  - button "Accept all cookies" [ref=e2]',
    '  - button "Manage preferences" [ref=e3]',
    '  - link "Privacy policy" [ref=e4]',
    '  - text "We use cookies"',
    '  - button [ref=e9]',
    '  - textbox "Search" [ref=e5]',
  ].join('\n');
  const els = parseSnapshot(snap);
  // generic and text are excluded; the five real controls survive.
  assert.deepStrictEqual(els.map((e) => e.ref), ['e2', 'e3', 'e4', 'e9', 'e5']);
  assert.strictEqual(els[0].label, 'button: Accept all cookies');
  // An unnamed button is KEPT and labelled, not dropped: dropping it hides that the right answer
  // may not be in the list.
  assert.strictEqual(els[3].label, 'button: (no accessible name)');
  assert.strictEqual(els.filter((e) => !e.name).length, 1);
  // A line with no ref cannot be clicked and must not become an option.
  assert.deepStrictEqual(parseSnapshot('- button "Ghost"'), []);
  assert.deepStrictEqual(parseSnapshot(''), []);
  assert.deepStrictEqual(parseSnapshot(null), []);
  // Duplicate refs get distinct keys, or two options collapse into one and the answer cannot map
  // back to an element.
  const dup = toCriteria([{ ref: 'e1', label: 'button: Edit' }, { ref: 'e1', label: 'button: Edit' }]);
  assert.strictEqual(Object.keys(dup).length, 2);
  assert.deepStrictEqual(Object.keys(dup), ['e1', 'e1_1']);
  // Every criteria key maps back to a ref by stripping the suffix.
  for (const k of Object.keys(dup)) assert.strictEqual(k.replace(/_\d+$/, ''), 'e1');

  // --- state building ---
  // Scaffolding is stripped: a ref, a cursor hint and a /url child are cost with no meaning.
  const st = snapshotText('- button "Go" [ref=e2] [cursor=pointer]:\n  - /url: /x\n  - text "hi"\n\n');
  assert.strictEqual(st, '- button "Go":\n  - text "hi"');
  assert.strictEqual(snapshotText(null), '');

  // ⚠ THE CONTROLS SURVIVE THE BUDGET, THE PAGE TEXT DOES NOT. This is the whole rule. A trimmed
  // control is an answer the model cannot give, and nothing in the output would say the right
  // answer had been removed; trimmed page text only ever costs a judgement some accuracy.
  const many = Array.from({ length: 40 }, (_, i) => ({ ref: `e${i}`, label: `button: Control number ${i}` }));
  const tiny = buildState('do the thing', many, 'PAGE TEXT'.repeat(500), 1200);
  for (const e of many) assert.ok(tiny.state.includes(e.label), `control dropped: ${e.label}`);
  assert.ok(tiny.truncated, 'the text was cut and must say so');
  // A budget the controls alone already blow leaves no room, and page text is dropped entirely
  // rather than the controls being cut to make space.
  const none = buildState('g', many, 'PAGE', 50);
  assert.ok(none.state.includes('Control number 39'), 'controls survive an impossible budget');
  assert.strictEqual(none.textChars, 0);
  assert.strictEqual(none.truncated, true, 'text existed and none of it fits, which is truncation');
  // Under budget, nothing is cut and nothing claims to have been.
  const room = buildState('g', [{ ref: 'e1', label: 'button: Go' }], 'short text', 24_000);
  assert.strictEqual(room.truncated, false);
  assert.ok(room.state.includes('short text'));
  // No page text asked for is not truncation either: that is the cheap controls-only path.
  assert.deepStrictEqual(buildState('g', [{ ref: 'e1', label: 'button: Go' }], null).truncated, false);

  // The standard pack is nouls, which carry no confidence field. Pinned by value because routing
  // on a confidence that does not exist reads as 0 and would hold on every page.
  for (const [k, q] of Object.entries(PAGE_CHECKS)) assert.strictEqual(q.type, 'noul', `${k} must be a noul`);
  assert.ok(Object.keys(PAGE_CHECKS).length >= 4);

  // --- T3 Code snapshots ---
  const t3 = fromT3(JSON.stringify({
    visibleText: 'Example Domain\n\nSay "hi"',
    interactiveElements: [
      { tag: 'a', role: null, name: 'Learn more', selector: 'body > a', x: 10, y: 20, width: 80, height: 20 },
      { tag: 'div', role: 'button', name: 'Close "x"', selector: '#close', x: 0, y: 0, width: 10, height: 10 },
      { tag: 'button', role: null, name: '', selector: '#icon', x: 0, y: 0, width: 0, height: 0 },
      { tag: 'custom-el', role: null, name: 'Odd', selector: '#odd', x: 0, y: 0, width: 0, height: 0 },
      { tag: 'a', role: null, name: 'see [ref=zz]', selector: '#trap', x: 0, y: 0, width: 0, height: 0 },
    ],
  }));
  const t3els = parseSnapshot(t3.snapshot);
  // Every element survives, a null role takes its tag's role, and an unknown tag stays a candidate.
  assert.deepStrictEqual(t3els.map((e) => e.label),
    ['link: Learn more', "button: Close 'x'", 'button: (no accessible name)', 'button: Odd', 'link: see (ref=zz)']);
  // A literal `[ref=` in a name must not hijack the element's own ref.
  assert.deepStrictEqual(t3els.map((e) => e.ref), ['t0', 't1', 't2', 't3', 't4']);
  assert.deepStrictEqual(t3.targets.t0, { selector: 'body > a', x: 50, y: 30 });
  assert.ok(snapshotText(t3.snapshot).includes("Say 'hi'"), 'visible text reaches the page state');
  // Playwright YAML and non-snapshot JSON are not T3.
  assert.strictEqual(fromT3('- button "Go" [ref=e1]'), null);
  assert.strictEqual(fromT3('{"url":"x"}'), null);
});

test('a 200 with no answers holds, and a failed call is one line and exit 3', async () => {
  const snap = '- button "Accept all cookies" [ref=e2]\n- button "Manage preferences" [ref=e3]';
  // A 200 with no answers must not throw a TypeError: it is a pick with no confidence, so a hold.
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ usage: { cost: 0 } }), { status: 200 });
    const r = await askPage(snap, 'accept', 'k', { checks: { q: { type: 'noul', instructions: 'i' } } });
    assert.deepStrictEqual([r.ref, r.act, r.confidence, r.checks], [null, false, 0, { q: null }]);
  } finally {
    globalThis.fetch = realFetch;
  }

  // ⚠ A FAILED CALL IS ONE LINE AND EXIT 3, not a Node stack and not exit 2. Exit 2 is HOLD, and a
  // caller that reads 2 as "look at the page yourself" must never get it for an outage.
  const server = http.createServer((req, res) => { req.resume(); res.writeHead(503).end('upstream busy'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const stubUrl = `http://127.0.0.1:${server.address().port}/`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevclick-'));
  const snapFile = path.join(dir, 'snap.yml');
  fs.writeFileSync(snapFile, snap);
  const mock = `const real = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (!String(url).startsWith('https://openrouter.ai/')) throw new Error('unexpected host ' + url);
  return real(${JSON.stringify(stubUrl)}, init);
};`;
  try {
    for (const json of [false, true]) {
      const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(mock)}`,
        JEVCLICK, '--snapshot', snapFile, '--goal', 'accept', ...(json ? ['--json'] : [])],
      { env: { ...process.env, OPENROUTER_API_KEY: 'dummy-not-a-key' } });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const code = await new Promise((r) => child.on('close', r));
      assert.strictEqual(code, EXIT_CALL_FAILED, `a 503 exits ${EXIT_CALL_FAILED}${json ? ' with --json' : ''}: ${err}`);
      assert.match(err, /^jevclick: the Jev call failed: HTTP 503: upstream busy\r?\n$/, 'in one line, with no stack');
      assert.strictEqual(out, '', 'and prints no pick');
    }
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
