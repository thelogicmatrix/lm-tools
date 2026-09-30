import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (...p) => JSON.parse(fs.readFileSync(path.join(PLUGIN, ...p), 'utf8'));

test('the Claude hooks name scripts that exist, on the events this plugin uses', () => {
  const { hooks } = json('hooks', 'hooks.json');
  assert.deepEqual(Object.keys(hooks).sort(), ['PostCompact', 'PreToolUse', 'SessionStart', 'UserPromptSubmit']);
  assert.deepEqual(hooks.PreToolUse.map((h) => h.matcher), ['Skill', 'Bash|PowerShell']);
  const commands = Object.values(hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
  assert.equal(commands.length, 5);
  for (const c of commands) {
    const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([a-z]+\.mjs)"( --[a-z]+)?$/.exec(c);
    assert.ok(m, c);
    assert.ok(fs.existsSync(path.join(PLUGIN, 'scripts', m[1])), m[1]);
  }
  assert.ok(commands.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve.mjs" --hook'));
  assert.ok(commands.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/action.mjs"'));
  assert.ok(commands.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/session.mjs" --clear'));
});

test('both manifests carry the same version', () => {
  assert.equal(json('.claude-plugin', 'plugin.json').version, '1.4.3');
  assert.equal(json('.codex-plugin', 'plugin.json').version, '1.4.3');
});

test('the Codex hooks are unchanged: no PreToolUse is registered there yet', () => {
  assert.deepEqual(Object.keys(json('.codex-plugin', 'hooks.json').hooks).sort(), ['SessionStart', 'UserPromptSubmit']);
});
