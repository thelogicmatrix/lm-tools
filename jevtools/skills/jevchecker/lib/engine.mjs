// The check types and what gets shown. Thresholds here control SURFACING and ordering only.
// Nothing in this file asserts anything: a surfaced chunk is "worth reading", never "wrong".
import { chunk as chunkBody } from './chunk.mjs';
import { askJev, runPool } from '../../../scripts/lib.mjs';

// The torn band for a noul. A noul has no confidence field, so distance from 0.5 is the only proxy
// available, and it says the model is TORN rather than unsure. Those are different things, which is
// why torn is reported as its own group instead of being folded into a pass.
//
// 0.25-0.75 IS A JUDGEMENT CALL AND NOTHING MEASURED IT. It is not derived from
// the JD escalation CLI in the author's private tree, whose band (v in 0.1 to 0.9) answers a different question. Widen or
// narrow these two numbers on what the torn group actually turns out to contain.
const TORN_LOW = 0.25;
const TORN_HIGH = 0.75;

export const regexChecks = (sweep) => (sweep?.checks ?? []).filter((c) => c.type === 'regex');
export const modelChecks = (sweep) => (sweep?.checks ?? []).filter((c) => c.type !== 'regex');

// ⚠ A regex check NEVER reaches the model. Sending "does this contain an em dash" to a judgement
// model is the mistake a job-board prefilter's header documents at length: a rule with no
// judgement in it belongs in code, where it is free, exact and reproducible.
export function runRegex(chunks, check) {
  // No flags knob on purpose. A `g` flag makes `re.test` stateful through `lastIndex`, so it would
  // skip every second matching chunk inside this filter and return a short hit list indistinguishable
  // from a cleaner body. Put what you need in the pattern instead of adding the option back.
  const re = new RegExp(check.pattern);
  const wantPresent = check.must === 'present';
  // A hit is a chunk that does NOT satisfy `must`: with `must: absent` the pattern being there is
  // the thing to read, with `must: present` its being missing is. Comparing the other way round
  // surfaces every clean chunk and hides every interesting one, while still returning a plausible
  // count.
  return chunks
    .filter((c) => re.test(c.text) !== wantPresent)
    .map((c) => ({ chunkId: c.id, path: c.path, text: c.text, checkId: check.id, value: null, band: 'hit' }));
}

// A missing or malformed bound throws rather than defaulting, the same way an unrecognised `then`
// throws in chunk.mjs. Defaulting to [0, 0] would surface nearly every chunk and read as a body
// full of findings rather than as a check nobody finished writing.
//
// Its own function so runSweep can run the identical guard BEFORE the first call goes out. Thrown
// from here, at the first answer, it aborts a run that has already been paid for. Left in place
// here as well: it costs nothing, and a caller reaching surface() directly never went through the
// runner.
//
// `Number.isFinite` and not `typeof n === 'number'`: NaN and Infinity are both numbers, and both
// get through the shape check while destroying everything downstream. [NaN, NaN] makes every
// comparison in surface() false, so every score row surfaces, AND every strength() returns NaN, so
// the comparator returns NaN, the sort order goes undefined and the regex arm loses the guaranteed
// top position the comment on strength() exists to protect. [2, 1] is an empty band by the same
// arithmetic: nothing can be both >= 2 and <= 1, so it also surfaces every row. Both read as a body
// full of findings rather than as a check nobody finished writing, which is the exact failure the
// shape check above was written to stop.
function scoreLevels(check) {
  const levels = check.expected_levels;
  if (!Array.isArray(levels) || levels.length !== 2 || !levels.every((n) => Number.isFinite(n))
    || levels[0] > levels[1]) {
    throw new Error(`check ${check.id}: score needs expected_levels [min, max]`);
  }
  return levels;
}

// A score answer is a position on the criteria index, 0 to length - 1 (the runbook: "normalise by
// the number of gaps"), so the criteria are what bound it. Jev takes 2 to 10 of them.
//
// ⚠ A BAND OUTSIDE THE INDEX CAN NEVER FIRE, OR ALWAYS FIRES. expected_levels [0, 99] against two
// criteria contains every answer the model can give, so the check reads as working and surfaces
// nothing. Rejected here with the rest.
function scoreCriteria(check) {
  const [min, max] = scoreLevels(check);
  const c = check.criteria;
  if (!Array.isArray(c) || c.length < 2 || c.length > 10 || !c.every((s) => typeof s === 'string' && s.trim())) {
    throw new Error(`check ${check.id}: score needs criteria, an ordered array of 2 to 10 level descriptions`);
  }
  if (min < 0 || max > c.length - 1) {
    throw new Error(`check ${check.id}: expected_levels [${min}, ${max}] must sit inside the criteria index, 0 to ${c.length - 1}`);
  }
}

// Optional on a noul. When present it is `{ true, false }`, and "yes"/"no" keys fail every call in
// the run with HTTP 400 (system-one-models.md), so the spelling is checked before the first one.
function noulCriteria(check) {
  if (!Object.hasOwn(check, 'criteria')) return;
  const c = check.criteria;
  const ok = c && typeof c === 'object' && !Array.isArray(c)
    && Object.keys(c).sort().join() === 'false,true'
    && typeof c.true === 'string' && c.true.trim() && typeof c.false === 'string' && c.false.trim();
  if (!ok) throw new Error(`check ${check.id}: noul criteria is { "true": "...", "false": "..." }, both non-empty`);
}

// Everything a sweep file can get wrong, found in ONE place and BEFORE the first call goes out.
// Every fault below has the same shape: the run still completes, prints in the normal format, and
// is byte-identical to a run that checked what it was asked to check. None of them cost anything to
// find here, and all of them cost a whole sweep to find later.
//
// ⚠ NOT DEFENSIVE PROGRAMMING. Each rule is one measured way to get a clean-looking empty result:
//   - include_source with no --source: the header is empty, the question still asks "is this
//     supported by the source", and the model answers it from prior with no source in the prompt.
//     A mistyped --source path already exits 1 in jevchecker.mjs; omitting the flag was silent.
//   - a duplicate check id: questionKey is `chunkId__checkId`, so the second check overwrites the
//     first in the questions object. Two checks go in, one question comes out carrying the second
//     check's criterion, the row count halves, and nothing says a check was dropped.
//   - surface_below of 0, -1 or "low": `v <= below` is then false for every answer a model can
//     return, so a body of entirely unsupported chunks reports zero candidates. "0.25" as a string
//     works by coercion, which is exactly what hides the broken values next to it.
//   - surface_below of 0.9 or 1: the same fault upside down. Above the torn window the line is live
//     again, so 1 makes every chunk outside that window a candidate and 0.9 makes a candidate band
//     with a hole in the middle. Both read as a working threshold in the file.
//   - `must` misspelled, or missing: `check.must === 'present'` reads every other string as absent,
//     so "presnet" silently inverts the check and still returns a plausible count.
//   - a missing or uncompilable pattern: `new RegExp(undefined)` is /(?:)/, which matches every
//     chunk, so `must: absent` files the entire body as hits and `must: present` files none.
//   - missing instructions: the question renders as `For the item marked [c0]: undefined` and the
//     model answers it anyway.
// Regex takes no `flags` on purpose, for the `lastIndex` reason on runRegex.
const CHECK_KEYS = {
  regex: ['id', 'type', 'pattern', 'must'],
  noul: ['id', 'type', 'instructions', 'surface_below', 'criteria'],
  score: ['id', 'type', 'instructions', 'expected_levels', 'criteria'],
};
export function preflight(sweep, sourceText) {
  // ⚠ NO CHECKS IS THE PUREST FORM OF THIS FAULT. A sweep whose `checks` is missing, empty, or
  // spelled `check` chunks the body, asks nothing, costs nothing and prints `N chunks, 0 calls,
  // $0.000000` then `0 candidates to read`, which is byte-identical to a sweep that asked every
  // question and found nothing. `chunks` is non-zero, so the NOTHING SWEPT banner does not fire
  // either. The files in sweeps/ are pinned against this by the suite, but `--sweep` takes any
  // path, so the hand-written file was the unguarded case.
  if (!Array.isArray(sweep?.checks) || !sweep.checks.length) {
    throw new Error('this sweep defines no checks (is the key spelled "checks"?), so it would chunk the body, ask nothing, and print zero candidates exactly like a sweep that checked everything');
  }
  // Whitespace is not a source either: the header would carry nothing the question can be about.
  if (sweep?.state?.include_source && !String(sourceText ?? '').trim()) {
    throw new Error('this sweep sets state.include_source, so it needs --source <file>: without one the source never reaches the prompt and the model answers about a source it cannot see');
  }
  // ⚠ AN UNKNOWN KEY IS IGNORED, SO A TYPO RUNS A DIFFERENT CHECK. `surfaceBelow` falls back to the
  // default line, `includeSource` sends no source, `flags: "i"` leaves the regex case-sensitive,
  // and every one of them runs and prints normally. Allow-listed by value, per level and per type.
  const only = (obj, keys, where) => {
    if (obj == null) return;
    const bad = Object.keys(obj).filter((k) => !keys.includes(k));
    if (bad.length) throw new Error(`${where}: unknown key ${bad.map((k) => JSON.stringify(k)).join(', ')} (allowed: ${keys.join(', ')}), and an unknown key is silently ignored`);
  };
  only(sweep, ['name', 'chunk', 'state', 'checks'], 'sweep');
  only(sweep.chunk, ['type', 'path', 'then'], 'chunk');
  only(sweep.state, ['include_source'], 'state');
  const seen = new Set();
  for (const ck of sweep?.checks ?? []) {
    if (seen.has(ck.id)) throw new Error(`check ${ck.id}: duplicate id, and the second one would silently replace the first`);
    seen.add(ck.id);
    if (!Object.hasOwn(CHECK_KEYS, ck.type)) throw new Error(`check ${ck.id}: ${ck.type} is not a check type (regex, noul, score), so it cannot become a model question`);
    only(ck, CHECK_KEYS[ck.type], `check ${ck.id}`);
    if (ck.type === 'regex') {
      if (ck.must !== 'present' && ck.must !== 'absent') throw new Error(`check ${ck.id}: must is "present" or "absent", not ${JSON.stringify(ck.must)}`);
      if (typeof ck.pattern !== 'string' || !ck.pattern) throw new Error(`check ${ck.id}: needs a non-empty pattern`);
      try { new RegExp(ck.pattern); } catch (e) { throw new Error(`check ${ck.id}: pattern does not compile (${e.message})`); }
      continue;
    }
    if (typeof ck.instructions !== 'string' || !ck.instructions.trim()) throw new Error(`check ${ck.id}: needs non-empty instructions`);
    if (ck.type === 'score') { scoreCriteria(ck); continue; }
    noulCriteria(ck);
    // Present-but-broken only. Absent is a real default, 0.5, pinned by its own assertion.
    //
    // ⚠ THE UPPER BOUND IS TORN_LOW, NOT 1. Torn owns everything above 0.25, so a surface_below
    // inside the torn window can never produce a candidate, and one ABOVE the window reopens the
    // clean side: at 0.9 a noul of 0.9 is a hit while 0.3 is torn, a candidate band with a hole in
    // the middle. At 1 nothing outside the torn window can ever come back clean, which is the same
    // check-that-cannot-fail shape as a surface_below of 0, pointing the other way. Neither is a
    // configuration anyone wants and both read as a working threshold. Rejected rather than
    // documented, so the rule in SKILL.md is enforced instead of hoped for.
    if (Object.hasOwn(ck, 'surface_below') && !(Number.isFinite(ck.surface_below) && ck.surface_below > 0 && ck.surface_below <= TORN_LOW)) {
      throw new Error(`check ${ck.id}: surface_below must be a number above 0 and at most ${TORN_LOW}, because torn owns everything above ${TORN_LOW} and a line set inside or above that window cannot mean what it looks like it means`);
    }
  }
}

// What the caller sees, and in which group. `surfaced` drives the candidate list; `band` drives
// which heading it sits under.
export function surface(check, answer) {
  if (check.type === 'score') {
    const levels = scoreLevels(check);
    const v = answer?.score;
    // ⚠ Missing surfaces. A question the model did not answer is the one case where silence is
    // indistinguishable from a clean result, so it is surfaced and labelled rather than dropped.
    //
    // `Number.isFinite` and not `typeof v === 'number'`, for the reason scoreLevels() spells out:
    // NaN and Infinity are both numbers. NaN passes a shape check, then every comparison below it
    // is false, so the row falls through to `clean` and the chunk leaves no trace in hits, torn or
    // unanswered. A nonsense answer would read as a checked and clean one.
    //
    // Out of range is broken too. A score is a position on the criteria index, 0 to length - 1, so a
    // 57 against four criteria is not a strong candidate, it is not an answer, and ranked by distance
    // it would sort to the top of the list. The range applies when criteria are present, which
    // preflight guarantees on every run.
    const top = Array.isArray(check.criteria) ? check.criteria.length - 1 : Infinity;
    if (!Number.isFinite(v) || v < 0 || v > top) return { surfaced: true, value: null, band: 'unanswered' };
    const [min, max] = levels;
    // Compared against the FRACTIONAL value as returned. A score of 2.6 against an expected [1,2]
    // is outside the band; rounding it to 3 first, or to 2, loses exactly that.
    const inside = v >= min && v <= max;
    return { surfaced: !inside, value: v, band: inside ? 'clean' : 'hit' };
  }
  const v = answer?.noul;
  // Same guard as the score arm, plus the range. A noul is a probability, so 0 to 1 inclusive is the
  // whole of its valid domain and anything outside it is a broken answer rather than a confident
  // one. 1.5 would clear the surfacing line, clear the torn window and land in `clean`, which is
  // the same disappearance NaN causes and just as invisible in the output.
  if (!Number.isFinite(v) || v < 0 || v > 1) return { surfaced: true, value: null, band: 'unanswered' };
  const below = check.surface_below ?? 0.5;
  // Inclusive at the line: surface_below is the value a reader chose, so a noul landing exactly on
  // it is shown and moving the line is a decision rather than a rounding accident.
  const surfaced = v <= below;
  // Torn gets its own heading rather than being merged into hit or clean: a cluster of torn answers
  // means the check is badly worded, which is a different finding from the body being worth reading.
  //
  // ⚠ TORN IS ITS OWN GROUP, SO A TORN ROW IS NOT A CANDIDATE. `surfaced` is still computed and
  // carried, but runSweep routes on `band` FIRST, so a torn row lands in `torn` and never in the
  // candidate list however far under the line it sits. The consequence: the effective candidate
  // threshold is TORN_LOW and nothing else, whatever the check asked for. A sweep that wants a
  // candidate line above 0.25 has to move the band, not the check.
  //
  // This line is ORDER-DEPENDENT and the order is the whole rule. `surfaced` is computed against
  // `below` on the line above, so without this early return a `below` of 0.9 would make a noul of
  // 0.9 a hit while 0.3 stayed torn. That is why preflight caps surface_below at TORN_LOW rather
  // than at 1: the cap is what makes "the effective threshold is TORN_LOW" true for every value a
  // sweep file can hold, instead of true only for the values anyone happened to try.
  if (v > TORN_LOW && v < TORN_HIGH) return { surfaced, value: v, band: 'torn' };
  return { surfaced, value: v, band: surfaced ? 'hit' : 'clean' };
}

// The separator is two underscores and parseKey splits on the FIRST one, so a checkId may contain
// underscores and a chunkId may not. Chunk ids are generated (`c0`, `c1`), check ids are written by
// hand in a sweep file, so the constraint sits on the half nobody types.
export const questionKey = (chunkId, checkId) => `${chunkId}__${checkId}`;
export function parseKey(key) {
  const k = String(key);
  const i = k.indexOf('__');
  // A key with no separator throws rather than being split at -1, which would silently return the
  // key minus its last character as a chunkId and the key minus its first as a checkId. Both look
  // like ids, neither matches anything, and the answer they carry would join to no chunk at all.
  if (i < 0) throw new Error(`not a question key: ${k}`);
  return { chunkId: k.slice(0, i), checkId: k.slice(i + 2) };
}

// One question per check type, looked up rather than branched, so an unknown type throws the way an
// unknown chunk `then` does instead of falling through to the noul shape.
//
// ⚠ A REGEX CHECK CANNOT BECOME A QUESTION. modelChecks() filters it upstream, and this is the last
// place a caller that skipped that filter could turn "does this contain an em dash" into a noul
// question. Asking a judgement model something code already answered exactly costs a question and
// returns a fuzzy number, and nothing in the output would say the answer came from the wrong layer.
const QUESTION = {
  // `criteria` rides along only when the check has it, so a bare noul keeps its two-key shape.
  noul: (ck, id) => ({ type: 'noul', instructions: `For the item marked [${id}]: ${ck.instructions}`,
    ...(ck.criteria ? { criteria: ck.criteria } : {}) }),
  score: (ck, id) => ({ type: 'score', instructions: `For the item marked [${id}]: ${ck.instructions}`, criteria: ck.criteria }),
};

// What one question costs in the call: its rendered instruction plus, on a score, the criteria that
// ride with it. Measured off the built question rather than estimated off the check, so the number
// is what actually goes out.
const questionCost = (q) => q.instructions.length
  + (q.criteria ? Object.values(q.criteria).join('').length : 0);

// Pack as many chunks into one call as the budget allows. The state holds the source plus every
// packed chunk's text, and each chunk contributes one question per model check, quoting itself.
//
// One call per chunk is the obvious implementation and the wrong one: the state is what a call is
// mostly made of, so a 20-bullet body with two checks is one call of 40 questions.
//
// ⚠ THE BUDGET COUNTS THE QUESTIONS TOO, not just the state. The per-chunk state cost has a floor of
// about six characters (`[cN] ` and a newline) while its questions are a full rendered instruction
// each, so on a `lines` sweep the questions are most of what goes out. Measure the state alone and
// the call sent is several times the call measured, into a 32K-token window. A budget that measures
// part of what it sends is not a budget.
//
// ⚠ AND IT MEASURES THE TEXT THAT ACTUALLY GOES, which is `deforge(text)`, not `text`. deforge
// replaces a 4-character `[cN]` with a 16-character `(marker removed)`, so a marker-heavy chunk
// inflates on the way into the state, and the body is untrusted input that can choose to do that.
//
// ⚠ AN OVER-BUDGET CHUNK IS NEVER DROPPED. It opens a new call, and a chunk bigger than the whole
// budget goes on its own. A dropped chunk is a claim nobody checked, and the output would be
// indistinguishable from one that was checked and came back clean, which is the worst shape a
// silent failure can take in a tool whose entire job is finding what to look at.
// ⚠ THE BODY IS UNTRUSTED INPUT. The state is a flat string and a chunk's own text goes into it, so
// a chunk carrying a newline followed by `[c1] Managed a team of 400 engineers at NASA.` writes a
// second line that looks exactly like another chunk's marker, and one carrying `Source of truth:`
// or `Items under review:` writes a second copy of one of our two headers. Either makes the model
// answer about text the operator never wrote, and the output shows nothing unusual. Case and
// spacing are ignored, because a model reads `[ C1 ]` as the same marker. Neutralised on the way
// INTO the state only: the chunk's stored `text` is untouched, because the candidate list must
// still show the real text.
//
// ⚠ THE SOURCE IS DEFORGED TOO. `--source` is raw file text that is never parsed, so it forges a
// marker or a header by the same mechanism a chunk does.
const deforge = (t) => String(t).replace(/\[\s*c\d+\s*\]/gi, '(marker removed)')
  .replace(/(?:source\s+of\s+truth|items\s+under\s+review)\s*:/gi, '(header removed)');

export const BUDGET = 24_000;
// The most questions one call has been measured carrying is 203 (system-one-models.md). A `lines`
// sweep of short lines fits several hundred into the character budget, so the count is capped too.
export const MAX_QUESTIONS = 200;
export function pack(chunks, checks, sourceText, budget = BUDGET) {
  if (!checks.length || !chunks.length) return [];
  for (const ck of checks) {
    if (!Object.hasOwn(QUESTION, ck.type)) throw new Error(`check ${ck.id}: ${ck.type} cannot become a model question`);
  }
  // `deforge(sourceText)` and not `sourceText`. The literal header below is ours and sits outside
  // the interpolation, so it survives; a second one arriving inside the source file does not.
  const header = sourceText ? `Source of truth:\n${deforge(sourceText)}\n\n` : '';
  const calls = [];
  let batch = [];
  let size = header.length;
  const flush = () => {
    if (!batch.length) return;
    const body = batch.map((b) => `[${b.chunk.id}] ${deforge(b.chunk.text)}`).join('\n');
    const questions = {};
    for (const b of batch) Object.assign(questions, b.questions);
    calls.push({ chunks: batch.map((b) => b.chunk), state: `${header}Items under review:\n${body}`, questions });
    batch = [];
    size = header.length;
  };
  for (const c of chunks) {
    // Built once, here, and carried to the flush. Building them twice would let the measured call
    // and the sent call drift apart, which is the bug this whole cost line exists to close.
    const questions = {};
    let asked = 0;
    for (const ck of checks) {
      const q = QUESTION[ck.type](ck, c.id);
      questions[questionKey(c.id, ck.id)] = q;
      asked += questionCost(q);
    }
    // This chunk's line in the state, `[id] text` plus its newline, plus every question it buys.
    // `deforge(c.text)` and not `c.text`: the flush writes the deforged text, and that is the one
    // that has to fit.
    const cost = deforge(c.text).length + c.id.length + 4 + asked;
    // `>` and not `>=`: a batch that exactly fills the budget is a batch that fits.
    //
    // `batch.length &&` is belt and braces, NOT the thing keeping an over-budget chunk alive. That
    // is `flush()`'s own empty-batch early return, and removing this guard changes no behaviour.
    if (batch.length && (size + cost > budget || (batch.length + 1) * checks.length > MAX_QUESTIONS)) flush();
    batch.push({ chunk: c, questions });
    size += cost;
  }
  flush();
  return calls;
}

// Strongest first, and "strongest" is not the same number on every check type.
//
// ⚠ A SCORE DOES NOT SORT ON ITS RAW VALUE. Against an expected band of [1, 2] a 5 is a far
// stronger candidate than a 2.6, and ascending value puts the 2.6 first. What ranks a score is its
// DISTANCE OUTSIDE the band. A noul is the other way up, the lowest value being the strongest, and
// a regex hit is certain so it outranks every judgement.
//
// Finite rather than Infinity on the regex arm: two regex hits compared as Infinity - Infinity give
// NaN, and a comparator returning NaN leaves the order undefined.
function strength(row, byCheck) {
  if (row.value === null) return Number.MAX_SAFE_INTEGER;
  const ck = byCheck.get(row.checkId);
  if (ck?.type !== 'score') return 1 - row.value;
  const [min, max] = ck.expected_levels;
  return row.value < min ? min - row.value : row.value - max;
}

// `ask` is injectable so the self-check runs the real ordering and mapping logic without spending a
// call. A fake that only the test uses would test the fake.
//
// ⚠ A THROW FROM parseKey OR pack ABORTS THE RUN, and must never be turned into an unanswered row.
// Both fire only when our own code built something wrong, and "unanswered" is a data condition
// meaning the model did not answer. Routing a programming error into it prints a content finding
// for a code bug. Only a FAILED MODEL CALL becomes unanswered, which is what the try below covers.
//
// A failed call is retried ONCE after `retryDelay` ms, because at concurrency 6 a 429 or a dropped
// connection is transient and would otherwise leave its whole call unanswered, with a full rerun as
// the only recovery. A failed call costs nothing, so the retry is free when it fails again.
export async function runSweep(body, sweep, sourceText, key, { concurrency = 6, ask = askJev, onDone, retryDelay = 1000 } = {}) {
  // FIRST, before chunking and before the regex checks run, because every fault it catches is in the
  // sweep file rather than in the body and none of them is worth finding after the model is paid.
  preflight(sweep, sourceText);
  // The chunk SPEC, not the sweep. `chunk()` reads `.type` off what it is given, so passing the
  // whole sweep throws `unknown chunk type: undefined` on every run.
  const chunkStats = {};
  const chunks = chunkBody(body, sweep?.chunk, chunkStats);
  const hits = [];
  const torn = [];
  const unanswered = [];
  // Kept for the JSON copy only, never printed, so a measurement like "the other six scored 0.95
  // to 0.97" can be re-derived from the tool's own output.
  const clean = [];
  for (const check of regexChecks(sweep)) hits.push(...runRegex(chunks, check));
  const checks = modelChecks(sweep);
  const calls = pack(chunks, checks, sweep?.state?.include_source ? sourceText : null);
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const byCheck = new Map(checks.map((c) => [c.id, c]));
  let cost = 0;
  const results = await runPool(calls, async (call) => {
    try {
      return await ask(call.state, call.questions, key);
    } catch {
      await new Promise((r) => setTimeout(r, retryDelay));
      try {
        return await ask(call.state, call.questions, key);
      } catch (e) {
        // A failed call is not a clean result. Every question in it becomes unanswered, which
        // surfaces, so a network blip can never read as "nothing to look at here".
        return { answers: null, cost: 0, error: e.message };
      }
    }
  }, concurrency, onDone);
  for (const [i, res] of results.entries()) {
    // Coerced, because the cost arrives from the API and a string there would otherwise throw in
    // the CLI's `toFixed` after the run was paid for, before a single result printed.
    cost += Number(res.cost) || 0;
    for (const qk of Object.keys(calls[i].questions)) {
      const { chunkId, checkId } = parseKey(qk);
      const answer = res.answers?.[qk];
      const s = surface(byCheck.get(checkId), answer);
      const c = byId.get(chunkId);
      // Every unanswered row says why, including the call that returned 200 without this answer or
      // with a broken one. The NOTHING ANSWERED banner points the reader at these reasons.
      const why = res.error ?? (s.band !== 'unanswered' ? undefined
        : answer == null ? 'the response carried no answer for this question'
          : `the answer was not a valid value: ${JSON.stringify(answer).slice(0, 80)}`);
      const row = { chunkId, path: c?.path, text: c?.text, checkId, value: s.value, band: s.band,
        error: why };
      // Band first. `surfaced` and `band` are independent, so a torn answer under the surfacing
      // line goes under the torn heading rather than into the candidate list.
      if (s.band === 'torn') torn.push(row);
      else if (s.band === 'unanswered') unanswered.push(row);
      else if (s.surfaced) hits.push(row);
      else clean.push(row);
    }
  }
  hits.sort((a, b) => strength(b, byCheck) - strength(a, byCheck));
  // `asked` is the model-question count, so a caller can tell "all 40 unanswered" (nothing was
  // checked, the key or the service failed) from "3 of 40 unanswered" without recounting.
  const asked = calls.reduce((n, c) => n + Object.keys(c.questions).length, 0);
  return { hits, torn, unanswered, clean, chunks: chunks.length, dropped: chunkStats.dropped ?? 0,
    calls: calls.length, asked, cost };
}
