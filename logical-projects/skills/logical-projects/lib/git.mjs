// lib-cli/git.mjs. Canonical in the logical-tools repo, vendored into each plugin that lists it in a
// .framework.json. Edit the canonical copy, run node scripts/sync-lib.mjs, commit both.
import { execFileSync } from 'node:child_process';

// Concurrent sessions share one index, so `git add` and `git commit` collide on index.lock. Only that
// is retried. Any other failure is real and is thrown at once. The timeout stops a hung git (a
// credential prompt, a stuck hook) from hanging the verb that called it.
// ponytail: a stale lock left by a crashed git still fails after about 1.75 s of retries, which is
// correct (only a human can tell stale from slow). Upgrade path: name the lock file in the error.
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

// The one line of a child-process failure that says what went wrong. Three traps:
//   - `e.stderr` under stdio 'pipe' is a Buffer, and an empty Buffer is truthy, so the usual
//     `e.stderr || e.message` hides the message. A timeout kill once printed a bare dash.
//   - git leads with "warning: LF will be replaced by CRLF" on a Windows checkout.
//   - a refused fast-forward leads with nine `hint:` lines.
// So coerce, prefer stderr only when it has content, and take the first line that is neither blank
// nor advice. Falls back to the first line of whatever there is.
export function firstMeaningfulLine(e) {
  const raw = `${e?.stderr ?? ''}`.trim() || `${e?.message ?? ''}`.trim() || String(e ?? '');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => !/^(warning|hint):/i.test(l)) || lines[0] || '';
}
