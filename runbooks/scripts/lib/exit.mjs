// lib-cli/exit.mjs. Canonical in the logical-tools repo, vendored into each plugin that lists it in a
// .framework.json. Edit the canonical copy, run node scripts/sync-lib.mjs, commit both.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// True when the module at `url` is the script node was started with. Both sides go through
// realpathSync, because a plugin reached through a junction runs with argv[1] on the junction path
// while node resolves import.meta.url to the target, and a plain compare never runs main() there.
// A path that does not resolve is not the entry point.
export function isMain(url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

// Report a refusal and set the exit code without exiting. process.exit() while a fetch socket is
// still open trips a libuv assertion on Windows (Node 24) and the process dies with 0xC0000409
// instead of the code it asked for. 2 means the request was malformed, 1 that a valid request
// failed. Returns the code so a caller can `return fail(...)`.
export function fail(message, code = 2) {
  console.error(message);
  process.exitCode = code;
  return code;
}
