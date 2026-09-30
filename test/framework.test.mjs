// Gate 3: every vendored lib-cli file matches its canonical copy. Gate 5: no plugin imports a file
// outside its own folder, because an installed plugin has no siblings. Both read the real repo.
// The import check reads import specifiers only, so a plugin that runs a sibling plugin's file by a
// relative path is out of its scope. Issue #126 tracks the one case today (jevmail runs postman.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { REPO, plugins, status } from '../scripts/sync-lib.mjs';

const rel = (p) => relative(REPO, p).split(sep).join('/');

test('every vendored lib-cli file matches its canonical copy', () => {
  const off = status(REPO).filter((r) => r.state !== 'same').map((r) => `${r.state}: ${rel(r.target)}`);
  assert.deepEqual(off, [], 'run node scripts/sync-lib.mjs and commit the copies');
});

// Static `from '...'`, side-effect `import '...'` and dynamic `import('...')` with a relative literal.
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g;
function sources(dir, out = []) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.superpowers'].includes(d.name)) continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) sources(p, out);
    else if (/\.(mjs|js)$/.test(d.name)) out.push(p);
  }
  return out;
}

test('no plugin imports a file outside its own folder', () => {
  const bad = [];
  for (const p of plugins(REPO)) {
    const root = join(REPO, p);
    for (const file of sources(root)) {
      for (const [, , spec] of readFileSync(file, 'utf8').matchAll(SPEC)) {
        if (relative(root, resolve(dirname(file), spec)).startsWith('..')) bad.push(`${rel(file)} imports ${spec}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});
