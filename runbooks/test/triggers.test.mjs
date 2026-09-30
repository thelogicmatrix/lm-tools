import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFile, lintTriggers, parseHeader, parseTriggers } from '../scripts/index.mjs';

const head = (extra, type = 'standard') => `# X\n**Type:** ${type}\n**Purpose:** A rule.\n${extra}`;

test('parseHeader reads Triggers, and its absence is null', () => {
  assert.equal(parseHeader(head('**Triggers:** git push, fj pr create\n')).triggers, 'git push, fj pr create');
  assert.equal(parseHeader(head('')).triggers, null);
});

test('parseTriggers splits on commas, then on whitespace', () => {
  assert.deepEqual(parseTriggers('git push,  fj  pr create '), [['git', 'push'], ['fj', 'pr', 'create']]);
  assert.deepEqual(parseTriggers(null), []);
  assert.deepEqual(parseTriggers('a,,b'), [['a'], ['b']]);
});

test('a valid Triggers line lints clean, in header order', () => {
  assert.deepEqual(lintFile('x', head('**Triggers:** git push, fj pr create\n**Verified:** 2026-09-30\n')), []);
});

test('lintTriggers rejects what would fire everywhere or never', () => {
  assert.deepEqual(lintTriggers('x', head('**Triggers:** git\n')),
    ['x: trigger "git" is a bare common command, add the subcommand']);
  assert.deepEqual(lintTriggers('x', head('**Triggers:** git push, , fj pr\n')),
    ['x: empty trigger in **Triggers:**']);
  assert.deepEqual(lintTriggers('x', head('**Triggers:**\n')),
    ['x: empty **Triggers:**']);
  assert.deepEqual(lintTriggers('x', head('**Triggers:** git push --force\n')),
    ['x: trigger "git push --force" holds a flag, a quote or a shell operator, use plain command words']);
  assert.deepEqual(lintTriggers('x', head('**Triggers:** git "push"\n')),
    ['x: trigger "git "push"" holds a flag, a quote or a shell operator, use plain command words']);
});

test('a one-word trigger that is not a common command is allowed', () => {
  assert.deepEqual(lintTriggers('x', head('**Triggers:** terraform\n')), []);
});

test('Triggers on a type the router does not carry is a violation', () => {
  const text = '# X\n**Type:** residual\n**Purpose:** Wrong on purpose.\n**Triggers:** git push\n';
  assert.deepEqual(lintTriggers('x', text),
    ['x: **Triggers:** belongs to procedures, standards and references only, this is a residual']);
});

test('lintFile carries the trigger violations', () => {
  assert.ok(lintFile('x', head('**Triggers:** node\n'))
    .includes('x: trigger "node" is a bare common command, add the subcommand'));
});

test('a bold Triggers lead-in in body prose is prose, not a field', () => {
  const text = '# X\n**Type:** postmortem\n**Purpose:** A record.\n\n**Triggers:** a cron job at 3am (nightly).\n';
  assert.deepEqual(lintFile('x', text), []);
  assert.equal(parseHeader(text).triggers, null);
});

test('a header Triggers wins over a later body line', () => {
  const text = head('**Triggers:** git push\n\n**Triggers:** something else\n');
  assert.equal(parseHeader(text).triggers, 'git push');
});

test('a Triggers only in the body reads null and is not in order', () => {
  const text = head('\n**Triggers:** git push\n');
  const h = parseHeader(text);
  assert.equal(h.triggers, null);
  assert.deepEqual(h.order, ['Type', 'Purpose']);
  assert.deepEqual(lintTriggers('x', head('\n**Triggers:**\n')), []);
});

test('Triggers reads the same with or without a blank line under the title', () => {
  const fields = '**Type:** standard\n**Purpose:** A rule.\n**Triggers:** git push\n';
  assert.equal(parseHeader(`# X\n${fields}`).triggers, 'git push');
  assert.equal(parseHeader(`# X\n\n${fields}`).triggers, 'git push');
});

test('#123: a Triggers line on a retired runbook fails the lint', () => {
  const text = '# Old\n**Type:** procedure\n**Status:** retired 2026-09-30 — replaced\n**Purpose:** x\n**Triggers:** fj issue\n';
  assert.ok(lintTriggers('old', text).some((p) => p.includes('retired')));
});
