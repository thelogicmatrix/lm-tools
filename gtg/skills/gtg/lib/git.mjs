// One git runner for gtg, logical-projects and logical-learning. The three plugins install as
// separate directories and cannot import each other, so this file is copied into each, and
// gtg/test/store-parity.test.mjs pins the copies to identical code. Change all three together.
import { execFileSync } from 'node:child_process';

// Concurrent sessions share one index, so `git add` and `git commit` collide on index.lock
// (the 2026-08-11 backfill died on one). Only that is retried. Any other failure is real and
// is thrown at once. The timeout stops a hung git (a credential prompt, a stuck hook) from
// hanging the verb that called it.
// ponytail: a stale lock left by a crashed git still fails after about 1.75 s of retries,
// which is correct (only a human can tell stale from slow). Upgrade path: name the lock file
// in the error so the user knows what to delete.
const LOCKED = /index\.lock/;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function runGit(args, { cwd, retries = 3, timeout = 30000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout });
    } catch (e) {
      if (attempt >= retries || !LOCKED.test(`${e?.stderr ?? ''}`)) throw e;
      pause(250 * 2 ** attempt);
    }
  }
}

// The one line of a child-process failure that actually says what went wrong. Three traps, each
// of which has printed a useless message here:
//   - `e.stderr` under stdio:'pipe' is a BUFFER, and an EMPTY buffer is TRUTHY, so the usual
//     `e.stderr || e.message` shadows the message entirely - a timeout kill printed a bare dash.
//   - git leads with "warning: LF will be replaced by CRLF" on a Windows checkout, so the first
//     line is git's line-ending advice rather than the cause.
//   - a refused fast-forward leads with nine `hint:` lines.
// So: coerce, prefer stderr only when it has content, and take the first line that is neither
// blank nor advice. Falls back to the first line of whatever there is rather than to ''.
export function firstMeaningfulLine(e) {
  const raw = `${e?.stderr ?? ''}`.trim() || `${e?.message ?? ''}`.trim() || String(e ?? '');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => !/^(warning|hint):/i.test(l)) || lines[0] || '';
}
