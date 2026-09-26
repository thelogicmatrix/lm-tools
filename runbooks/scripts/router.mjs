#!/usr/bin/env node
// UserPromptSubmit: inject only the runbooks this prompt actually needs.
//
// WHAT IT REPLACES. index.mjs distinguishes PULLED procedures (a slug routes you: you
// already know you are deploying the app) from PUSHED standards and references (nothing about the
// task says "read powershell.md first", so their purpose has to ride the index or they never fire).
// That pushed block reached 5.9KB in EVERY session, paid whether or not anything matched.
//
// A prompt is the thing that decides relevance, and SessionStart does not have one. So this runs on
// UserPromptSubmit, asks one Jev call whether each pushed runbook applies, and injects the matches.
//
// MEASURED 2026-09-22 (a one-call match probe): 67 runbooks as
// 67 Nouls in one call, 883ms, $0.0004. Self-eval over 12: 9/12 top-1, 12/12 in top-3, narrowing 67
// to a mean of 3.8. On "the nightly backup pruned nothing again" it returned exactly one hit.
//
// ⚠ FAIL LOUD, NOT FAIL OPEN. Changed 2026-09-22, and the old rule was the exact opposite, so read
// this before restoring it. No key, no network, a timeout, a bad response, a thrown error: every
// path injects a three-line notice that says routing is unavailable, says why, and says to read
// the runbooks folder directly. It used to emit the full index instead.
//
// WHY IT FLIPPED. That full index is 31,957 bytes, about 8,000 tokens, against the roughly 7,000
// the always-on arrangement this router replaced cost. So the fallback was more expensive than the
// problem, and one transient timeout wiped out a day of routing savings. The old rationale was that
// silently hiding a standard because an API blipped is worse than never having had the router. The
// notice answers that directly: nothing is hidden silently, the gap is named and the reader is told
// where to look, for about 250 bytes. Do not put the full-index fallback back.
//
// The single deliberate exception is a prompt under 12 characters, which injects nothing. That is
// not a failure, it is a continuation ("ok", "yes") inside a session that already routed the real
// task, and it is the difference between saving 35% of the old block and saving 89%.
//
// RETRY, ADDED 2026-09-22. A call costs about $0.0002, so a retry is free in money and expensive in
// the only currency that matters here: the user is sitting in front of their prompt waiting for it.
// So the bound is a total wall-clock budget, not a per-attempt timeout, and only the failures that
// could plausibly answer differently on a second try are retried at all. See TOTAL_BUDGET_MS and
// isRetryable below.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildIndex, shortlist } from './prefilter.mjs';
import { settings, STATE_DIR } from './config.mjs';

const HOME = os.homedir();
// Every prompt is posted here, with no customer-data screen.
const ENDPOINT = 'https://openrouter.ai/api/v1/systemone';
const MODEL = 'jev-latest';
// THE BUDGET IS THE ONLY TIME CONSTANT. Measured call latency is 883 to 943ms. 4000ms over at most
// three attempts gives each one about 1.3s, roughly 40% headroom over the slowest measured call,
// and caps the worst case at 4s against the 3s a single attempt already cost. A per-attempt
// constant alongside this one would drift out of step with it, so each attempt takes what is left
// of the budget divided by the attempts still to come.
const TOTAL_BUDGET_MS = 4000;
const MAX_ATTEMPTS = 3;
// Flat, not exponential. Exponential backoff exists to stop a fleet of clients hammering a
// struggling service, and this is one call per prompt on one machine. Doubling here would only
// spend the budget waiting instead of calling, and the budget is 4 seconds in front of a human.
const RETRY_DELAY_MS = 100;
// RAISED 0.5 -> 0.8 on 2026-09-23, from 264 live firings in the transcripts. At 0.5
// the router never came back empty (jev scores an empty prompt at 0.48, see route()), it named 3.1
// documents a prompt, and the turn went on to touch one of them 2% of the time at 0.5-0.59, 7% at
// 0.6-0.69 and 5% at 0.7-0.79, against 35% at 0.8 and up. 0.8 cuts injected names from 809 to 26.
// It also drops 30 of the 39 low-score names a turn did touch, which was the accepted price.
// Exported for check.mjs, which grades runbook purpose lines against this same bar.
export const FIRES_AT = 0.8;
export const MAX_INJECT = 6;
// Runbook types worth pushing. A procedure is pulled by its slug and stays out.
// Procedures joined on 2026-09-22, and until then the router could not see one. That is why the
// 43-procedure block stayed in index.mjs at 2,973 tokens a session: a procedure is PULLED
// by name, and a slug only routes when the task happens to name the same noun. The 2026-08-17
// deploy task missed a container-networking runbook because it named the app rather than the
// mechanism.
//
// Gated on that exact case plus six more goal-worded tasks: 0 of 7 before, 6 of 7 after, that
// case among the hits. The 8 controls were compared on their FULL firing set rather than on the one
// document each names: no expected document lost, one
// incidental drop (a docker-networks runbook gave way to
// the container-networking runbook on a reverse-proxy prompt).
//
// Free in state size. Only standards bypass the shortlist, so these 47 compete for the same 30
// slots rather than adding to them.
const RB_KEEP = new Set(['standard', 'reference', 'procedure']);
// A retired runbook is a tombstone. SessionStart names it once as "do not re-propose", and routing
// it would hand the session a dead process with a relevance score on it. A dormant runbook is a live
// process parked for now (2026-09-24): it never routes either, and index.mjs
// gives it no tombstone, which is the whole difference from retired.
const RETIRED = /^\*\*Status:\*\*\s*(retired|dormant)\b/m;

// Same parse as index.mjs. The terminator is a lookahead with no `$`: under /m that
// matches the end of the FIRST line and truncates a purpose that wraps.
export function parse(text, file) {
  const type = text.match(/^\*\*Type:\*\*\s*(\w+)/m)?.[1] ?? null;
  const purpose = text.match(/^\*\*Purpose:\*\*\s*([\s\S]*?)(?=\n\s*\n|\n\*\*|\n#|(?![\s\S]))/m)?.[1]
    ?.replace(/\s+/g, ' ').trim() ?? null;
  const verified = text.match(/^\*\*Verified:\*\*\s*(\d{4}-\d{2}-\d{2})/m)?.[1] ?? null;
  return { file, type, purpose, verified };
}

export function loadCorpus(root, parseFn, prefix, keep) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      // An archived file is a fact that was deliberately superseded. Routing one would hand the
      // session a dead fact with a relevance score on it and nothing saying it is dead, which is
      // the exact failure the archive exists to prevent. A retired Status line is skipped the same way.
      if (e.isDirectory()) { if (e.name !== 'archive') walk(p); }
      else if (e.name.endsWith('.md')) {
        const text = fs.readFileSync(p, 'utf8');
        if (RETIRED.test(text)) continue;
        const r = parseFn(text, path.relative(root, p));
        if (r.type && r.purpose && keep.has(r.type)) out.push({ ...r, prefix });
      }
    }
  };
  try { walk(root); } catch { return []; }
  return out;
}

// A second corpus of notes existed until 2026-09-23, when its notes moved into the runbooks folder.
export const loadAll = (dir = settings({ cwd: process.cwd() }).dir) => dir ? loadCorpus(dir, parse, 'rb', RB_KEEP) : [];

// Takes the entry, not the filename. The prefix is left over from two corpora and kept so the
// keys in the recorded run files still read the same.
export const keyFor = (e) => `${e.prefix}_` + e.file.replace(/[^a-z0-9]+/gi, '_').toLowerCase();

export function buildQuestions(books) {
  return Object.fromEntries(books.map((b) => [keyFor(b), {
    type: 'noul',
    instructions: `Before starting this task, the person should read a ${b.type} whose purpose is: ${b.purpose}`,
    // criteria, because they are the accuracy, not decoration: dropping them scored 4 of the 8
    // named cases against 8 of 8 with them, measured at this corpus size in
    // the router's criteria probe (run1). They are also the single largest thing in the request,
    // one identical copy per question, so what stays here is paid 179 times on every prompt.
    //
    // Each pole is ONE clause, and both were cut from a longer version by DELETING its second
    // clause rather than rewriting it. That distinction cost a run to learn: a reworded short
    // version lost a case and pushed every score down 0.12 to 0.18, while these two deletions
    // scored at or above the long version on 7 of 8 cases across two runs (run2, run3) and saved
    // 20,406 bytes a call, 20% of the whole request. Shorten further by deleting, never by
    // paraphrasing, and re-run the probe.
    //
    // The poles separate "in this subject area" from "shares vocabulary".
    criteria: {
      true: 'The task is squarely within what that document governs',
      false: 'The task is in a different area, or only shares vocabulary with that document',
    },
  }]));
}

// What a failure injects instead of the index. Written for a model that will act on it: what is
// broken, why, and the one thing to do about it. Nothing else belongs here, because every line
// added is paid on every failure.
// The attempt count rides along so the reader can tell a one-off blip from a hard outage: one
// attempt means the failure was not worth retrying, three means it was and none of them worked.
export function failNotice(why, attempts = 1) {
  const tried = `${attempts} attempt${attempts === 1 ? '' : 's'}`;
  return `Runbook routing is unavailable (${why}, ${tried}), so no procedure, standard or reference `
    + 'was matched to this prompt.\n'
    + 'Treat the absence as unknown, not as "nothing applies".\n'
    + 'If this task touches a procedure, a standard or a stored fact, read the runbooks folder '
    + 'directly before starting.';
}

// Freshness. The age rides the injected line only. The model never sees it, so routing scores
// cannot move.
export const STALE_DAYS = 30;
export const STALE_LINE = `A runbook verified over ${STALE_DAYS} days ago, or never: before acting on one of its facts, `
  + 'check that fact against the live system, fix the runbook if it is wrong, and set Verified to today.';
// A missing or invalid date (2026-13-45 parses to NaN) reads as never verified.
const daysSince = (d, now) => (d ? Math.floor((now - new Date(`${d}T00:00:00Z`)) / 86_400_000) : NaN);
export function ageLabel(verified, now = new Date()) {
  const d = daysSince(verified, now);
  if (Number.isNaN(d)) return 'never verified';
  return d <= 0 ? 'verified today' : `verified ${d} day${d === 1 ? '' : 's'} ago`;
}

export function matchedBlock(hits, now = new Date()) {
  if (!hits.length) return '';
  // NaN fails every comparison, so a missing or invalid date counts as stale here.
  const stale = hits.some((h) => !(daysSince(h.verified, now) <= STALE_DAYS));
  return 'Runbooks matched to this task (read before starting):\n'
    + hits.map((h) => `- ${h.file.replace(/\.md$/, '')} (${h.type}, `
      + `${h.p.toFixed(2)}, ${ageLabel(h.verified, now)}) — ${h.purpose}`).join('\n')
    + (stale ? `\n${STALE_LINE}` : '');
}

// The Codex contract, as a function so the selftest checks the field names the hook actually
// emits rather than a copy retyped beside them. Codex ignores stdout that is not this shape,
// and ignores it without a word, so a typo here is a router that appears to match nothing.
export const codexEnvelope = (text) => ({
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
});

export function readKey(env = process.env) {
  if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY;
  // ~/.jev.env is the canonical home. A missing file is a fallback, never an error.
  try {
    const m = fs.readFileSync(path.join(HOME, '.jev.env'), 'utf8').match(/OPENROUTER_API_KEY=(.+)/);
    if (m && m[1].trim()) return m[1].trim();
  } catch { /* not there; fall through */ }
  return null;
}

// ⚠ WHICH FAILURES ARE WORTH A SECOND CALL. Spelled out rather than implied, because the obvious
// "simplification" is to retry everything, and everything is the wrong set. A missing key, a 4xx
// that is not 429, and a 200 whose body has no answers all fail identically on the next call: the
// retry buys nothing and spends a second of the user's waiting time to reach the same notice.
// A timeout, a 5xx, a thrown network error and a 429 are the ones a second call can answer.
export const isRetryable = (r) => r.thrown === true || r.why === 'timeout' || r.why === 'http 429'
  || /^http 5\d\d$/.test(r.why);

// One call. Returns the matched block, or the reason it failed for route to classify and count.
// What every call actually cost, from the API's own usage block rather than a price table. Written
// because every monthly figure this project has quoted came from a projection, and two of them were
// wrong: the volume was last read off a code comment and the per-call cost did not reproduce.
// One compact line per call, appended.
// Never throws: a router that dies because it could not write its own meter is worse than no meter.
// Outside the repo, deliberately. It lived beside the hook until 2026-09-22, where every session
// that sent a prompt wrote into the working tree and the harness reported the change into THAT
// session's context. An instrument built to save tokens was spending them in every unrelated
// session, which is the kind of cost that never shows up in the thing it measures.
// Git-ignoring it was not enough: the harness diffs files, not the index.
export const SPEND_LOG = path.join(STATE_DIR, 'spend.jsonl');
function meter(usage, asked, fired) {
  if (!usage) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(SPEND_LOG, JSON.stringify({ t: new Date().toISOString().slice(0, 16),
      i: usage.input_tokens, c: usage.cost, q: asked, h: fired }) + '\n');
  } catch { /* a meter is never worth failing a prompt over */ }
}

async function attempt(prompt, books, key, fetchImpl, timeoutMs, firesAt, maxInject) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state: `A task is about to be started. The task: ${prompt}`,
        questions: buildQuestions(books) }),
    });
    if (!res.ok) return { mode: 'fallback', why: `http ${res.status}` };
    const body = await res.json();
    if (!body?.answers) return { mode: 'fallback', why: 'no answers' };
    const hits = books
      .map((b) => ({ ...b, p: body.answers[keyFor(b)]?.noul ?? 0 }))
      .filter((b) => b.p >= firesAt).sort((x, y) => y.p - x.p).slice(0, maxInject);
    meter(body.usage, books.length, hits.length);
    return { text: matchedBlock(hits), mode: 'matched', hits: hits.length };
  } catch (e) {
    // A thrown fetch is a network-level failure, which is retryable. The message still rides along
    // in the notice, because "network" alone does not tell the reader what broke.
    return e.name === 'AbortError'
      ? { mode: 'fallback', why: 'timeout' }
      : { mode: 'fallback', why: String(e.message).slice(0, 60), thrown: true };
  } finally { clearTimeout(timer); }
}

// How many documents BM25 hands to jev, on top of the standards that always ride along. Set from
// the WORST rank the probe measured (11 of 179 over eight prompts) with headroom, not tuned against
// those eight: a ninth prompt has to fit too. The router's levers probe (run2) holds the run.
// --- one prompt, one call ---
// This hook can be registered twice, in user settings and in project settings. Claude Code merges
// the two and runs the command once per registration, so every prompt was routed twice: double the
// bill, double the injected tokens, and a match block printed twice with the scores a drift apart.
// It ran a full day unnoticed, because a duplicated block reads exactly like a normal one.
//
// Neither registration can simply go. Each one covers sessions the other does not reach. So the
// guard lives here, where every copy routes through it.
export const DEDUPE_LOG = path.join(STATE_DIR, 'dedupe.json');
export const DEDUPE_MS = 20_000;

// The written record, as its own function so the selftest checks the real field names rather than
// a literal retyped beside them. An output-redaction guard blocks a `key` holding 8+ opaque
// characters, and a sha1 under that name blocked two tool calls before the rename.
export const dedupeRecord = (promptHash, t) => ({ promptHash, t });

// Pure half, so the window is testable without touching a file. A repeat of the same text in the
// same session inside 20s is a second copy of this hook, not the user asking twice.
export function isDuplicate(promptHash, now, prev, windowMs = DEDUPE_MS) {
  return !!prev && prev.promptHash === promptHash && now - prev.t < windowMs;
}

// ponytail: last-write-wins on one file, not a lock. Two copies launched in the same millisecond
// could both read before either writes. The claim is staked BEFORE the ~380ms API call rather than
// after it, which leaves a window of microseconds against a gap of a third of a second. If Claude
// Code ever runs hook groups in true parallel, this needs an O_EXCL create instead.
function claimPrompt(sessionId, prompt) {
  // Named promptHash, not key: an output-redaction guard blocks any `key` holding 8+ opaque
  // characters, and a sha1 under that name reads exactly like a leaked credential. It fired on
  // this file twice before the rename.
  const promptHash = crypto.createHash('sha1').update(`${sessionId}\0${prompt}`).digest('hex');
  const now = Date.now();
  try {
    const prev = JSON.parse(fs.readFileSync(DEDUPE_LOG, 'utf8'));
    if (isDuplicate(promptHash, now, prev)) return false;
  } catch { /* absent or corrupt reads as "not seen", which only ever costs one extra call */ }
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(DEDUPE_LOG, JSON.stringify(dedupeRecord(promptHash, now)));
  } catch { /* never fail a prompt */ }
  return true;
}

export const SHORTLIST = 30;

// Narrow locally before spending a token. jev bills input, and the corpus IS the input, so the bill
// was linear in how many documents exist. It also has a wall: jev 1.13's window is 32K and the old
// call used 18,546 of it at 103.6 tokens a document, so the router stopped fitting at about 310
// documents. This is what keeps adding a runbook cheap instead of fatal.
//
// Every STANDARD rides along unconditionally, and that is not a safety blanket, it is the measured
// hole in a word-matcher. "I need the cloudflare api token to change a dns record" shares NOT ONE
// word with the secrets standard's purpose, so BM25 ranks it 57 of 179 while jev scores it 0.88 and puts
// it first. A standard is a rule you must not break, so they are never filtered out on vocabulary.
// That only stays cheap while the set is small: merging in a second corpus took it to 43 and the 2026-09-24
// review cut it back to 17 by retyping the references and procedures. Anything else earns its place
// lexically.
export function narrow(prompt, books, n = SHORTLIST) {
  if (books.length <= n) return books;
  const picked = new Set(shortlist(prompt, buildIndex(books), n).map((b) => b.file));
  return books.filter((b) => picked.has(b.file) || b.type === 'standard');
}

export async function route(prompt, books, key, fetchImpl = fetch, opts = {}) {
  const budgetMs = opts.budgetMs ?? TOTAL_BUDGET_MS;
  const delayMs = opts.delayMs ?? RETRY_DELAY_MS;
  // Config overrides ride in opts, so the exported constants check.mjs grades against stay put.
  const firesAt = opts.firesAt ?? FIRES_AT;
  const maxInject = opts.maxInject ?? MAX_INJECT;
  // No key means no call was made at all, and the notice says 0 attempts rather than inventing one.
  if (!key) return { text: failNotice('no key', 0), mode: 'fallback', why: 'no key', attempts: 0 };
  // ⚠ Never send a near-empty state: given nothing to read Jev answers from a prior (measured mean
  // 0.48 on an empty string), so a one-word prompt would produce confident matches.
  //
  // A short prompt injects NOTHING, and this is the one place that deliberately returns less than
  // the old routing. It is not a failure path. "ok" is a continuation inside a session that already
  // routed the real task a few turns back, so the standards it needed are already in context.
  // Measured 2026-09-22: 48 of 198 prompts that day were under 12 chars, ten of them literally
  // "ok", and falling back on each one cost 83k tokens, 83% of the router's entire daily spend.
  if (String(prompt ?? '').trim().length < 12) {
    return { text: '', mode: 'skipped', why: 'short prompt' };
  }
  // After the short-prompt skip, so a prompt that injects nothing never pays to be indexed.
  books = opts.narrow === false ? books : narrow(prompt, books, opts.shortlist ?? SHORTLIST);
  const deadline = Date.now() + budgetMs;
  let n = 0;
  for (;;) {
    n += 1;
    // Each attempt gets an equal share of what is left, so a slow first call cannot eat the whole
    // budget and leave the retries no room. This IS the per-attempt timeout, derived not declared.
    const slice = Math.max(1, Math.floor((deadline - Date.now()) / (MAX_ATTEMPTS - n + 1)));
    const r = await attempt(prompt, books, key, fetchImpl, slice, firesAt, maxInject);
    if (r.mode === 'matched') return { ...r, attempts: n };
    if (!isRetryable(r) || n >= MAX_ATTEMPTS || Date.now() + delayMs >= deadline) {
      return { text: failNotice(r.why, n), mode: 'fallback', why: r.why, attempts: n };
    }
    if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
  }
}

export async function selftest() {
  const assert = await import('node:assert');
  const a = assert.default ?? assert;
  const books = [
    { file: 'powershell.md', type: 'standard', purpose: 'How to write PowerShell here.', prefix: 'rb' },
    { file: 'secret-transfer.md', type: 'procedure', purpose: 'Move a secret without it hitting chat.', prefix: 'rb' },
  ];
  // A wrapped purpose survives; `$` under /m would truncate it.
  a.strictEqual(parse('**Type:** standard\n**Purpose:** One\ntwo.\n\n## X\nbody', 'p.md').purpose, 'One two.');
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
    a.deepStrictEqual(loadCorpus(tmp, parse, 'rb', RB_KEEP).map((x) => x.file), ['live.md'],
      'neither an archive directory nor a retired or dormant Status line may route');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

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

  // A timeout is a failure like the rest, not an empty injection.
  const slow = await route(TASK, books, 'k', timesOut(), FAST);
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
  const t0 = Date.now();
  const timedOut = count(timesOut());
  const over = await route(TASK, books, 'k', timedOut, FAST);
  const elapsed = Date.now() - t0;
  a.strictEqual(over.why, 'timeout');
  a.strictEqual(timedOut.n, 3);
  a.ok(elapsed < FAST.budgetMs + 150, `three attempts must fit the budget, took ${elapsed}ms`);
  // Each attempt's timeout is derived from the budget rather than declared beside it, so there is
  // no second constant to drift. Halving the budget halves the time spent.
  const t1 = Date.now();
  await route(TASK, books, 'k', timesOut(), { budgetMs: 60, delayMs: 0 });
  a.ok(Date.now() - t1 < elapsed, 'a smaller budget must actually spend less time');

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
        purpose: `Notes on topic${i} and subject${i}.`, prefix: 'rb' })),
      { file: 'torrent-vpn-netns.md', type: 'procedure',
        purpose: 'Fix a torrent client that stopped downloading after the vpn container restarted.', prefix: 'rb' },
      { file: 'key-handling.md', type: 'standard', purpose: 'Keep credentials out of chat transcripts.', prefix: 'rb' },
      { file: 'shell-quoting.md', type: 'standard', purpose: 'Quote strings carefully in shell scripts.', prefix: 'rb' },
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
  return 'router selftest OK';
}

if (process.argv.includes('--selftest')) { console.log(await selftest()); process.exit(0); }

// --- hook entry ---
// Only run the hook when this file IS the command. An import wants the exports, not a stdin read.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let prompt = '';
  let sessionId = '';
  let cwd = '';
  try {
    const input = JSON.parse(raw || '{}');
    prompt = input.prompt ?? '';
    sessionId = input.session_id ?? '';
    cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  } catch { prompt = ''; }

  // No runbooks folder: silent, and before the dedupe claim so a repo without runbooks writes nothing.
  // ponytail: settings() spawns git rev-parse, so a duplicate copy pays that spawn before it exits.
  // The first copy needs the folder to route at all, so moving it after the claim spares only the
  // duplicate. Cache the git top per cwd in STATE_DIR if the spawn is ever measured to matter.
  const cfg = settings({ cwd: cwd || process.cwd() });
  if (!cfg.dir) process.exit(0);

  // Second copy of this hook on the same prompt. Exit before the API call, not after it.
  if (prompt && !claimPrompt(sessionId, prompt)) process.exit(0);

  const books = loadAll(cfg.dir);
  if (!books.length) process.exit(0);
  const { text, mode, why, hits, attempts } = await route(prompt, books, readKey(), fetch,
    { firesAt: cfg.firesAt, maxInject: cfg.maxInject, shortlist: cfg.shortlist });
  // Claude Code takes plain stdout as context. Codex reads only the JSON envelope and drops
  // anything else on the floor, silently, which looks exactly like a router that found no match.
  // Same routing, same corpus, one flag: --json is the whole Codex port.
  if (text) console.log(process.argv.includes('--json') ? JSON.stringify(codexEnvelope(text)) : text);
  // One line so a fallback is visible rather than silent: if this says "fallback" every time, the
  // router is costing latency and buying nothing. It prints even when the injection is empty,
  // because a zero-hit result is still a call that happened and still cost the attempts it names.
  //
  // ⚠ THE ATTEMPT NUMBER IS NOT DECORATION. A retry that succeeds quietly is how a degrading API
  // keeps looking healthy until it stops working entirely. If "(attempt 2)" starts appearing on
  // ordinary prompts, the endpoint is failing most of the time and the router is paying a second
  // of latency per prompt to hide it.
  if (mode !== 'skipped') {
    console.error(mode === 'matched'
      ? `runbooks: ${hits} matched${attempts > 1 ? ` (attempt ${attempts})` : ''}`
      : `runbooks: fallback (${why}, ${attempts} attempt${attempts === 1 ? '' : 's'})`);
  }
}
