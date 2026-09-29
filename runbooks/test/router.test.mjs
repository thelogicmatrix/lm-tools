import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selftest } from '../scripts/router.mjs';

// The selftest's own assertions are the regression net. This only runs it under node:test.
test('router selftest', async () => {
  assert.ok(await selftest());
});

// ⚠ A PIPE LEFT OPEN MUST NOT HANG THE HOOK. The hook reads its payload from stdin, and a caller
// that never closes it used to hold the router until the harness killed it at 15 s. The deadline
// is index.mjs's readInput, 500 ms. Home and cwd are an empty temp dir, so there is no runbooks
// folder and no key file, and the run ends silently after the read: nothing is posted.
test('the hook ends on its stdin deadline when stdin is never closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbr-stdin-'));
  const router = fileURLToPath(new URL('../scripts/router.mjs', import.meta.url));
  // The temp dir can sit inside a git repo (a home folder under git), so git is stopped above it.
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, OPENROUTER_API_KEY: '', GIT_CEILING_DIRECTORIES: path.dirname(dir) };
  const t0 = Date.now();
  const child = spawn(process.execPath, [router], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const killer = setTimeout(() => child.kill(), 10_000);
  const code = await new Promise((r) => child.on('close', r));
  clearTimeout(killer);
  const ms = Date.now() - t0;
  child.stdin.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(code, 0, `the hook exits 0 rather than being killed, after ${ms} ms`);
  assert.ok(ms < 5_000, `and inside the deadline plus start-up, took ${ms} ms`);
  assert.strictEqual(out, '', 'with no runbooks folder it injects nothing');
});
