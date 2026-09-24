#!/usr/bin/env node
// Pick which element to click, without the page snapshot entering a Claude context.
//
// THE LOOP. Playwright's browser_snapshot returns an accessibility tree, which is text and often
// very large. Today Claude reads all of it to decide on one click. Instead: parse the tree in code,
// hand Jev the interactive elements as a Choice, click the ref it returns.
//
// MEASURED 2026-09-22 (scripts/jev-sweep/exp-choice-scale.mjs): 9/9 correct at 5, 12, 25, 50 and
// 100 options, median 345ms at every count, confidence 0.99-1.00, no option cap reached. So a whole
// page of candidates can go in one call.
//
// ⚠ NO IMAGE SUPPORT TODAY (TypeSafe have it planned). This reads the accessibility tree only, so
// an element with no accessible name is invisible to it — see UNNAMED below.
//
//   node jevclick.mjs --snapshot snap.txt --goal "accept the cookie banner"
//   node jevclick.mjs --snapshot snap.txt --goal "..." --json   # machine-readable, for an agent loop
//   node jevclick.mjs --snapshot snap.yml --goal "..." --ask            # + the standard page checks
//   node jevclick.mjs --snapshot snap.yml --goal "..." --questions q.json # + your own vocabulary
//   node jevclick.mjs --selftest

import fs from 'node:fs';
import assert from 'node:assert';
import { askJev, readKey } from './lib.mjs';

// Confidence below this means "do not act". Chosen from the measured confidence-versus-agreement
// curve: 0.95+ agreed 98.4% of the time, 0.80-0.95 was 88.9%, below 0.80 was a coin flip. A wrong
// click is not a wrong tag — it can submit a form — so the bar sits at the top band.
const ACT_ABOVE = 0.95;

// ⚠ CONFIDENCE DOES NOT PROTECT YOU FROM A VAGUE GOAL. Tested on the same 16-element basket page:
// "complete the purchase and pay now" picked `Place order and pay` at 0.980, and the deliberately
// vague "deal with the basket" picked `View cart` at 0.960. The second is a defensible reading, but
// 0.96 reflects certainty about its own interpretation, not that the interpretation was the one
// intended. It is the same shape as the context-sufficiency finding in system-one-models.md: the
// model is sure about what it was given. The caller owns goal specificity; a high confidence here
// is not evidence the goal was clear.

// Playwright's snapshot lines look like:
//   - button "Sign in" [ref=e17]
//   - textbox "Email" [ref=e12]
//   - link "Privacy policy" [ref=e44] [cursor=pointer]
// Only roles a click makes sense on. `generic` and `text` are excluded deliberately: they are most
// of a tree by volume and clicking them does nothing.
const CLICKABLE = /^\s*-\s*(button|link|menuitem|tab|checkbox|radio|switch|option|combobox|textbox|searchbox|slider)\b/;
const REF = /\[ref=([^\]]+)\]/;
const NAME = /"([^"]*)"/;

export function parseSnapshot(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!CLICKABLE.test(line)) continue;
    const ref = line.match(REF)?.[1];
    if (!ref) continue;
    const role = line.match(/^\s*-\s*(\w+)/)?.[1] ?? 'element';
    const name = line.match(NAME)?.[1] ?? '';
    // ⚠ UNNAMED elements are kept, not dropped. An icon-only button with no accessible name is
    // exactly the case a text-only model struggles with, and silently removing it would make the
    // candidate list look complete when the right answer is missing from it. Labelled so the
    // caller can see how many there are.
    out.push({ ref, role, name, label: name ? `${role}: ${name}` : `${role}: (no accessible name)` });
  }
  return out;
}

// Duplicate labels are common ("Edit" x9 in a table) and a Choice is keyed by option name, so two
// identical keys would collapse into one and the answer could not be mapped back to a ref.
export function toCriteria(elements) {
  const crit = {};
  const used = new Map();
  for (const e of elements) {
    // The suffix is the count SEEN SO FAR, so the second e1 becomes e1_1 rather than e1_2.
    const n = used.get(e.ref) ?? 0;
    const key = n === 0 ? e.ref : `${e.ref}_${n}`;
    used.set(e.ref, n + 1);
    crit[key] = e.label;
  }
  return crit;
}

// --- asking the page more than one thing ---
//
// WHY THIS EXISTS. Asking only "what do I click" wastes the call. Measured in limits.mjs: 1
// question is 377ms and $0.000035, 30 questions are 336ms and $0.000051. Questions are free and
// the STATE is what costs, so a loop that makes one call per decision is paying the page over and
// over to learn one thing each time.
//
// ⚠ THE CHECKS ARE NOT FREE, AND IT IS THE STATE THAT IS WHY. A question about an error banner
// cannot be answered from a list of buttons, so asking one means sending the page text as well as
// the controls, and the text is what costs. MEASURED, not estimated, on the 991-line Wikipedia
// snapshot 2026-09-22: click alone $0.000213 in 570ms; click plus these four $0.000441 in 1,049ms,
// with the state capped at 24,038 chars by the budget. Twice the money and twice the clock for
// five times the information, so ask everything you will want in one call rather than two.
//
// The first version of this comment said $0.0019, derived from the raw 56,818-char tree at the
// measured per-character rate. That was wrong by 4x because the budget truncates before sending.
// Kept as a note because deriving a cost from a rate card is exactly how the two wrong monthly
// figures in this project happened.
export const PAGE_CHECKS = {
  blocked: { type: 'noul', instructions: 'This page is a login wall, a captcha, a consent gate or a rate-limit block, rather than the content that was wanted' },
  error: { type: 'noul', instructions: 'This page is showing an error message or a banner saying an action failed' },
  loading: { type: 'noul', instructions: 'This page is still loading: it shows a spinner, a skeleton placeholder or no real content yet' },
  formIncomplete: { type: 'noul', instructions: 'This page has a form on it with required fields that are not yet filled in' },
};

// The controls ALWAYS go in whole, and the page text takes whatever budget is left.
//
// That order is load-bearing rather than arbitrary. The controls are the answer space for the click
// Choice: trim one away and the model cannot pick it, and nothing in the output would say the right
// answer had been removed. Page text only ever informs a judgement, so losing its tail costs
// accuracy on the checks and never makes a click impossible.
//
// Jev's window is 32K tokens and the budget is in CHARACTERS, deliberately conservative. A tail is
// dropped rather than a head because a page's identity (title, heading, error banner) is at the
// top, which is the opposite of a log file.
export function buildState(goal, elements, pageText, budget = 24_000) {
  const controls = elements.map((e) => e.label).join('\n');
  const head = `A web agent is operating a page. Its goal: ${goal}\n\nControls on the page:\n${controls}`;
  const room = budget - head.length;
  if (room <= 0 || !pageText) return { state: head, truncated: !!pageText, textChars: 0 };
  const text = String(pageText);
  const kept = text.length <= room ? text : `${text.slice(0, room)}\n[page text truncated]`;
  return { state: `${head}\n\nPage content:\n${kept}`, truncated: kept.length < text.length, textChars: kept.length };
}

// Everything the snapshot says, minus the scaffolding: refs, cursor hints and url children carry no
// meaning for a judgement and are pure cost.
export function snapshotText(snapshot) {
  return String(snapshot ?? '').split('\n')
    .filter((l) => !/^\s*-\s*\/url:/.test(l))
    .map((l) => l.replace(/\s*\[ref=[^\]]+\]/g, '').replace(/\s*\[cursor=[^\]]+\]/g, '').trimEnd())
    .filter((l) => l.trim())
    .join('\n');
}

// One call, one page, every question the caller has. `checks` defaults to the standard pack;
// pass {} for the controls-only cheap path. `extra` is the caller's own vocabulary and is where
// this stops being a click picker: "which option means my answer", "which row is the invoice",
// "did the upload finish". Anything answerable about ONE page in isolation belongs here.
//
// ⚠ What does NOT belong: anything comparing two pages or two rows. It judges one state at a time,
// so cross-item work stays in code. That is the same defeat documented in system-one-models.md.
export async function askPage(snapshot, goal, key, opts = {}) {
  const { actAbove = ACT_ABOVE, checks = PAGE_CHECKS, extra = {}, budget = 24_000 } = opts;
  const elements = parseSnapshot(snapshot);
  if (!elements.length) return { ref: null, reason: 'no clickable elements in the snapshot', elements: 0 };
  const criteria = toCriteria(elements);
  const asksPageQuestions = Object.keys(checks).length > 0 || Object.keys(extra).length > 0;
  // ⚠ Never send an empty or near-empty state: given nothing to read Jev answers from a prior
  // (measured mean 0.48 on an empty string), so a blank page would produce a confident click.
  const { state, truncated, textChars } = buildState(
    goal, elements, asksPageQuestions ? snapshotText(snapshot) : null, budget);
  const questions = {
    click: { type: 'choice', instructions: `Which element should be clicked to: ${goal}`, criteria },
    ...checks,
    ...extra,
  };
  const { answers, cost } = await askJev(state, questions, key);
  const a = answers.click ?? {};
  const conf = a.confidence ?? 0;
  const chosen = elements.find((e) => e.ref === String(a.choice).replace(/_\d+$/, ''));
  const runnerUp = Object.entries(a.probabilities ?? {})
    .filter(([k]) => k !== a.choice).sort((x, y) => y[1] - x[1])[0];
  const named = Object.keys({ ...checks, ...extra });
  return {
    ref: conf >= actAbove ? chosen?.ref ?? null : null,
    candidate: chosen?.ref ?? null,
    label: chosen?.label ?? null,
    confidence: conf,
    act: conf >= actAbove,
    runnerUp: runnerUp ? { label: criteria[runnerUp[0]], p: runnerUp[1] } : null,
    unnamed: elements.filter((e) => !e.name).length,
    elements: elements.length,
    // Nouls only, so these are 0-1 with NO confidence field. A value near 0.5 means torn, which is
    // not the same as unsure — see system-one-models.md before routing on it.
    checks: Object.fromEntries(named.map((k) => [k, answers[k]?.noul ?? answers[k] ?? null])),
    stateChars: state.length,
    textTruncated: truncated,
    textChars,
    cost,
  };
}

// The cheap path: the click and nothing else, so the state is the control list alone and the call
// costs about $0.0002 instead of $0.0019. Kept as its own name because it is the right call inside
// a tight loop that already knows the page is healthy. If you are going to look at the result and
// wonder whether the page errored, you wanted askPage and should have paid the fifth of a cent.
export const pickElement = (snapshot, goal, key, opts = {}) =>
  askPage(snapshot, goal, key, { ...opts, checks: {}, extra: {} });

export function selftest() {
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
  return 'jevclick selftest OK';
}

if (process.argv.includes('--selftest')) { console.log(selftest()); process.exit(0); }

const opt = (n) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? null : process.argv[i + 1]; };
const key = readKey();
if (!key) { console.error('no OPENROUTER_API_KEY in the environment and none in ~/.jev.env'); process.exit(1); }
const snapPath = opt('snapshot');
const goal = opt('goal');
if (!snapPath || !goal) { console.error('--snapshot <file> and --goal "..." required'); process.exit(1); }

// --ask turns on the standard page checks, --questions adds the caller's own vocabulary. Both send
// the page text, so both cost about $0.0019 instead of $0.0002. Neither is on by default: a loop
// that wants only the click should not be charged for the page.
const custom = opt('questions') ? JSON.parse(fs.readFileSync(opt('questions'), 'utf8')) : {};
const wantsChecks = process.argv.includes('--ask') || Object.keys(custom).length > 0;
const res = await askPage(fs.readFileSync(snapPath, 'utf8'), goal, key,
  { checks: wantsChecks ? PAGE_CHECKS : {}, extra: custom });
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(res));
  // ⚠ exitCode, NEVER process.exit(), and this is not style. The HTTP socket from the call above is
  // still closing, and process.exit() tears the event loop down under it: on Windows libuv aborts
  // with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and the process ends 127. That
  // happens AFTER the JSON has printed, so the pick was correct and the caller sees a crash anyway
  // — which is the worst shape a failure can take in an agent loop, because the output looks fine.
  // Measured on a 990-line Wikipedia snapshot, 2026-09-22: exit 127 with process.exit, 0 without.
  process.exitCode = res.ref ? 0 : 2;
} else {

console.log(`  candidates     ${res.elements}${res.unnamed ? ` (${res.unnamed} with no accessible name)` : ''}`);
console.log(`  pick           ${res.label ?? '(none)'}  [${res.candidate ?? '-'}]`);
console.log(`  confidence     ${res.confidence.toFixed(3)}`);
if (res.runnerUp) console.log(`  runner-up      ${res.runnerUp.label} (p=${res.runnerUp.p.toFixed(2)})`);
for (const [k, v] of Object.entries(res.checks ?? {})) {
  // A noul has no confidence, so 0.5 is TORN and not "unsure". Flagged rather than silently read
  // as a no, because torn is the answer most worth a human's eye.
  const torn = typeof v === 'number' && v > 0.35 && v < 0.65 ? '  <- torn, read the page' : '';
  console.log(`  ${k.padEnd(14)} ${typeof v === 'number' ? v.toFixed(2) : String(v)}${torn}`);
}
console.log(`  state          ${res.stateChars} chars${res.textTruncated ? ' (page text truncated)' : ''}`);
console.log(`  cost           $${(res.cost ?? 0).toFixed(6)}`);
console.log(res.act
  ? `\n  ACT: click ${res.ref}`
  : `\n  HOLD: confidence ${res.confidence.toFixed(2)} is below ${ACT_ABOVE}. Hand the snapshot to `
    + 'Claude rather than clicking — this is the ambiguous-page case the fixture could not cover.');
}
