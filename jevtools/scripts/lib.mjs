// Shared plumbing for Jev sweeps. Extracted when the second sweep arrived, not before: the
// jevchecker spec proposed a generic engine up front and every chunker strategy in it was a guess.
// What is actually shared between the email sweep and the JD sweep turns out to be three things,
// none of them a chunker.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordSpend } from './spend.mjs';

export const ENDPOINT = 'https://openrouter.ai/api/v1/systemone';
export const MODEL = 'jev-latest';

// Calls in flight per sweep. Six held without a 429 on every measured run.
export const CONCURRENCY = 6;

// `--name value` and `--name`, the only two shapes these CLIs take. A valued flag reads the next
// argument whatever it is, so a caller that must refuse `--json --top` checks for a leading `--`.
export function parseArgs(argv = process.argv.slice(2)) {
  return {
    flag: (n) => argv.includes(`--${n}`),
    opt: (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : argv[i + 1]; },
  };
}

// `--selftest` predates the *.test.mjs files and runbooks still name it, so each CLI keeps the flag
// and hands it to its test file here rather than falling through into a real run. NODE_TEST_CONTEXT
// is dropped so a --selftest started from inside a test runner reports as a run of its own.
export function runSelftest(testUrl) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', fileURLToPath(testUrl)], { stdio: 'inherit', env });
  process.exitCode = r.status ?? 1;
}

// True when the module at `url` is the script node was started with. Both sides go through
// realpathSync, because a plugin reached through a junction runs with argv[1] on the junction path
// while node resolves import.meta.url to the target, and a plain compare never ran main() there
// (runbooks #32). A path that does not resolve is not the entry point.
export function isMain(url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

// The key, from the environment first and then from ~/.jev.env.
//
// The file fallback exists because the only copy of this key used to live in a gitignored .env
// inside a feature-branch WORKTREE, and a worktree is a thing someone deletes when its branch lands.
// It was deleted on 2026-09-22. ~/.jev.env is the home now, and it is the same file
// the runbook router reads, so there is one key on this machine rather than a copy
// per caller, each going stale on its own schedule.
//
// A caller that finds nothing gets null and prints its own message. Never throw from here: a sweep
// with no key has one clear line to say, and an exception from a helper buries it in a stack.
// The match is anchored to the line start so a commented old line cannot win, allows a shell
// `export` prefix, and strips one pair of surrounding quotes (left in, they give a 401).
export function readKey(env = process.env, file = path.join(os.homedir(), '.jev.env')) {
  if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY;
  try {
    const m = fs.readFileSync(file, 'utf8')
      .match(/^\s*(?:export\s+)?OPENROUTER_API_KEY=(.*)$/m);
    const v = m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : '';
    if (v) return v;
  } catch { /* not there, and a missing file is a fallback, never an error */ }
  return null;
}

// Email and JD bodies both arrive with markup, entities and MIME scaffolding in them. Measured on
// the 391-message jobhunt window, 2026-09-22: 33 snippets (8%) begin with raw markup and 326 carry
// quoted-printable artefacts. A model asked "is this a rejection" reads `Content-Transfer-Encoding`
// as content, so this runs before any state is built.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#160': ' ' };
export function toText(s) {
  return String(s ?? '')
    // Quoted-printable: soft line breaks first, then =XX bytes. Order matters — decoding =XX first
    // turns "=\n" into a stray byte and glues the words either side together.
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/^--[0-9a-f]{16,}.*$/gim, ' ')
    .replace(/^Content-(Type|Transfer-Encoding|Disposition|ID):.*$/gim, ' ')
    // NOT anchored to end-of-line, unlike the two above: the soft-line-break strip runs first and
    // welds a trailing "=\n" separator onto the next word. A run of 20+ hyphens is never prose.
    .replace(/-{20,}/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-z]+|#\d+);/gi, (_, e) => ENTITIES[e.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ⚠ A TIMEOUT, because a wedged call otherwise hangs the whole sweep with no output at all. Measured
// calls take under a second, so 60 s is a hang and never a slow answer.
//
// The body is read as TEXT and parsed after the status check. Parsed first, a gateway's HTML 502
// page threw `Unexpected token '<'` and the status code was lost from the error.
export const TIMEOUT_MS = 60_000;
export async function askJev(state, questions, key, { timeoutMs = TIMEOUT_MS, spend = {}, ...retry } = {}) {
  const meta = { ...spend, questions: Object.keys(questions).length, model: MODEL };
  try {
    const text = await postText(ENDPOINT, key, { model: MODEL, state, questions }, timeoutMs,
      { ...retry, onRetry: () => recordSpend({ ...meta, usage: null, status: 'unreported' }) });
    const body = JSON.parse(text);
    recordSpend({ ...meta, usage: body.usage, status: body.usage ? 'ok' : 'unreported' });
    return { answers: body.answers, cost: body.usage?.cost ?? 0 };
  } catch (error) {
    recordSpend({ ...meta, usage: null, status: 'unreported' });
    throw error;
  }
}

// ⚠ THREE ATTEMPTS, NOT MORE. A timed-out call may still be billed, so every retry of one can be
// paid twice. A network error, 408, 429 or 5xx is retried with exponential backoff and jitter, and
// a Retry-After from the server replaces the backoff. Any other 4xx is final: a bad key or a bad
// request fails the same way every time.
export const ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
// ponytail: a Retry-After above this is cut to it, so a hostile or broken header cannot park a
// sweep for an hour. Fail the row instead if a real server ever asks for longer.
const MAX_WAIT_MS = 30_000;
const retryable = (status) => status === 408 || status === 429 || status >= 500;

// Retry-After is either whole seconds or an HTTP date. Null when absent or unreadable, so the
// caller falls back to its own backoff.
export function retryAfterMs(v, now = Date.now()) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const ms = /^\d+$/.test(s) ? Number(s) * 1000 : Date.parse(s) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_WAIT_MS) : null;
}

// One POST with the timeout, the retry and the status-first error, shared with every Jev caller.
// Serialised once, outside the retry, so a payload that cannot serialise throws once, unretried.
export async function postText(url, key, payload, timeoutMs = TIMEOUT_MS, retry = {}) {
  return fetchText(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, timeoutMs, retry);
}

// The retry loop under postText, for any request. An HTTP error carries `status`, so a caller can
// treat one code (a 404 on an optional read) as an answer rather than a failure.
export async function fetchText(url, init, timeoutMs = TIMEOUT_MS,
  { attempts = ATTEMPTS, baseDelayMs = BASE_DELAY_MS, onRetry } = {}) {
  for (let n = 1; ; n++) {
    let err;
    let wait = null;
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      if (res.ok) return text;
      err = Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 180)}`), { status: res.status });
      wait = retryAfterMs(res.headers.get('retry-after'));
    } catch (e) {
      err = e.name === 'TimeoutError' ? new Error(`no response after ${timeoutMs / 1000} s`) : e;
    }
    if ((err.status && !retryable(err.status)) || n >= attempts) throw err;
    onRetry?.();
    await new Promise((r) => setTimeout(r, wait ?? baseDelayMs * 2 ** (n - 1) * (0.5 + Math.random())));
  }
}

// ⚠ `typeof v === 'number'` IS NOT A VALID-ANSWER CHECK. NaN and Infinity are numbers, NaN fails
// every comparison and serialises to null, so a nonsense answer read as "the tag did not fire",
// which is clean. A noul is a probability, so its whole domain is 0 to 1.
export const isNoul = (v) => Number.isFinite(v) && v >= 0 && v <= 1;

// Fixed-size worker pool over one cursor. Not a queue library: N workers pulling from a shared
// index is the whole requirement, and `out` is written by index so results keep input order.
export async function runPool(items, worker, concurrency, onDone) {
  const out = new Array(items.length);
  let cursor = 0;
  let done = 0;
  const run = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i], i);
      onDone?.(++done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return out;
}

// Probabilities to a 0-1 value, with a missing or invalid answer as null rather than 0. Absent and
// "definitely not" are different, and folding them together lets a partial response read as a
// clean negative.
export function noulsFrom(answers, ids) {
  const out = {};
  for (const id of ids) {
    const v = answers?.[id]?.noul;
    out[id] = isNoul(v) ? Math.round(v * 100) / 100 : null;
  }
  return out;
}

export const firedTags = (tags, at = 0.5) => Object.entries(tags)
  .filter(([, v]) => v !== null && v >= at)
  .sort((a, b) => b[1] - a[1]);
