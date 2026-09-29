// Preload for spawned tests: node --import this file. The first `git merge` finds .git/index.lock
// held, the way it is while another session commits in the same tree, and the lock is gone for
// any retry. Same re-sync trick as spawn-log-shim.mjs, so gtg's own imports see the wrapper.
import cp from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const real = cp.execFileSync;
let held = false;
cp.execFileSync = (file, args, opts, ...rest) => {
  if (held || file !== 'git' || !Array.isArray(args) || args[0] !== 'merge') return real(file, args, opts, ...rest);
  held = true;
  const lock = join(opts?.cwd ?? process.cwd(), '.git', 'index.lock');
  writeFileSync(lock, '');
  try { return real(file, args, opts, ...rest); } finally { rmSync(lock, { force: true }); }
};
syncBuiltinESMExports();
