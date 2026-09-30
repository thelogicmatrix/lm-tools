import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, status, manifests } from './sync-lib.mjs';

// A throwaway repo: lib-cli/a.mjs at version 1.2.0, and plugin p vendoring it into p/skills/p/lib.
// version null writes a manifest with no stamp, as a new plugin's hand-written one has.
function fixture(files = ['a.mjs'], version = '1.2.0') {
  const repo = mkdtempSync(join(tmpdir(), 'synclib-'));
  mkdirSync(join(repo, 'lib-cli'));
  writeFileSync(join(repo, 'lib-cli', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'lib-cli', 'CHANGELOG.md'), '# lib-cli changelog\n\n## 1.2.0 (2026-09-30)\n\n- b\n\n## 1.1.0 (2026-09-01)\n\n- a\n');
  mkdirSync(join(repo, 'p', '.claude-plugin'), { recursive: true });
  writeFileSync(join(repo, 'p', '.claude-plugin', 'plugin.json'), '{}');
  mkdirSync(join(repo, 'notaplugin', 'lib'), { recursive: true });
  writeFileSync(join(repo, 'notaplugin', 'lib', '.framework.json'), '{"files":["a.mjs"]}');
  const lib = join(repo, 'p', 'skills', 'p', 'lib');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, '.framework.json'), JSON.stringify(version ? { version, files } : { files }));
  return { repo, lib };
}
const quiet = (fn) => { const log = console.log, err = console.error; console.log = console.error = () => {}; try { return fn(); } finally { console.log = log; console.error = err; } };

test('only folders with a plugin manifest are searched', () => {
  const { repo } = fixture();
  assert.equal(manifests(repo).length, 1);
});

test('--check reports a missing copy and exits 1, then a sync writes it and --check exits 0', () => {
  const { repo, lib } = fixture(['a.mjs'], null);
  assert.equal(quiet(() => main(['--check'], repo)), 1);
  assert.equal(existsSync(join(lib, 'a.mjs')), false, '--check writes nothing');
  assert.equal(quiet(() => main([], repo)), 0);
  assert.equal(readFileSync(join(lib, 'a.mjs'), 'utf8'), 'export const a = 1;\n');
  assert.deepEqual(JSON.parse(readFileSync(join(lib, '.framework.json'), 'utf8')), { version: '1.2.0', files: ['a.mjs'] });
  assert.equal(quiet(() => main(['--check'], repo)), 0);
});

test('a manifest stamped with an older lib-cli version is drift, and a sync restamps it', () => {
  const { repo, lib } = fixture(['a.mjs'], '1.1.0');
  writeFileSync(join(lib, 'a.mjs'), 'export const a = 1;\n');
  assert.deepEqual(status(repo).map((r) => r.state), ['same', 'version']);
  assert.equal(quiet(() => main(['--check'], repo)), 1);
  assert.equal(quiet(() => main([], repo)), 0);
  assert.equal(JSON.parse(readFileSync(join(lib, '.framework.json'), 'utf8')).version, '1.2.0');
  assert.equal(quiet(() => main(['--check'], repo)), 0);
});

test('a lib-cli changelog with no version heading exits 2', () => {
  const { repo } = fixture();
  writeFileSync(join(repo, 'lib-cli', 'CHANGELOG.md'), '# lib-cli changelog\n');
  assert.throws(() => status(repo), /lib-cli\/CHANGELOG\.md has no "## X\.Y\.Z" heading/);
  assert.equal(quiet(() => main(['--check'], repo)), 2);
});

test('a copy that differs only in CRLF line endings is in sync', () => {
  const { repo, lib } = fixture();
  writeFileSync(join(lib, 'a.mjs'), 'export const a = 1;\r\n');
  assert.deepEqual(status(repo).map((r) => r.state), ['same']);
});

test('a hand-edited copy is drift', () => {
  const { repo, lib } = fixture();
  writeFileSync(join(lib, 'a.mjs'), 'export const a = 2;\n');
  assert.deepEqual(status(repo).map((r) => r.state), ['differs']);
  assert.equal(quiet(() => main(['--check'], repo)), 1);
});

test('an unusable manifest exits 2 and names itself', () => {
  for (const [body, why] of [
    ['{', /not valid JSON/],
    ['{"files":[]}', /non-empty list/],
    ['{"files":["b.mjs"]}', /lib-cli\/b\.mjs does not exist/],
    ['{"files":["../a.mjs"]}', /is not a lib-cli file name/],
  ]) {
    const { repo, lib } = fixture();
    writeFileSync(join(lib, '.framework.json'), body);
    assert.throws(() => status(repo), (e) => why.test(e.message) && e.message.startsWith('p/skills/p/lib/.framework.json'));
    assert.equal(quiet(() => main(['--check'], repo)), 2);
  }
});

test('an unknown argument exits 2 and writes no copy', () => {
  const { repo, lib } = fixture();
  assert.equal(quiet(() => main(['--chek'], repo)), 2);
  assert.equal(existsSync(join(lib, 'a.mjs')), false);
});
