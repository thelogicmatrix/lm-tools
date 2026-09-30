import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillBlock, skillViolations } from '../scripts/resolve.mjs';
import { readSent } from '../scripts/session.mjs';
import { slash } from '../scripts/find.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESOLVE = path.join(HERE, '..', 'scripts', 'resolve.mjs');
const INDEX = path.join(HERE, '..', 'scripts', 'index.mjs');
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

const SKILL = '---\nname: swarm\nrunbooks:\n  - topic: pushing a branch on this host\n    at: dispatch, landing\n'
  + '  - topic: opening a pull request on this host\n    at: landing, review\n  - topic: which tier a task gets\n---\nbody\n';

function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rb-skill-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', base]);
  const docs = path.join(base, 'docs', 'runbooks');
  put(path.join(docs, 'git-workflow.md'), '# G\n**Type:** procedure\n**Purpose:** Branch, push and open a pull request.\n\n## Steps\n1. x\n');
  put(path.join(base, '.claude', 'skills', 'swarm', 'SKILL.md'), SKILL);
  put(path.join(base, '.runbooks', 'topics.json'), JSON.stringify({
    'pushing a branch on this host': { slug: 'git-workflow' },
    'opening a pull request on this host': { slug: 'git-workflow' },
  }));
  const env = { ...process.env, HOME: base, USERPROFILE: base, LOCALAPPDATA: base, RUNBOOKS_DIR: '', CLAUDE_CONFIG_DIR: '', OPENROUTER_API_KEY: '' };
  const hook = (payload) => spawnSync(process.execPath, [RESOLVE, '--hook'],
    { cwd: base, env, encoding: 'utf8', input: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  const lint = () => spawnSync(process.execPath, [INDEX, '--lint'], { cwd: base, env, encoding: 'utf8' });
  const start = () => spawnSync(process.execPath, [INDEX], { cwd: base, env, encoding: 'utf8', input: JSON.stringify({ cwd: base }) });
  return { base, docs, env, hook, lint, start, state: path.join(base, 'claude-router') };
}
const payload = (f, skill = 'swarm', extra = {}) => ({ session_id: 's1', cwd: f.base, hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill }, ...extra });

test('skillBlock lists each runbook once with its merged steps, then counts what is unmapped', () => {
  const book = { file: 'git-workflow.md', purpose: 'Branch, push and open a pull request.' };
  const text = skillBlock('swarm',
    [{ topic: 'a', at: ['dispatch', 'landing'], book }, { topic: 'b', at: ['landing', 'review'], book }],
    [{ topic: 'c', at: [], why: 'not mapped' }], '/r/docs', 'node "/p/scripts/resolve.mjs" --skill swarm');
  assert.equal(text, 'Runbooks for the swarm skill (read each before the step named beside it):\n'
    + '- /r/docs/git-workflow.md (at: dispatch, landing, review) — Branch, push and open a pull request.\n'
    + '1 topic of the swarm skill is not mapped to a runbook. Map it once: node "/p/scripts/resolve.mjs" --skill swarm');
  assert.equal(skillBlock('swarm', [], [], '/r', 'x'), '');
  assert.match(skillBlock('swarm', [], [{ topic: 'c' }, { topic: 'd' }], '/r', 'x'), /^2 topics of the swarm skill are not mapped to a runbook\. Map them once: x$/);
  assert.match(skillBlock('s', [{ topic: 'a', at: [], book }], [], '/r', 'x'), /- \/r\/git-workflow\.md — Branch/);
});

test('the hook injects the mapped paths from the map alone and records them', (t) => {
  const f = fixture(t);
  const r = f.hook(payload(f));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(Object.keys(out.hookSpecificOutput).sort().join(), 'additionalContext,hookEventName', 'no permission decision, ever');
  const text = out.hookSpecificOutput.additionalContext;
  assert.ok(text.includes(`- ${slash(path.join(f.docs, 'git-workflow.md'))} (at: dispatch, landing, review) — Branch, push and open a pull request.`), text);
  assert.ok(text.includes('1 topic of the swarm skill is not mapped to a runbook.'), text);
  assert.deepEqual(readSent('s1\0', f.state), ['git-workflow.md']);
  // Listed again on a second load: the list carries the steps.
  assert.equal(JSON.parse(f.hook(payload(f)).stdout).hookSpecificOutput.additionalContext, text);
});

test('the hook is silent and exits 0 on everything that is not a skill with topics', (t) => {
  const f = fixture(t);
  const silent = (p, why) => { const r = f.hook(p); assert.deepEqual([r.status, r.stdout], [0, ''], `${why}: ${r.stderr}`); };
  silent('not json', 'bad stdin');
  silent('', 'empty stdin');
  silent({ ...payload(f), tool_name: 'Bash' }, 'another tool');
  silent(payload(f, 'nope'), 'unknown skill');
  silent(payload(f, '../../docs'), 'a name that leaves the folder');
  silent({ ...payload(f), tool_input: {} }, 'no skill name');
  put(path.join(f.base, '.claude', 'skills', 'plain', 'SKILL.md'), '---\nname: plain\n---\n');
  silent(payload(f, 'plain'), 'no block');
  put(path.join(f.base, '.claude', 'skills', 'bad', 'SKILL.md'), '---\nrunbooks: x\n---\n');
  silent(payload(f, 'bad'), 'malformed block is the lint\'s job');
  fs.writeFileSync(path.join(f.base, '.runbooks', 'topics.json'), '{hand edit');
  silent(payload(f), 'broken map');
});

test('a skill nudge adds its line, and a throwing one costs nothing', (t) => {
  const f = fixture(t);
  put(path.join(f.base, '.runbooks', 'skill-nudges', 'a.mjs'), 'export default (c) => `nudge ${c.skill} ${c.topics.length} ${c.resolved.length}`;\n');
  put(path.join(f.base, '.runbooks', 'skill-nudges', 'b.mjs'), 'export default () => { throw new Error("x"); };\n');
  const text = JSON.parse(f.hook(payload(f)).stdout).hookSpecificOutput.additionalContext;
  assert.ok(text.endsWith('\nnudge swarm 3 2'), text);
});

test('skillViolations names an unmapped topic, a dead mapping and a malformed block', (t) => {
  const f = fixture(t);
  const books = [{ file: 'git-workflow.md', type: 'procedure', purpose: 'p' }];
  const opts = { top: f.base, configDir: path.join(f.base, 'cfg'), root: path.join(f.base, '.runbooks'), books };
  assert.deepEqual(skillViolations(opts), { violations: ['skill swarm: topic "which tier a task gets" is not mapped'], advisories: [] });
  put(path.join(f.base, '.runbooks', 'topics.json'), JSON.stringify({
    'pushing a branch on this host': { slug: 'gone' },
    'opening a pull request on this host': { slug: 'git-workflow' },
    'which tier a task gets': { slug: 'git-workflow' } }));
  assert.deepEqual(skillViolations(opts), { violations: ['skill swarm: topic "pushing a branch on this host" is mapped to gone, which is not a live runbook'], advisories: [] });
  put(path.join(f.base, '.claude', 'skills', 'bad', 'SKILL.md'), '---\nrunbooks: x\n---\n');
  assert.ok(skillViolations(opts).violations.includes('skill bad: runbooks: must be a list, one "- topic:" per item'));
  fs.writeFileSync(path.join(f.base, '.runbooks', 'topics.json'), '{hand edit');
  assert.match(skillViolations(opts).violations[0], /topics\.json is not a JSON object/);
});

// A cached plugin skill lives under the fixture's own config dir, so the lint reads it and nothing
// of the machine's. The project skill is removed, so only the plugin's findings are in play.
function cached(f, text) {
  fs.rmSync(path.join(f.base, '.claude'), { recursive: true, force: true });
  const configDir = path.join(f.base, 'cfg');
  put(path.join(configDir, 'plugins', 'cache', 'm', 'tools', '1.0.0', 'skills', 'riff', 'SKILL.md'), text);
  const lint = () => spawnSync(process.execPath, [INDEX, '--lint'],
    { cwd: f.base, env: { ...f.env, CLAUDE_CONFIG_DIR: configDir }, encoding: 'utf8' });
  return { opts: { top: f.base, configDir, root: path.join(f.base, '.runbooks'), books: [{ file: 'git-workflow.md' }] }, lint };
}

test('skillViolations reads the newest version of a cached plugin skill only', (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.base, '.claude'), { recursive: true, force: true });
  const configDir = path.join(f.base, 'cfg');
  const at = (v) => path.join(configDir, 'plugins', 'cache', 'm', 'tools', v, 'skills', 'riff', 'SKILL.md');
  put(at('1.0.0'), '---\nrunbooks:\n  - topic: an old topic\n---\n');
  put(at('1.1.0'), '---\nrunbooks:\n  - topic: a new topic\n---\n');
  assert.deepEqual(skillViolations({ top: f.base, configDir, root: path.join(f.base, '.runbooks'), books: [] }),
    { violations: [], advisories: ['skill tools:riff: topic "a new topic" is not mapped'] });
});

test('a cached plugin skill\'s unmapped topic is advisory and the lint passes', (t) => {
  const f = fixture(t);
  const c = cached(f, '---\nrunbooks:\n  - topic: a plugin topic\n---\n');
  assert.deepEqual(skillViolations(c.opts), { violations: [], advisories: ['skill tools:riff: topic "a plugin topic" is not mapped'] });
  const r = c.lint();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('\n1 skill topics from installed plugins are not mapped (advisory, map the ones this host has a runbook for):\n'
    + '  skill tools:riff: topic "a plugin topic" is not mapped\n'), r.stdout);
  assert.match(r.stdout, /resolve\.mjs" --skill <name>/);
});

test('a cached plugin skill\'s malformed block is advisory and the lint passes', (t) => {
  const f = fixture(t);
  const c = cached(f, '---\nrunbooks: x\n---\n');
  assert.deepEqual(skillViolations(c.opts), { violations: [], advisories: ['skill tools:riff: runbooks: must be a list, one "- topic:" per item'] });
  const r = c.lint();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('  skill tools:riff: runbooks: must be a list, one "- topic:" per item\n'), r.stdout);
});

test('a cached plugin skill\'s topic mapped to a dead runbook is a violation and the lint fails', (t) => {
  const f = fixture(t);
  const c = cached(f, '---\nrunbooks:\n  - topic: a plugin topic\n---\n');
  put(path.join(f.base, '.runbooks', 'topics.json'), JSON.stringify({ 'a plugin topic': { slug: 'gone' } }));
  assert.deepEqual(skillViolations(c.opts),
    { violations: ['skill tools:riff: topic "a plugin topic" is mapped to gone, which is not a live runbook'], advisories: [] });
  const r = c.lint();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /skill tools:riff: topic "a plugin topic" is mapped to gone, which is not a live runbook/);
});

test('--lint fails on an unmapped topic and names the command that maps it', (t) => {
  const f = fixture(t);
  const r = f.lint();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /skill swarm: topic "which tier a task gets" is not mapped/);
  assert.match(r.stdout, /resolve\.mjs" --skill <name>/);
});

test('the session-start index names the find command', (t) => {
  const f = fixture(t);
  put(path.join(f.docs, 'old.md'), '# O\n**Type:** postmortem\n**Purpose:** Tried and ended.\n');
  const r = f.start();
  assert.equal(r.status, 0, r.stderr);
  const text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(text, /Find a runbook by topic: node ".*\/scripts\/find\.mjs" "<topic>"/);
});
