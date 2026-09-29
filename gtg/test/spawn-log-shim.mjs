// Preload for spawned tests that count child processes: node --import this file.
// Wraps the sync child_process calls and re-syncs the ESM bindings, so gtg's own
// `import { execFileSync }` sees the wrapper. At exit it prints one stderr line:
// GTG_SPAWNS [["git","-C","dir","status","--porcelain"], ...]
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const calls = [];
for (const name of ['execFileSync', 'spawnSync']) {
  const real = cp[name];
  cp[name] = (file, args, ...rest) => { calls.push([file, ...(Array.isArray(args) ? args : [])]); return real(file, args, ...rest); };
}
syncBuiltinESMExports();
process.on('exit', () => { process.stderr.write(`GTG_SPAWNS ${JSON.stringify(calls)}\n`); });
