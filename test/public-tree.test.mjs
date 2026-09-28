// The public tree names no person, machine or private address. logical-tools is worked on in a private
// repo and published to GitHub by hand, and this runs in CI on every push so a leak fails before
// the publish instead of after it. On 2026-09-28 a hard-coded Tailscale address, two machine names
// and an employer's name were found already public.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'test/public-tree.test.mjs';

export const RULES = [
  ['owner name', /nathan/i],
  ['machine name', /\b(obelisk|reborn)\b/i],
  ['employer', /syfe/i],
  // 100.64.0.0/10, the range Tailscale hands out. 100.63.x and 100.128.x are public addresses.
  ['Tailscale address', /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
  ['Tailscale hostname', /\.ts\.net\b/i],
];

// The author credit is the one place the name belongs: the license holder, the manifest author
// fields and the root README byline. Only the full name is allowed, and only in these files.
const CREDIT = 'Nathan Wong';
const isCreditFile = (file) =>
  file === 'LICENSE' || file === 'README.md' || /(^|\/)\.(claude|codex)-plugin\/(plugin|marketplace)\.json$/.test(file);

export function scanLine(file, line) {
  const text = isCreditFile(file) ? line.split(CREDIT).join('') : line;
  return RULES.filter(([, re]) => re.test(text)).map(([name]) => name);
}

function scanTree() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const hits = [];
  for (const file of files) {
    if (file === SELF) continue;
    const buf = readFileSync(join(ROOT, file));
    if (buf.includes(0)) continue; // binary
    buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
      for (const rule of scanLine(file, line)) hits.push(`${file}:${i + 1}: ${rule}: ${line.trim().slice(0, 120)}`);
    });
  }
  return { files: files.length, hits };
}

test('each rule catches its named case and leaves the near misses alone', () => {
  assert.deepEqual(scanLine('jevtools/scripts/x.mjs', "// Classify Nathan's repos"), ['owner name']);
  assert.deepEqual(scanLine('gtg/x.mjs', "const SYNC_REMOTE = 'obelisk-backup'"), ['machine name']);
  assert.deepEqual(scanLine('gtg/x.mjs', '// reborn is Windows'), ['machine name']);
  assert.deepEqual(scanLine('postman/x.py', '# Syfe logo, inline'), ['employer']);
  assert.deepEqual(scanLine('jevtools/x.mjs', "const HOST = 'http://100.75.143.3:3300'"), ['Tailscale address']);
  assert.deepEqual(scanLine('jevtools/x.mjs', 'http://100.64.0.1 and 100.127.255.255'), ['Tailscale address']);
  assert.deepEqual(scanLine('x.md', 'box.tail1234.ts.net'), ['Tailscale hostname']);
  assert.deepEqual(scanLine('x.md', '100.63.0.1 and 100.128.0.1 are public'), []);
});

test('the credit allowance is the full name in credit files only', () => {
  assert.deepEqual(scanLine('LICENSE', 'Copyright (c) 2026 Nathan Wong'), []);
  assert.deepEqual(scanLine('jevtools/.codex-plugin/plugin.json', '"developerName": "Nathan Wong",'), []);
  assert.deepEqual(scanLine('README.md', 'By [Nathan Wong](https://github.com/thelogicmatrix).'), []);
  assert.deepEqual(scanLine('jevtools/README.md', 'By Nathan Wong'), ['owner name'], 'a plugin README is not a credit file');
  assert.deepEqual(scanLine('LICENSE', 'Copyright (c) 2026 Nathan'), ['owner name'], 'the first name alone is not the credit');
  assert.deepEqual(scanLine('README.md', 'Nathan Wong runs this on obelisk'), ['machine name']);
});

test('no tracked file names a person, machine or private address', () => {
  const { files, hits } = scanTree();
  assert.ok(files > 100, `git ls-files returned ${files} files, so the scan did not see the tree`);
  assert.deepEqual(hits, [], `clear these before publishing:\n${hits.join('\n')}`);
});
