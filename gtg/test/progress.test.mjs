import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'gtg', 'gtg.mjs');
const TASKS = [
  { id: 'task-1', purpose: 'Build persistent progress' },
  { id: 'task-2', purpose: 'Document the orchestration contract' },
];

function tempHub() {
  const root = mkdtempSync(join(tmpdir(), 'gtg-progress-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  return root;
}

function gtg(root, args, input = '') {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      GTG_HUB: root,
      GTG_NO_SYNC: '1',
      GTG_SESSION_ID: 'progress-test',
      GIT_CEILING_DIRECTORIES: tmpdir(),
    },
  });
}

function gtgAsync(root, args, input = '') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: root,
      env: {
        ...process.env,
        GTG_HUB: root,
        GTG_NO_SYNC: '1',
        GTG_SESSION_ID: 'progress-test',
        GIT_CEILING_DIRECTORIES: tmpdir(),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

function recordPath(root, slug = 'alpha') {
  return join(root, 'docs', 'handoffs', 'progress', `${slug}.json`);
}

function readRecord(root, slug = 'alpha') {
  return JSON.parse(readFileSync(recordPath(root, slug), 'utf8'));
}

function init(root, tasks = TASKS, extra = []) {
  return gtg(root, [
    'progress', 'init', 'alpha', '--project', 'Alpha', '--plan', 'docs/plans/alpha.md',
    ...extra,
  ], JSON.stringify(tasks));
}

test('progress init creates a validated versioned record without deriving task IDs', () => {
  const root = tempHub();
  const r = gtg(root, [
    'progress', 'init', 'alpha', '--project', 'Alpha', '--plan', 'docs/plans/alpha.md',
    '--stage', 'implementation', '--next-action', 'Start task-1',
  ], JSON.stringify(TASKS));

  assert.equal(r.status, 0, r.stderr);
  const record = readRecord(root);
  assert.equal(record.version, 1);
  assert.equal(record.slug, 'alpha');
  assert.equal(record.project, 'Alpha');
  assert.equal(record.plan, 'docs/plans/alpha.md');
  assert.equal(record.revision, 1);
  assert.equal(record.stage, 'implementation');
  assert.equal(record.nextAction, 'Start task-1');
  assert.deepEqual(record.tasks.map(({ id, purpose, status }) => ({ id, purpose, status })), [
    { id: 'task-1', purpose: 'Build persistent progress', status: 'pending' },
    { id: 'task-2', purpose: 'Document the orchestration contract', status: 'pending' },
  ]);
  assert.ok(record.createdAt && record.updatedAt);
  assert.match(r.stdout, /Initialized Alpha progress at revision 1/);
});

test('progress init accepts zero tasks and refuses unsafe, duplicate, malformed, or existing state without overwriting', () => {
  const emptyRoot = tempHub();
  let r = init(emptyRoot, []);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readRecord(emptyRoot).tasks, []);

  const root = tempHub();
  r = init(root, [TASKS[0], TASKS[0]]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /duplicate task id/);
  assert.equal(existsSync(recordPath(root)), false);

  r = init(root, [TASKS[0], { id: 'TASK-1', purpose: 'case collision' }]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /case-insensitive/);
  assert.equal(existsSync(recordPath(root)), false);

  r = gtg(root, ['progress', 'init', '../escape', '--project', 'X', '--plan', 'p'], '[]');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /slug must start/);
  assert.equal(existsSync(join(root, 'docs', 'handoffs', 'escape.json')), false);

  r = init(root, [{ id: 'task-1', purpose: 'x', constructor: 'pollute' }]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown field/);
  assert.equal({}.pollute, undefined);

  r = init(root, [{ id: 'task-1', purpose: 'safe line\n## Injected heading' }]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /control characters/);
  assert.equal(existsSync(recordPath(root)), false);

  r = init(root);
  assert.equal(r.status, 0, r.stderr);
  const before = readFileSync(recordPath(root), 'utf8');
  r = gtg(root, ['progress', 'init', 'Alpha', '--project', 'Other', '--plan', 'other.md'], '[]');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /case-insensitive/);
  assert.equal(readFileSync(recordPath(root), 'utf8'), before);
  r = init(root, [{ id: 'replacement', purpose: 'must not land' }]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /will not overwrite/);
  assert.equal(readFileSync(recordPath(root), 'utf8'), before);
});

test('progress show provides stable JSON and a human summary with skipped counts and historical worker details', () => {
  const root = tempHub();
  assert.equal(init(root).status, 0);
  let r = gtg(root, [
    'progress', 'update', 'alpha', 'task-1', '--expected-revision', '1',
    '--status', 'implementing', '--worker', 'worker-17', '--role', 'builder',
    '--model', 'gpt-5.6-sol', '--effort', 'high', '--note', 'Writing tests',
  ]);
  assert.equal(r.status, 0, r.stderr);
  r = gtg(root, [
    'progress', 'update', 'alpha', 'task-2', '--expected-revision', '2',
    '--status', 'skipped', '--note', 'Superseded by task-1',
    '--stage', 'implementation', '--next-action', 'Review task-1',
  ]);
  assert.equal(r.status, 0, r.stderr);

  const json = gtg(root, ['progress', 'show', 'alpha', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.revision, 3);
  assert.equal(parsed.tasks[0].worker, 'worker-17');
  assert.equal(parsed.tasks[1].status, 'skipped');

  const human = gtg(root, ['progress', 'show', 'alpha']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Alpha \[alpha\] - revision 3/);
  assert.match(human.stdout, /Stage: implementation/);
  assert.match(human.stdout, /Completed: 0\/2 · skipped: 1/);
  assert.match(human.stdout, /task-1.*implementing.*worker-17.*builder.*gpt-5\.6-sol\/high/);
  assert.match(human.stdout, /worker references are historical; live status is not checked/);
  assert.match(human.stdout, /Next action: Review task-1/);
});

test('progress update enforces revisions, IDs, states, evidence, reasons, and preserves bytes on rejection', () => {
  const root = tempHub();
  assert.equal(init(root).status, 0);
  const original = readFileSync(recordPath(root), 'utf8');

  const rejected = [
    [['progress', 'update', 'alpha', 'missing', '--expected-revision', '1', '--status', 'implementing'], /unknown task id/],
    [['progress', 'update', 'alpha', 'task-1', '--expected-revision', '1', '--status', 'flying'], /unknown status/],
    [['progress', 'update', 'alpha', 'task-1', '--expected-revision', '1', '--status', 'done'], /evidence/],
    [['progress', 'update', 'alpha', 'task-1', '--expected-revision', '1', '--status', 'blocked'], /note/],
    [['progress', 'update', 'alpha', '--expected-revision', '1'], /at least one update field/],
    [['progress', 'update', 'alpha', 'task-1', '--expected-revision', 'not-a-number', '--status', 'implementing'], /expected revision/],
    [['progress', 'update', 'alpha', 'task-1', '--expected-revision', '1', '--status', 'implementing', '--constructor', 'x'], /unknown flag/],
    [['progress', 'update', 'alpha', 'task-1', '--expected-revision', '1', '--note', 'safe line\nINJECTED'], /control characters/],
  ];
  for (const [args, message] of rejected) {
    const r = gtg(root, args);
    assert.notEqual(r.status, 0, `unexpected success for ${args.join(' ')}`);
    assert.match(r.stderr, message);
    assert.equal(readFileSync(recordPath(root), 'utf8'), original, `rejected update mutated state: ${args.join(' ')}`);
  }

  let r = gtg(root, [
    'progress', 'update', 'alpha', 'task-1', '--expected-revision', '1',
    '--status', 'done', '--evidence', 'commit abc; tests pass',
  ]);
  assert.equal(r.status, 0, r.stderr);
  const accepted = readFileSync(recordPath(root), 'utf8');
  assert.equal(readRecord(root).revision, 2);

  r = gtg(root, [
    'progress', 'update', 'alpha', 'task-2', '--expected-revision', '1', '--status', 'implementing',
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /revision conflict.*expected 1.*current 2/);
  assert.equal(readFileSync(recordPath(root), 'utf8'), accepted);

  r = gtg(root, [
    'progress', 'update', 'alpha', 'task-1', '--expected-revision', '2', '--status', 'implementing',
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /reopening.*--note/);
  assert.equal(readFileSync(recordPath(root), 'utf8'), accepted);

  r = gtg(root, [
    'progress', 'update', 'alpha', 'task-1', '--expected-revision', '2',
    '--status', 'implementing', '--note', 'Review found another case',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readRecord(root).tasks[0].note, 'Review found another case');
});

test('progress update supports project-only changes and rejects malformed stored JSON before mutation', () => {
  const root = tempHub();
  assert.equal(init(root).status, 0);
  let r = gtg(root, [
    'progress', 'update', 'alpha', '--expected-revision', '1',
    '--stage', 'review', '--next-action', 'Run independent review',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readRecord(root).stage, 'review');
  assert.equal(readRecord(root).nextAction, 'Run independent review');

  const malformed = '{"version":1,"slug":"alpha","tasks":[]}\n';
  writeFileSync(recordPath(root), malformed);
  r = gtg(root, ['progress', 'show', 'alpha']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /invalid progress record/);
  r = gtg(root, [
    'progress', 'update', 'alpha', '--expected-revision', '2', '--stage', 'done',
  ]);
  assert.notEqual(r.status, 0);
  assert.equal(readFileSync(recordPath(root), 'utf8'), malformed);
});

test('progress lock contention refuses mutation and never steals or removes another writer lock', () => {
  const root = tempHub();
  assert.equal(init(root).status, 0);
  const before = readFileSync(recordPath(root), 'utf8');
  const lock = `${recordPath(root)}.lock`;
  writeFileSync(lock, '{"pid":999}\n');
  const r = gtg(root, [
    'progress', 'update', 'alpha', 'task-1', '--expected-revision', '1', '--status', 'implementing',
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is locked/);
  assert.equal(readFileSync(recordPath(root), 'utf8'), before);
  assert.equal(existsSync(lock), true, 'contender stole or removed the existing lock');
  rmSync(lock);
});

test('two writers using the same revision cannot silently overwrite each other', async () => {
  const root = tempHub();
  assert.equal(init(root).status, 0);
  const [first, second] = await Promise.all([
    gtgAsync(root, [
      'progress', 'update', 'alpha', 'task-1', '--expected-revision', '1', '--status', 'implementing',
    ]),
    gtgAsync(root, [
      'progress', 'update', 'alpha', 'task-2', '--expected-revision', '1', '--status', 'reviewing',
    ]),
  ]);
  const outcomes = [first, second];
  assert.equal(outcomes.filter((result) => result.status === 0).length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter((result) => result.status !== 0).length, 1, JSON.stringify(outcomes));
  assert.match(outcomes.find((result) => result.status !== 0).stderr, /locked|revision conflict/);
  const record = readRecord(root);
  assert.equal(record.revision, 2);
  assert.equal(record.tasks.filter((task) => task.status !== 'pending').length, 1);
  assert.deepEqual(readdirSync(join(root, 'docs', 'handoffs', 'progress')).sort(), ['alpha.json']);
});

test('progress add appends pending tasks atomically and rejects every collision', () => {
  const root = tempHub();
  assert.equal(init(root, [TASKS[0]]).status, 0);
  let r = gtg(root, ['progress', 'add', 'alpha', '--expected-revision', '1'], JSON.stringify([TASKS[1]]));
  assert.equal(r.status, 0, r.stderr);
  let record = readRecord(root);
  assert.equal(record.revision, 2);
  assert.deepEqual(record.tasks.map((task) => [task.id, task.status]), [
    ['task-1', 'pending'], ['task-2', 'pending'],
  ]);
  const before = readFileSync(recordPath(root), 'utf8');

  r = gtg(root, ['progress', 'add', 'alpha', '--expected-revision', '2'], JSON.stringify([TASKS[0]]));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /already exists/);
  assert.equal(readFileSync(recordPath(root), 'utf8'), before);

  r = gtg(root, ['progress', 'add', 'alpha', '--expected-revision', '1'], JSON.stringify([{ id: 'task-3', purpose: 'late' }]));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /revision conflict/);
  assert.equal(readFileSync(recordPath(root), 'utf8'), before);
});

test('progress list discovers projects without sync and fails loudly on a malformed record', () => {
  const root = tempHub();
  let r = gtg(root, ['progress', 'list', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), []);
  assert.equal(init(root, [TASKS[0]]).status, 0);
  r = gtg(root, ['progress', 'init', 'beta', '--project', 'Beta', '--plan', 'beta.md'], '[]');
  assert.equal(r.status, 0, r.stderr);

  r = gtg(root, ['progress', 'list', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const list = JSON.parse(r.stdout);
  assert.deepEqual(list.map((item) => item.slug), ['alpha', 'beta']);
  assert.deepEqual(list[0], {
    slug: 'alpha', project: 'Alpha', plan: 'docs/plans/alpha.md', stage: 'planned',
    revision: 1, completed: 0, total: 1, skipped: 0, nextAction: '',
  });

  writeFileSync(recordPath(root, 'broken'), '{broken');
  r = gtg(root, ['progress', 'list']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cannot parse.*broken\.json/);
});

test('handoff embeds progress tasks and snapshot while preserving an explicit Task list', () => {
  const root = tempHub();
  assert.equal(init(root).status, 0);
  const body = '## What Was Done This Session\n- work\n\n## Task list\n- [custom] Keep this exact list\n\n## Next Action\nContinue';
  const r = gtg(root, [
    'handoff', '--project', 'Alpha', '--slug', 'alpha', '--next', 'Continue',
  ], body);
  assert.equal(r.status, 0, r.stderr);
  const rel = r.stdout.trim().split('\n').find((line) => line.startsWith('docs/handoffs/'));
  const doc = readFileSync(join(root, rel), 'utf8');
  assert.equal((doc.match(/^## Task list$/gm) ?? []).length, 1);
  assert.match(doc, /- \[custom\] Keep this exact list/);
  assert.match(doc, /## Progress \(snapshot revision 1, updated .*Z\)/);
  assert.match(doc, /Completed: 0\/2 · skipped: 0/);
});

test('handoff embeds an explicit empty Task list for valid zero-task progress', () => {
  const root = tempHub();
  assert.equal(init(root, []).status, 0);
  const r = gtg(root, [
    'handoff', '--project', 'Alpha', '--slug', 'alpha', '--next', 'Define tasks',
  ], '## What Was Done This Session\n- planned\n\n## Next Action\nDefine tasks');
  assert.equal(r.status, 0, r.stderr);
  const rel = r.stdout.trim().split('\n').find((line) => line.startsWith('docs/handoffs/'));
  const doc = readFileSync(join(root, rel), 'utf8');
  assert.match(doc, /## Task list\n\(no tasks\)/);
});

test('handoff generates a progress Task list and resume prints current state while retaining the record', () => {
  const root = tempHub();
  assert.equal(init(root).status, 0);
  const body = '## What Was Done This Session\n- work\n\n## Next Action\nContinue';
  let r = gtg(root, [
    'handoff', '--project', 'Alpha', '--slug', 'alpha', '--next', 'Continue',
  ], body);
  assert.equal(r.status, 0, r.stderr);
  const rel = r.stdout.trim().split('\n').find((line) => line.startsWith('docs/handoffs/'));
  const doc = readFileSync(join(root, rel), 'utf8');
  assert.match(doc, /## Task list\n- \[pending\] task-1: Build persistent progress/);

  r = gtg(root, [
    'progress', 'update', 'alpha', 'task-1', '--expected-revision', '1',
    '--status', 'done', '--evidence', 'commit abc', '--next-action', 'Start task-2',
  ]);
  assert.equal(r.status, 0, r.stderr);
  r = gtg(root, ['resume', 'alpha']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CURRENT PROGRESS \(supersedes handoff snapshot\)/);
  assert.match(r.stdout, /revision 2/);
  assert.match(r.stdout, /Completed: 1\/2 · skipped: 0/);
  assert.match(r.stdout, /Next action: Start task-2/);
  assert.equal(existsSync(recordPath(root)), true, 'normal resume consumed the durable progress record');
  assert.equal(readRecord(root).revision, 2);
  assert.deepEqual(readdirSync(join(root, 'docs', 'handoffs', 'progress')).sort(), ['alpha.json']);
});
