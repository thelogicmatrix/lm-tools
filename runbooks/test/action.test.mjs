import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTriggers, matchCommand, matches, segments, triggersFile } from '../scripts/action.mjs';
import { readSent } from '../scripts/session.mjs';

const slash = (p) => String(p).replace(/\\/g, '/');

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'action.mjs');
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

test('segments cuts on operators outside quotes and keeps only bare tokens', () => {
  assert.deepEqual(segments('cd x && git push -u origin feat/y'), [['cd', 'x'], ['git', 'push', 'origin', 'feat/y']]);
  assert.deepEqual(segments('A=1 B=2 git push; ls | wc -l'), [['git', 'push'], ['ls'], ['wc']]);
  assert.deepEqual(segments('git commit -m "a && git push"'), [['git', 'commit']]);
  assert.deepEqual(segments("git commit -m 'x; git push'"), [['git', 'commit']]);
  assert.deepEqual(segments('echo $(git push)'), [['echo', '$'], ['git', 'push']]);
  assert.deepEqual(segments('git push\ngit status'), [['git', 'push'], ['git', 'status']]);
  assert.deepEqual(segments('git push\r\ngit status'), [['git', 'push'], ['git', 'status']]);
  assert.deepEqual(segments('say "unclosed git push'), [['say']]);
  assert.deepEqual(segments('git push"x" origin'), [['git', 'origin']]);
  assert.deepEqual(segments(''), []);
  assert.deepEqual(segments(undefined), []);
  assert.deepEqual(segments(7), []);
});

test('a heredoc body is not part of the command', () => {
  const cmd = 'git commit -F - <<\'EOF\'\nsubject\n\nthen git push the branch\nEOF\ngit status';
  assert.deepEqual(segments(cmd), [['git', 'commit'], ['git', 'status']]);
  const inSub = 'git commit -m "$(cat <<EOF\ngit push later\nEOF\n)"';
  assert.deepEqual(segments(inSub), [['git', 'commit']]);
});

test('a PowerShell here-string body is not part of the command', () => {
  const single = "git commit -m @'\nthis doesn't fire\n'@; if ($?) { git push -u origin feat/x }";
  assert.deepEqual(segments(single), [['git', 'commit'], ['if'], ['$?'], ['{', 'git', 'push', 'origin', 'feat/x', '}']]);
  const mention = "git commit -m @'\ndon't git push yet\n'@";
  assert.deepEqual(segments(mention), [['git', 'commit']]);
  const double = 'git commit -m @"\nsay "hi" and git push later\n"@\r\ngit status';
  assert.deepEqual(segments(double), [['git', 'commit'], ['git', 'status']]);
  const crlf = "git commit -m @'\r\ndoesn't fire\r\n'@; git push origin x";
  assert.deepEqual(segments(crlf), [['git', 'commit'], ['git', 'push', 'origin', 'x']]);
});

const hit = (trigger, command) => matchCommand(command, [{ words: trigger.split(' '), rel: 'r.md', path: '/d/r.md', purpose: 'p' }]).length === 1;

test('a here-string does not hide or fake a push through matchCommand', () => {
  assert.ok(hit('git push', "git commit -m @'\nthis doesn't fire\n'@; if ($?) { git push -u origin feat/x }"));
  assert.ok(!hit('git push', "git commit -m @'\ndon't git push yet\n'@"));
  assert.ok(!hit('git push', 'git commit -m @"\nnever git push here\n"@'));
});

test('git push matches where git push runs', () => {
  for (const c of ['git push', 'git push -u origin feat/x', 'cd x && git push', 'git -C docs/runbooks push',
    'SECRET_OK=1 git push', 'rtk proxy git push', 'Git.exe push', '/usr/bin/git push', 'C:/tools/git.exe push',
    'git push || git push', 'true; git   push']) {
    assert.ok(hit('git push', c), c);
  }
});

test('git push does not match where the words are only mentioned', () => {
  for (const c of ['git pushd', 'git commit -m "git push later"', "echo 'git push'", 'git status', 'push git',
    'gitx push', 'git', 'git commit -F - <<EOF\ngit push\nEOF', 'a b c git push', 'git a b c push', '', 'git push"x"']) {
    assert.ok(!hit('git push', c), c);
  }
});

test('a quoted command after a shell or ssh is read as a command', () => {
  assert.deepEqual(segments("ssh box 'cd /x && git push'"), [['ssh', 'box'], ['cd', '/x'], ['git', 'push']]);
  assert.deepEqual(segments('bash -lc "git push"; ls'), [['bash'], ['git', 'push'], ['ls']]);
  for (const c of ["ssh box 'git push'", 'ssh -p 22 root@box "cd /x && git push"', 'bash -lc "git push"', "sh -c 'git push'",
    'powershell.exe -Command "git push"', 'pwsh -c "git push"', 'rtk proxy ssh box "git push"',
    'ssh box "bash -lc \'git push\'"', 'ssh box "git -C \\"/x y\\" push"']) {
    assert.ok(hit('git push', c), c);
  }
  assert.ok(hit('ssh box', "ssh box 'git push'"), 'the wrapper itself still matches its own trigger');
});

test('quotes after anything that is not a wrapper stay arguments', () => {
  for (const c of ['ssh box \'echo "git push"\'', 'ssh box "git commit -m \'git push\'"', 'echo "bash -lc \'git push\'"',
    'grep "git push" notes.txt', 'a b c ssh box "git push"', 'ssh box "unclosed git push', "bash -lc ''"]) {
    assert.ok(!hit('git push', c), c);
  }
});

test('nesting stops at three levels and never throws', () => {
  const deep = `ssh a "ssh b 'ssh c \\"ssh d \\\\\\"git push\\\\\\"\\"'"`;
  assert.doesNotThrow(() => segments(deep));
  assert.ok(segments(deep).length >= 1);
});

test('the accepted false positives stay what they are', () => {
  assert.ok(hit('git push', 'git stash push'));
  assert.ok(hit('git push', 'echo git push'));
});

test('a three-word trigger and a one-word trigger', () => {
  assert.ok(hit('fj pr create', 'fj pr -R origin create'));
  assert.ok(hit('fj pr create', 'fj -R origin pr create --title x'));
  assert.ok(!hit('fj pr create', 'fj pr list'));
  assert.ok(!hit('fj pr create', 'fj create pr'));
  assert.ok(hit('terraform', 'terraform apply'));
  assert.ok(!hit('terraform', 'echo done; ls terraform.tf'));
});

test('matches needs the first word among the first three bare tokens', () => {
  assert.equal(matches(['git', 'push'], ['a', 'b', 'git', 'push']), true);
  assert.equal(matches(['git', 'push'], ['a', 'b', 'c', 'git', 'push']), false);
  assert.equal(matches([], ['git']), false);
});

test('buildTriggers reads the header field, and matchCommand returns a runbook once', () => {
  const books = [
    { file: 'git-workflow.md', purpose: 'Branch and push.', triggers: 'git push, git worktree add' },
    { file: 'plain.md', purpose: 'No triggers.', triggers: null },
  ];
  const trig = buildTriggers(books, 'C:\\r\\docs');
  assert.deepEqual(trig, [
    { words: ['git', 'push'], rel: 'git-workflow.md', path: 'C:/r/docs/git-workflow.md', purpose: 'Branch and push.' },
    { words: ['git', 'worktree', 'add'], rel: 'git-workflow.md', path: 'C:/r/docs/git-workflow.md', purpose: 'Branch and push.' },
  ]);
  assert.deepEqual(matchCommand('git worktree add ../x && git push', trig).map((m) => m.rel), ['git-workflow.md']);
  assert.deepEqual(matchCommand('git status', trig), []);
  assert.deepEqual(matchCommand('git push', []), []);
});

function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rb-act-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', base]);
  const docs = path.join(base, 'docs', 'runbooks');
  put(path.join(docs, 'git-workflow.md'), '# G\n**Type:** procedure\n**Purpose:** Branch, push and open a pull request.\n**Triggers:** git push\n\n## Steps\n1. x\n');
  put(path.join(docs, 'dead.md'), '# D\n**Type:** procedure\n**Status:** retired 2026-09-01 — replaced\n**Purpose:** Old push steps.\n**Triggers:** git push\n');
  const env = { ...process.env, HOME: base, USERPROFILE: base, LOCALAPPDATA: base, RUNBOOKS_DIR: '', CLAUDE_CONFIG_DIR: '' };
  const hook = (payload) => spawnSync(process.execPath, [SCRIPT],
    { cwd: base, env, encoding: 'utf8', input: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  return { base, docs, hook, state: path.join(base, 'claude-router') };
}
const bash = (f, command, extra = {}) => ({ session_id: 's1', cwd: f.base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra });

test('the hook injects a governed command once per conversation, and never a retired runbook', (t) => {
  const f = fixture(t);
  const r = f.hook(bash(f, 'git push -u origin feat/x'));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(Object.keys(out).sort().join(), 'additionalContext,hookEventName', 'no permission decision, ever');
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.additionalContext, 'Runbooks that govern this command (read before the next one like it):\n'
    + `- ${slash(path.join(f.docs, 'git-workflow.md'))} — Branch, push and open a pull request.`);
  assert.deepEqual(readSent('s1\0', f.state), ['git-workflow.md']);
  const again = f.hook(bash(f, 'git push'));
  assert.deepEqual([again.status, again.stdout], [0, '']);
  // A subagent is another conversation, and PowerShell is another shell.
  const worker = f.hook(bash(f, 'git push', { agent_id: 'a1', tool_name: 'PowerShell' }));
  assert.match(worker.stdout, /git-workflow\.md/);
});

test('the trigger index is built once per session and reused', (t) => {
  const f = fixture(t);
  f.hook(bash(f, 'git status'));
  const cache = triggersFile('s1', f.base, f.state);
  assert.deepEqual(JSON.parse(fs.readFileSync(cache, 'utf8')).triggers.map((x) => x.rel), ['git-workflow.md']);
  // The cache is what is read now: a runbook that gains a trigger mid-session waits for the next one.
  fs.writeFileSync(path.join(f.docs, 'git-workflow.md'), '# G\n**Type:** procedure\n**Purpose:** P.\n**Triggers:** git fetch\n\n## Steps\n1. x\n');
  assert.match(f.hook(bash(f, 'git push')).stdout, /git-workflow\.md/);
  assert.equal(f.hook(bash(f, 'git fetch', { session_id: 's2' })).stdout.includes('git-workflow.md'), true, 'a new session rebuilds');
});

test('the hook is silent and exits 0 on anything it cannot use', (t) => {
  const f = fixture(t);
  const silent = (p, why) => { const r = f.hook(p); assert.deepEqual([r.status, r.stdout], [0, ''], `${why}: ${r.stderr}`); };
  silent('not json', 'bad stdin');
  silent('', 'empty stdin');
  silent(bash(f, 'git status'), 'no match');
  silent({ ...bash(f, 'git push'), tool_input: {} }, 'no command');
  silent({ ...bash(f, 'git push'), tool_input: { command: 7 } }, 'a command that is not text');
  fs.mkdirSync(f.state, { recursive: true });
  fs.writeFileSync(triggersFile('s3', f.base, f.state), '{broken');
  assert.match(f.hook(bash(f, 'git push', { session_id: 's3' })).stdout, /git-workflow\.md/, 'a broken cache is rebuilt');
});

test('no session id: it still informs, and shares no file', (t) => {
  const f = fixture(t);
  const p = bash(f, 'git push');
  delete p.session_id;
  assert.match(f.hook(p).stdout, /git-workflow\.md/);
  assert.match(f.hook(p).stdout, /git-workflow\.md/);
  assert.deepEqual(fs.existsSync(f.state) ? fs.readdirSync(f.state) : [], []);
});

test('a host with no runbooks folder is silent, and says so once in the cache', (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.base, 'docs'), { recursive: true, force: true });
  const r = f.hook(bash(f, 'git push'));
  assert.deepEqual([r.status, r.stdout], [0, '']);
  assert.deepEqual(JSON.parse(fs.readFileSync(triggersFile('s1', f.base, f.state), 'utf8')).triggers, []);
});

test('a session that moves to another folder builds that folder its own index', (t) => {
  const f = fixture(t);
  // A second repo with no runbooks folder, and a home of its own so config.mjs's
  // <home>/docs/runbooks fallback cannot find the fixture's. Only the state folder is shared.
  const other = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rb-act-other-')));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', other]);
  const env = { ...process.env, HOME: other, USERPROFILE: other, LOCALAPPDATA: f.base, RUNBOOKS_DIR: '', CLAUDE_CONFIG_DIR: '' };
  const first = spawnSync(process.execPath, [SCRIPT],
    { cwd: other, env, encoding: 'utf8', input: JSON.stringify({ ...bash(f, 'git status'), session_id: 'cwdswitch', cwd: other }) });
  assert.deepEqual([first.status, first.stdout], [0, '']);
  const second = f.hook(bash(f, 'git push', { session_id: 'cwdswitch' }));
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /git-workflow\.md/);
  assert.equal(fs.readdirSync(f.state).filter((n) => /^triggers-[0-9a-f]{12}\.json$/.test(n)).length, 2);
});
