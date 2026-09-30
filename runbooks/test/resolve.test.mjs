import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSkill, loadTopics, newestVersion, parseRunbooksBlock, resolveTopics, saveTopics, skillViolations, slugOf, topicKey } from '../scripts/resolve.mjs';
import { purposeHash } from '../scripts/ledger.mjs';
import { slash } from '../scripts/find.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'resolve.mjs');
const tmp = (t, p = 'rb-res-') => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

const SKILL = [
  '---',
  'name: swarm',
  'description: >-',
  '  A backlog of issues fixed by grouped workers. It says runbooks: in passing.',
  'runbooks:',
  '  - topic: branching, pushing and opening a pull request on this host',
  '    at: dispatch, landing',
  '  # a comment',
  '  - topic: "which model tier a task gets"',
  '',
  '  - topic:   filing   an issue on this host',
  '    at: audit',
  'other: value',
  '---',
  '',
  '# Swarm',
  'runbooks:',
  '  - topic: a body line, not frontmatter',
].join('\n');

test('parseRunbooksBlock reads topics and steps from the frontmatter only', () => {
  assert.deepEqual(parseRunbooksBlock(SKILL), { errors: [], topics: [
    { topic: 'branching, pushing and opening a pull request on this host', at: ['dispatch', 'landing'] },
    { topic: 'which model tier a task gets', at: [] },
    { topic: 'filing an issue on this host', at: ['audit'] },
  ] });
});

test('CRLF and a BOM parse the same', () => {
  const crlf = '\uFEFF' + SKILL.replace(/\n/g, '\r\n');
  assert.deepEqual(parseRunbooksBlock(crlf), parseRunbooksBlock(SKILL));
});

test('no block, no frontmatter and an empty file are all "no topics", not errors', () => {
  assert.deepEqual(parseRunbooksBlock('---\nname: x\n---\nbody'), { topics: [], errors: [] });
  assert.deepEqual(parseRunbooksBlock('# no frontmatter\nrunbooks:\n  - topic: x'), { topics: [], errors: [] });
  assert.deepEqual(parseRunbooksBlock(''), { topics: [], errors: [] });
  assert.deepEqual(parseRunbooksBlock(null), { topics: [], errors: [] });
});

test('a malformed block is reported, never guessed at', () => {
  assert.deepEqual(parseRunbooksBlock('---\nrunbooks: git-workflow\n---\n').errors,
    ['runbooks: must be a list, one "- topic:" per item']);
  assert.deepEqual(parseRunbooksBlock('---\nrunbooks:\n---\n').errors, ['runbooks: declares no topic']);
  assert.deepEqual(parseRunbooksBlock('---\nrunbooks:\n  - git-workflow\n---\n').errors,
    ['unreadable line in runbooks: "- git-workflow"', 'runbooks: declares no topic']);
  assert.deepEqual(parseRunbooksBlock('---\nrunbooks:\n    at: landing\n  - topic: a\n---\n').errors,
    ['unreadable line in runbooks: "at: landing"']);
  assert.deepEqual(parseRunbooksBlock('---\nrunbooks:\n  - topic: a\n  - topic: a\n---\n').errors,
    ['duplicate topic "a"']);
});

test('topicKey and slugOf normalise', () => {
  assert.equal(topicKey('  a   b\tc '), 'a b c');
  assert.equal(slugOf('sub\\git-workflow.md'), 'sub/git-workflow');
});

test('findSkill looks in the project, then the config dir, then the newest plugin version', (t) => {
  const base = tmp(t);
  execFileSync('git', ['init', '-q', base]);
  const configDir = path.join(base, 'cfg');
  const opts = { cwd: base, home: base, configDir };
  assert.equal(findSkill('swarm', opts), null);
  const cache = (v) => path.join(configDir, 'plugins', 'cache', 'market', 'tools', v, 'skills', 'swarm', 'SKILL.md');
  put(cache('1.9.0'), 'old');
  put(cache('1.10.0'), 'new');
  put(cache('not-a-version'), 'junk');
  assert.equal(findSkill('swarm', opts), cache('1.10.0'), 'semver, not string order');
  assert.equal(findSkill('tools:swarm', opts), cache('1.10.0'));
  assert.equal(findSkill('other:swarm', opts), null);
  const user = path.join(configDir, 'skills', 'swarm', 'SKILL.md');
  put(user, 'user');
  assert.equal(findSkill('swarm', opts), user);
  const agents = path.join(base, '.agents', 'skills', 'swarm', 'SKILL.md');
  put(agents, 'agents');
  assert.equal(findSkill('swarm', opts), agents);
  const project = path.join(base, '.claude', 'skills', 'swarm', 'SKILL.md');
  put(project, 'project');
  assert.equal(findSkill('swarm', opts), project);
  assert.equal(findSkill('tools:swarm', opts), cache('1.10.0'), 'a plugin name skips the project');
  const given = path.join(base, 'given');
  put(path.join(given, 'swarm', 'SKILL.md'), 'given');
  assert.equal(findSkill('swarm', { ...opts, skillsDir: given }), path.join(given, 'swarm', 'SKILL.md'));
});

test('findSkill refuses a name that could leave a skills folder', (t) => {
  const base = tmp(t);
  execFileSync('git', ['init', '-q', base]);
  put(path.join(base, 'secret', 'SKILL.md'), 'x');
  put(path.join(base, '.claude', 'skills', 'ok', 'SKILL.md'), 'x');
  const opts = { cwd: base, home: base, configDir: path.join(base, 'cfg') };
  for (const name of ['../../secret', '..\\..\\secret', '..', '.', '', 'a/b', 'p:../x', '../p:ok', 'a:b:c', null, undefined, 7]) {
    assert.equal(findSkill(name, opts), null, String(name));
  }
  assert.ok(findSkill('ok', opts));
});

test('the topics map round-trips sorted, and a broken file is never read as empty', (t) => {
  const root = tmp(t);
  assert.deepEqual(loadTopics(root), {});
  assert.deepEqual(loadTopics(null), {});
  saveTopics(root, { b: { slug: 'y' }, a: { slug: 'x' } });
  assert.equal(fs.readFileSync(path.join(root, 'topics.json'), 'utf8'), '{\n "a": {\n  "slug": "x"\n },\n "b": {\n  "slug": "y"\n }\n}\n');
  assert.deepEqual(fs.readdirSync(root), ['topics.json'], 'no temp file left behind');
  for (const bad of ['{not json', '[]', '"text"', 'null']) {
    fs.writeFileSync(path.join(root, 'topics.json'), bad);
    assert.throws(() => loadTopics(root), (e) => e.code === 'BAD_TOPICS', bad);
  }
});

const books = [
  { file: 'git-workflow.md', type: 'procedure', purpose: 'Branch, push and open a pull request.' },
  { file: 'model-routing.md', type: 'standard', purpose: 'Which model tier a task gets.' },
];

test('a mapped topic costs no call, and a hand-written entry needs only a slug', async () => {
  const map = { 'push topic': { slug: 'git-workflow' } };
  const never = async () => { throw new Error('called'); };
  const r = await resolveTopics([{ topic: 'push topic', at: ['landing'] }], { map, books, judgeFn: never, writeBar: 0.85, today: '2026-09-30' });
  assert.deepEqual(r.unresolved, []);
  assert.deepEqual(r.resolved, [{ topic: 'push topic', at: ['landing'], book: books[0], p: undefined }]);
});

test('an unmapped topic is judged, written at or above the bar, and reported under it', async () => {
  const map = {};
  const saved = [];
  const scores = { 'tier topic': { ok: true, ranked: [{ file: 'model-routing.md', p: 0.853 }, { file: 'git-workflow.md', p: 0.2 }] },
    'weak topic': { ok: true, ranked: [{ file: 'git-workflow.md', p: 0.849 }] },
    'empty topic': { ok: true, ranked: [] },
    'down topic': { ok: false, why: 'timeout', ranked: [] } };
  const r = await resolveTopics(Object.keys(scores).map((topic) => ({ topic, at: [] })), {
    map, books, judgeFn: async (t) => scores[t], writeBar: 0.85, today: '2026-09-30',
    onMapped: (m) => saved.push(JSON.stringify(m)) });
  assert.deepEqual(r.resolved.map((x) => [x.topic, x.book.file, x.p]), [['tier topic', 'model-routing.md', 0.853]]);
  assert.deepEqual(map, { 'tier topic': { slug: 'model-routing', score: 0.85, purpose: purposeHash(books[1].purpose), checked: '2026-09-30' } });
  assert.equal(saved.length, 1, 'saved once per mapped topic, so a later failure loses no paid call');
  assert.deepEqual(r.unresolved, [
    { topic: 'weak topic', at: [], why: 'best was git-workflow at 0.85, under 0.85' },
    { topic: 'empty topic', at: [], why: 'nothing scored' },
    { topic: 'down topic', at: [], why: 'no score (timeout)' },
  ]);
});

test('an entry whose runbook is gone is unresolved, and re-judged when a judge is given', async () => {
  const map = { 'push topic': { slug: 'old-git', score: 0.9 } };
  const off = await resolveTopics([{ topic: 'push topic', at: [] }], { map, books, judgeFn: null, writeBar: 0.85, today: '2026-09-30' });
  assert.deepEqual(off.unresolved, [{ topic: 'push topic', at: [], why: 'mapped to old-git, which is not a live runbook' }]);
  const none = await resolveTopics([{ topic: 'new topic', at: [] }], { map, books, judgeFn: null, writeBar: 0.85, today: '2026-09-30' });
  assert.deepEqual(none.unresolved, [{ topic: 'new topic', at: [], why: 'not mapped' }]);
  const on = await resolveTopics([{ topic: 'push topic', at: [] }], { map, books, writeBar: 0.85, today: '2026-09-30',
    judgeFn: async () => ({ ok: true, ranked: [{ file: 'git-workflow.md', p: 0.9 }] }) });
  assert.equal(on.resolved[0].book.file, 'git-workflow.md');
  assert.equal(map['push topic'].slug, 'git-workflow');
});

// Spec gate 4: offline against a stub map and a stub skills dir, no router call.
function fixture(t) {
  const base = tmp(t, 'rb-res-cli-');
  execFileSync('git', ['init', '-q', base]);
  const docs = path.join(base, 'docs', 'runbooks');
  for (const b of books) put(path.join(docs, b.file), `# T\n**Type:** ${b.type}\n**Purpose:** ${b.purpose}\n`);
  put(path.join(base, 'skills', 'swarm', 'SKILL.md'), SKILL);
  put(path.join(base, 'skills', 'plain', 'SKILL.md'), '---\nname: plain\n---\nbody');
  put(path.join(base, '.runbooks', 'topics.json'), JSON.stringify({
    'branching, pushing and opening a pull request on this host': { slug: 'git-workflow' },
    'which model tier a task gets': { slug: 'model-routing' },
  }));
  const env = { ...process.env, HOME: base, USERPROFILE: base, LOCALAPPDATA: base, RUNBOOKS_DIR: '', CLAUDE_CONFIG_DIR: '', OPENROUTER_API_KEY: '' };
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--skills-dir', path.join(base, 'skills'), ...args], { cwd: base, env, encoding: 'utf8' });
  return { base, docs, run };
}

test('the CLI prints the mapped paths and exits 1 naming what is unresolved', (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.base, '.runbooks', 'topics.json'), 'utf8');
  const r = f.run('--skill', 'swarm');
  assert.equal(r.stdout, `${slash(path.join(f.docs, 'git-workflow.md'))}\n${slash(path.join(f.docs, 'model-routing.md'))}\n`);
  assert.match(r.stderr, /unresolved: filing an issue on this host \(no score \(no key\)\)/);
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(path.join(f.base, '.runbooks', 'topics.json'), 'utf8'), before, 'a failed judge writes nothing');
});

test('--at keeps only the topics read at that step', (t) => {
  const f = fixture(t);
  const r = f.run('--skill', 'swarm', '--at', 'landing');
  assert.equal(r.stdout, `${slash(path.join(f.docs, 'git-workflow.md'))}\n`);
  assert.equal(r.status, 0, r.stderr);
});

test('--inject prints contents under a path heading', (t) => {
  const f = fixture(t);
  const r = f.run('--skill', 'swarm', '--at', 'landing', '--inject');
  assert.equal(r.stdout, `## ${slash(path.join(f.docs, 'git-workflow.md'))}\n# T\n**Type:** procedure\n**Purpose:** Branch, push and open a pull request.\n\n`);
});

test('--inject stays boolean when a stray token follows it', (t) => {
  const f = fixture(t);
  const plain = f.run('--skill', 'swarm', '--at', 'landing', '--inject');
  const stray = f.run('--skill', 'swarm', '--at', 'landing', '--inject', 'stray');
  assert.equal(stray.status, plain.status, stray.stderr);
  assert.equal(stray.stdout, plain.stdout);
});

test('silent exit 0: a skill with no block, and a host with no runbooks folder (spec gate 6)', (t) => {
  const f = fixture(t);
  const plain = f.run('--skill', 'plain');
  assert.deepEqual([plain.status, plain.stdout, plain.stderr], [0, '', '']);
  fs.rmSync(path.join(f.base, 'docs'), { recursive: true, force: true });
  fs.rmSync(path.join(f.base, '.runbooks'), { recursive: true, force: true });
  const bare = f.run('--skill', 'swarm');
  assert.deepEqual([bare.status, bare.stdout, bare.stderr], [0, '', '']);
});

test('exit 2: no --skill, an unknown skill, a malformed block, a broken map left untouched', (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 2);
  const unknown = f.run('--skill', 'nope');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /no skill named nope/);
  put(path.join(f.base, 'skills', 'bad', 'SKILL.md'), '---\nrunbooks: x\n---\n');
  const bad = f.run('--skill', 'bad');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /must be a list/);
  fs.writeFileSync(path.join(f.base, '.runbooks', 'topics.json'), '{hand edit');
  const broken = f.run('--skill', 'swarm');
  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /topics\.json is not a JSON object/);
  assert.equal(fs.readFileSync(path.join(f.base, '.runbooks', 'topics.json'), 'utf8'), '{hand edit');
});

// Fix round 1: a value the fixed shape cannot read is an error, never a guess.
const UNSUPPORTED = (line) => `unsupported value in runbooks: "${line}", write plain text or quote it`;

test('a flow list in at: is reported and the topic keeps no steps', () => {
  assert.deepEqual(parseRunbooksBlock('---\nrunbooks:\n  - topic: a\n    at: [landing, audit]\n---\n'),
    { topics: [{ topic: 'a', at: [] }], errors: [UNSUPPORTED('at: [landing, audit]')] });
});

test('an inline comment on a topic is reported and the topic is not added', () => {
  assert.deepEqual(parseRunbooksBlock('---\nrunbooks:\n  - topic: a # note\n  - topic: b\n---\n'),
    { topics: [{ topic: 'b', at: [] }], errors: [UNSUPPORTED('- topic: a # note')] });
});

test('a quoted value keeps its # and parses with no error', () => {
  assert.deepEqual(parseRunbooksBlock('---\nrunbooks:\n  - topic: "issue #12 triage"\n---\n'),
    { topics: [{ topic: 'issue #12 triage', at: [] }], errors: [] });
});

test('a block scalar marker as a topic is reported', () => {
  assert.deepEqual(parseRunbooksBlock('---\nrunbooks:\n  - topic: >-\n  - topic: b\n---\n'),
    { topics: [{ topic: 'b', at: [] }], errors: [UNSUPPORTED('- topic: >-')] });
});

test('a second at: on one item is reported', () => {
  assert.deepEqual(parseRunbooksBlock('---\nrunbooks:\n  - topic: a\n    at: landing\n    at: audit\n---\n'),
    { topics: [{ topic: 'a', at: ['landing'] }], errors: ['second at: for topic "a"'] });
});

test('a topic named after an Object key is looked up as an own key only', async () => {
  const r = await resolveTopics([{ topic: 'constructor', at: [] }, { topic: '__proto__', at: [] }],
    { map: {}, books, judgeFn: null, writeBar: 0.85, today: '2026-09-30' });
  assert.deepEqual(r.unresolved, [
    { topic: 'constructor', at: [], why: 'not mapped' },
    { topic: '__proto__', at: [], why: 'not mapped' },
  ]);
});

test('the CLI exits 2 on an unsupported value and leaves the map untouched', (t) => {
  const f = fixture(t);
  put(path.join(f.base, 'skills', 'flow', 'SKILL.md'), '---\nrunbooks:\n  - topic: which model tier a task gets\n    at: [landing]\n---\n');
  const before = fs.readFileSync(path.join(f.base, '.runbooks', 'topics.json'), 'utf8');
  const r = f.run('--skill', 'flow');
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /unsupported value in runbooks: "at: \[landing\]", write plain text or quote it/);
  assert.equal(fs.readFileSync(path.join(f.base, '.runbooks', 'topics.json'), 'utf8'), before);
});

// Fix round 2: a judged topic is written as an own key, or `__proto__` is paid for on every run.
test('a judged __proto__ topic is written as an own key and round-trips with no second call', async (t) => {
  let calls = 0;
  const judgeFn = async () => { calls += 1; return { ok: true, ranked: [{ file: 'git-workflow.md', p: 0.95 }] }; };
  const opts = { books, judgeFn, writeBar: 0.85, today: '2026-09-30' };
  const map = {};
  const first = await resolveTopics([{ topic: '__proto__', at: [] }], { ...opts, map });
  assert.equal(first.resolved.length, 1);
  assert.equal(Object.hasOwn(map, '__proto__'), true);
  assert.deepEqual(Object.keys(map), ['__proto__']);
  assert.equal(Object.getPrototypeOf(map), Object.prototype);
  assert.equal(map['__proto__'].slug, 'git-workflow');
  assert.equal(calls, 1);

  const root = tmp(t);
  saveTopics(root, map);
  const loaded = loadTopics(root);
  assert.equal(Object.hasOwn(loaded, '__proto__'), true);
  const second = await resolveTopics([{ topic: '__proto__', at: [] }], { ...opts, map: loaded });
  assert.deepEqual(second.resolved.map((x) => x.book.file), ['git-workflow.md']);
  assert.equal(calls, 1, 'the loaded map answers, no second paid call');
});

test('#121: a repo with docs/runbooks and no .runbooks/ never writes home\'s map', (t) => {
  const f = fixture(t);
  const home = tmp(t, 'rb-res-home-');
  const homeMap = path.join(home, '.runbooks', 'topics.json');
  put(homeMap, JSON.stringify({ 'which model tier a task gets': { slug: 'model-routing' } }));
  fs.rmSync(path.join(f.base, '.runbooks'), { recursive: true, force: true });
  const before = fs.readFileSync(homeMap, 'utf8');
  const r = spawnSync(process.execPath, [SCRIPT, '--skills-dir', path.join(f.base, 'skills'), '--skill', 'swarm'],
    { cwd: f.base, encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, RUNBOOKS_DIR: '', CLAUDE_CONFIG_DIR: '', OPENROUTER_API_KEY: '' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`Create ${slash(path.join(f.base, '.runbooks')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(fs.readFileSync(homeMap, 'utf8'), before);
});

test('#121: the lint turns a foreign map\'s findings into advisories', (t) => {
  const base = tmp(t);
  execFileSync('git', ['init', '-q', base]);
  put(path.join(base, '.claude', 'skills', 'swarm', 'SKILL.md'), SKILL);
  const root = path.join(base, 'elsewhere', '.runbooks');
  put(path.join(root, 'topics.json'), JSON.stringify({ 'which model tier a task gets': { slug: 'gone' } }));
  const args = { top: base, configDir: path.join(base, 'cfg'), root, books: [] };
  const own = skillViolations({ ...args, foreign: false });
  assert.ok(own.violations.some((v) => v.includes('mapped to gone')));
  const foreign = skillViolations({ ...args, foreign: true });
  assert.deepEqual(foreign.violations, []);
  assert.ok(foreign.advisories.some((v) => v.includes('mapped to gone')));
  assert.ok(foreign.advisories.some((v) => v.includes('is not mapped')));
});

test('#121: a corrupt foreign topics.json is an advisory, a corrupt own one a violation', (t) => {
  const base = tmp(t);
  execFileSync('git', ['init', '-q', base]);
  const root = path.join(base, 'elsewhere', '.runbooks');
  put(path.join(root, 'topics.json'), '{ not json');
  const args = { top: base, configDir: path.join(base, 'cfg'), root, books: [] };
  const own = skillViolations({ ...args, foreign: false });
  assert.ok(own.violations.some((v) => v.includes('is not a JSON object')));
  const foreign = skillViolations({ ...args, foreign: true });
  assert.deepEqual(foreign.violations, []);
  assert.ok(foreign.advisories.some((v) => v.includes('is not a JSON object')));
});

test('#121: a repo whose own .runbooks/ does not own its runbooks is told to set dir, not to create it', (t) => {
  const base = tmp(t);
  execFileSync('git', ['init', '-q', base]);
  put(path.join(base, '.claude', 'skills', 'swarm', 'SKILL.md'), SKILL);
  const root = path.join(base, '.runbooks');
  put(path.join(root, 'topics.json'), '{}');
  const r = skillViolations({ top: base, configDir: path.join(base, 'cfg'), root, books: [], foreign: true });
  const want = `set dir in ${slash(path.join(root, 'config.json'))} to the runbooks it should map`;
  assert.ok(r.advisories.some((a) => a.toLowerCase().includes(want.toLowerCase())), r.advisories.join('\n'));
  assert.ok(!r.advisories.some((a) => a.includes('Create ')), r.advisories.join('\n'));
});

test('#121: the CLI tells a repo with its own .runbooks/ and no docs/runbooks to set dir', (t) => {
  const base = tmp(t);
  execFileSync('git', ['init', '-q', base]);
  put(path.join(base, 'skills', 'swarm', 'SKILL.md'), SKILL);
  fs.mkdirSync(path.join(base, '.runbooks'));
  // No docs/runbooks in the repo, so the runbooks folder falls back to home's.
  const home = tmp(t, 'rb-res-home-');
  for (const b of books) put(path.join(home, 'docs', 'runbooks', b.file), `# T\n**Type:** ${b.type}\n**Purpose:** ${b.purpose}\n`);
  const r = spawnSync(process.execPath, [SCRIPT, '--skills-dir', path.join(base, 'skills'), '--skill', 'swarm'],
    { cwd: base, encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, RUNBOOKS_DIR: '', CLAUDE_CONFIG_DIR: '', OPENROUTER_API_KEY: '' } });
  assert.equal(r.status, 1, r.stderr);
  const want = `set dir in ${slash(path.join(base, '.runbooks', 'config.json'))} to the runbooks it should map`;
  assert.ok(r.stderr.toLowerCase().includes(want.toLowerCase()), r.stderr);
  assert.doesNotMatch(r.stderr, /Create /);
  assert.equal(fs.existsSync(path.join(base, '.runbooks', 'topics.json')), false);
});

test('#122: newestVersion takes semver first, then the newest SHA folder by mtime', (t) => {
  const plug = tmp(t);
  for (const v of ['abc123', 'def456']) fs.mkdirSync(path.join(plug, v));
  fs.utimesSync(path.join(plug, 'abc123'), new Date(2026, 0, 2), new Date(2026, 0, 2));
  fs.utimesSync(path.join(plug, 'def456'), new Date(2026, 0, 1), new Date(2026, 0, 1));
  assert.equal(newestVersion(plug), 'abc123', 'newest mtime, not name order');
  fs.mkdirSync(path.join(plug, '1.0.0'));
  assert.equal(newestVersion(plug), '1.0.0', 'any semver folder beats a SHA folder');
  assert.equal(newestVersion(path.join(plug, 'missing')), null);
  fs.writeFileSync(path.join(plug, 'zzz.lock'), '');
  fs.utimesSync(path.join(plug, 'zzz.lock'), new Date(2026, 5, 1), new Date(2026, 5, 1));
  fs.rmSync(path.join(plug, '1.0.0'), { recursive: true });
  assert.equal(newestVersion(plug), 'abc123', 'a stray file with the newest mtime is not a version');
});

test('#122: the hook and the lint read the same SHA-named folder', (t) => {
  const base = tmp(t);
  execFileSync('git', ['init', '-q', base]);
  const configDir = path.join(base, 'cfg');
  const dir = (v) => path.join(configDir, 'plugins', 'cache', 'm', 'ctx', v);
  // The newest folder by mtime is FIRST by name, so a readdir-order pop would pick the wrong one.
  put(path.join(dir('aaa111'), 'skills', 'docs', 'SKILL.md'), '---\nname: docs\nrunbooks:\n  - topic: a topic only the newest has\n---\nnew');
  put(path.join(dir('bbb222'), 'skills', 'docs', 'SKILL.md'), '---\nname: docs\n---\nold');
  fs.utimesSync(dir('aaa111'), new Date(2026, 0, 2), new Date(2026, 0, 2));
  fs.utimesSync(dir('bbb222'), new Date(2026, 0, 1), new Date(2026, 0, 1));
  assert.equal(findSkill('ctx:docs', { cwd: base, home: base, configDir }), path.join(dir('aaa111'), 'skills', 'docs', 'SKILL.md'));
  const lint = skillViolations({ top: base, configDir, root: null, books: [], foreign: false });
  assert.ok(lint.advisories.some((a) => a.includes('a topic only the newest has')), 'the lint read aaa111 too');
});
