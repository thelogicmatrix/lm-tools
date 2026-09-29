import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const script = path.join(root, 'scripts', 'statusline-codex.mjs');
const {
  STATUS_ITEMS,
  estimateCost,
  findLatestSession,
  mergeCodexConfig,
  parseSession,
  writeFileAtomic,
} = await import(pathToFileURL(script));

const meta = (model = 'gpt-5.6-sol', source = 'cli') => JSON.stringify({
  type: 'session_meta',
  payload: {
    cwd: 'C:\\work\\demo',
    source,
    base_instructions: { provenance: { model } },
  },
});

const usage = (totals) => JSON.stringify({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: totals },
  },
});

const totals = {
  input_tokens: 1_000_000,
  cached_input_tokens: 400_000,
  cache_write_input_tokens: 100_000,
  output_tokens: 100_000,
  reasoning_output_tokens: 25_000,
  total_tokens: 1_100_000,
};

assert.deepEqual(STATUS_ITEMS, [
  'model-with-reasoning',
  'project-name',
  'context-used',
  'five-hour-limit',
  'weekly-limit',
]);

{
  const result = estimateCost('gpt-5.6-sol', totals);
  assert.equal(result.uncachedInputTokens, 500_000);
  assert.equal(result.estimatedUsd, 4.66);
  assert.equal(result.costBasis, 'api-equivalent');
  assert.equal(result.billed, false);
}

assert.throws(
  () => estimateCost('future-model', totals),
  /No pricing snapshot for future-model/,
);

{
  const parsed = parseSession([
    meta(),
    usage({ ...totals, output_tokens: 50_000 }),
    usage(totals),
  ].join('\n'));
  assert.equal(parsed.model, 'gpt-5.6-sol');
  assert.deepEqual(parsed.usage, totals);
  assert.equal(parsed.isSubagent, false);
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-codex-'));
  const other = path.join(dir, 'other.jsonl');
  const current = path.join(dir, 'current.jsonl');
  const subagent = path.join(dir, 'subagent.jsonl');
  fs.writeFileSync(other, `${meta()}\n${usage(totals)}\n`);
  fs.writeFileSync(current, `${meta()}\n${usage(totals)}\n`);
  fs.writeFileSync(subagent, `${meta('gpt-5.6-luna', { subagent: {} })}\n${usage(totals)}\n`);
  const now = Date.now() / 1000;
  fs.utimesSync(other, now - 20, now - 20);
  fs.utimesSync(current, now - 10, now - 10);
  fs.utimesSync(subagent, now, now);
  assert.equal(findLatestSession(dir, 'C:\\work\\demo').path, current);
  assert.throws(
    () => findLatestSession(dir, 'C:\\work\\missing'),
    /No root Codex session matching/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ⚠ NEWEST FIRST, WHOLE FILES ONLY ON A MATCH. Every session file used to be read in full before
// the newest match was picked: 2.0 s over 255 files and 423 MB. The scan now reads each file's first
// line (session_meta) newest-first and reads a whole file only when its cwd matches. Counted by
// patching fs.readFileSync, which the script calls through the same default export.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-codex-'));
  const now = Date.now() / 1000;
  const write = (name, body, age) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    fs.utimesSync(p, now - age, now - age);
    return p;
  };
  const other = (cwd) => meta().replace('C:\\\\work\\\\demo', cwd);
  for (let i = 0; i < 5; i++) write(`old-${i}.jsonl`, `${meta()}\n${usage(totals)}\n`, 100 + i);
  const newest = write('newest.jsonl', `${meta()}\n${usage(totals)}\n`, 1);
  write('elsewhere.jsonl', `${other('C:\\\\work\\\\other')}\n${usage(totals)}\n`, 0);
  // A match with no usage yet is skipped for the next match, as before.
  const blank = write('blank.jsonl', `${meta()}\n`, 0.5);
  // A file whose session_meta is not on line 1 is still read, in full, as before.
  const late = write('late.jsonl', `{"type":"turn_context"}\n${other('C:\\\\work\\\\late')}\n${usage(totals)}\n`, 200);

  const realRead = fs.readFileSync;
  const reads = [];
  fs.readFileSync = (p, ...rest) => { reads.push(path.basename(String(p))); return realRead(p, ...rest); };
  try {
    assert.equal(findLatestSession(dir, 'C:\\work\\demo').path, newest);
    assert.deepEqual(reads, ['blank.jsonl', 'newest.jsonl'], 'only the matches down to the first with usage are read whole');
    reads.length = 0;
    assert.throws(() => findLatestSession(dir, 'C:\\work\\missing'), /No root Codex session matching/);
    assert.deepEqual(reads, ['late.jsonl'], 'a miss reads no file whole except one with no session_meta on line 1');
    reads.length = 0;
    assert.equal(findLatestSession(dir, 'C:\\work\\late').path, late);
  } finally {
    fs.readFileSync = realRead;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const before = [
    'model = "gpt-5.6-sol"',
    '',
    '[tui]',
    'animations = false',
    '',
    '[tui.keymap.global]',
    'quit = "ctrl-q"',
    '',
  ].join('\n');
  const once = mergeCodexConfig(before);
  const twice = mergeCodexConfig(once);
  assert.equal(once, twice);
  assert.match(once, /animations = false/);
  assert.match(once, /quit = "ctrl-q"/);
  assert.match(once, /status_line = \["model-with-reasoning", "project-name", "context-used", "five-hour-limit", "weekly-limit"\]/);
  assert.match(once, /status_line_use_colors = true/);
}

{
  const custom = '[tui]\nstatus_line = ["git-branch"]\n';
  assert.throws(() => mergeCodexConfig(custom), /already has a different tui\.status_line/);
  assert.match(mergeCodexConfig(custom, { force: true }), /model-with-reasoning/);
}

{
  const multiline = [
    '[tui]',
    'status_line = [ # reviewer [ bracket',
    '  "git-branch",',
    ']',
    'animations = false',
    '',
  ].join('\n');
  assert.throws(
    () => mergeCodexConfig(multiline, { force: true }),
    /single-line string array/,
  );
  assert.match(multiline, /animations = false/);
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-atomic-'));
  const target = path.join(dir, 'config.toml');
  fs.writeFileSync(target, 'before\n');
  writeFileAtomic(target, 'after\n');
  assert.equal(fs.readFileSync(target, 'utf8'), 'after\n');
  assert.deepEqual(fs.readdirSync(dir), ['config.toml']);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin', 'plugin.json')));
  assert.equal(manifest.name, 'statusline');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.interface.category, 'Productivity');

  const skill = fs.readFileSync(path.join(root, 'skills', 'statusline', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: statusline\r?\ndescription: Use when /);
  assert.match(skill, /statusline-codex\.mjs/);
}

{
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const claudeManifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json')));
  const codexManifest = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin', 'plugin.json')));
  assert.equal(packageJson.version, '1.1.0');
  assert.equal(claudeManifest.version, packageJson.version);
  assert.equal(codexManifest.version, packageJson.version);

  const marketplace = JSON.parse(fs.readFileSync(path.join(root, '..', '.agents', 'plugins', 'marketplace.json')));
  assert.ok(marketplace.plugins.some((plugin) => plugin.name === 'statusline'));

  const projectReadme = fs.readFileSync(path.join(root, '..', 'README.md'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /codex plugin add statusline@logical-tools/);
  assert.doesNotMatch(projectReadme, /no Codex equivalent/);
  assert.match(readme, /\$statusline cost/);
  assert.match(readme, /API-equivalent/);
}
console.log('statusline Codex: all checks passed');
