import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runGit, firstMeaningfulLine } from '../git.mjs';

test('runGit returns git stdout and throws on a real failure at once', () => {
  const d = mkdtempSync(join(tmpdir(), 'libcli-git-'));
  execFileSync('git', ['init', '-q'], { cwd: d });
  assert.equal(runGit(['rev-parse', '--is-inside-work-tree'], { cwd: d }).toString().trim(), 'true');
  assert.throws(() => runGit(['no-such-verb'], { cwd: d }));
});

test('firstMeaningfulLine skips advice and survives an empty stderr buffer', () => {
  assert.equal(firstMeaningfulLine({ stderr: Buffer.from('warning: LF will be replaced\nhint: x\nfatal: bad ref\n') }), 'fatal: bad ref');
  assert.equal(firstMeaningfulLine({ stderr: Buffer.alloc(0), message: 'spawnSync git ETIMEDOUT' }), 'spawnSync git ETIMEDOUT');
  assert.equal(firstMeaningfulLine('plain'), 'plain');
});
