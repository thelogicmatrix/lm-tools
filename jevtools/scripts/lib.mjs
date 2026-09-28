// Shared plumbing for Jev sweeps. Extracted when the second sweep arrived, not before: the
// jevchecker spec proposed a generic engine up front and every chunker strategy in it was a guess.
// What is actually shared between the email sweep and the JD sweep turns out to be three things,
// none of them a chunker.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ENDPOINT = 'https://openrouter.ai/api/v1/systemone';
export const MODEL = 'jev-latest';

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
export function readKey(env = process.env) {
  if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY;
  try {
    const m = fs.readFileSync(path.join(os.homedir(), '.jev.env'), 'utf8')
      .match(/OPENROUTER_API_KEY=(.+)/);
    if (m && m[1].trim()) return m[1].trim();
  } catch { /* not there; a missing file is a fallback, never an error */ }
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
export async function askJev(state, questions, key, { timeoutMs = TIMEOUT_MS } = {}) {
  const text = await postText(ENDPOINT, key, { model: MODEL, state, questions }, timeoutMs);
  const body = JSON.parse(text);
  return { answers: body.answers, cost: body.usage?.cost ?? 0 };
}

// One POST with the timeout and the status-first error, shared with the JD escalation CLI's second opinion.
export async function postText(url, key, payload, timeoutMs = TIMEOUT_MS) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new Error(`no response after ${timeoutMs / 1000} s`);
    throw e;
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 180)}`);
  return text;
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
