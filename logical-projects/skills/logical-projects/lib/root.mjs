// lib-cli/root.mjs. Canonical in the logical-tools repo, vendored into each plugin that lists it in a
// .framework.json. Edit the canonical copy, run node scripts/sync-lib.mjs, commit both.
import { execFileSync } from 'node:child_process';

// The git toplevel that holds cwd, or null outside a repo, when git is missing, or when it hangs.
// No shell, and a timeout, so a credential prompt or a stuck hook cannot hang the CLI that asked.
// git's stderr is dropped, since the caller says what went wrong in its own words.
export function gitTop(cwd = process.cwd(), { timeout = 2000 } = {}) {
  try {
    const top = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout }).trim();
    return top || null;
  } catch {
    return null;
  }
}

// A CLI's storage root: the named variable when it is set and not empty, else the git toplevel of
// cwd, else null. The caller prints the message for null, because only it knows its own name and
// which variable to tell the user to set.
export function hubRoot(envName, { env = process.env, cwd = process.cwd(), timeout } = {}) {
  const set = env[envName];
  if (typeof set === 'string' && set !== '') return set;
  return gitTop(cwd, { timeout });
}
