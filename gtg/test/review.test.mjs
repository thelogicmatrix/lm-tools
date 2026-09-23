import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCollection } from '../skills/gtg/lib/store.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'gtg', 'gtg.mjs');
const BODY = '## Next Action\nContinue\n';

function hub() {
  const root = mkdtempSync(join(tmpdir(), 'gtg-review-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  return root;
}
function gtg(root, args, input = '') {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root, encoding: 'utf8', input,
    env: { ...process.env, GTG_HUB: root, GTG_NO_SYNC: '1', GTG_SESSION_ID: 'review-test', GIT_CEILING_DIRECTORIES: tmpdir() },
  });
}
const handoff = (root, slug) => gtg(root, ['handoff', '--project', slug.toUpperCase(), '--slug', slug, '--next', 'Continue'], BODY);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
const isoDay = (n) => daysAgo(n).slice(0, 10);
// Age a record in place. The CLI reads records from disk, so no commit is needed.
function edit(root, which, slug, patch) {
  const p = join(root, 'docs', 'handoffs', which, `${slug}.json`);
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), ...patch }, null, 2) + '\n');
}
const reviewLine = (r) => r.stdout.split('\n').find((l) => l.startsWith('REVIEW:'));

test('thresholds are 5 days active and 14 days backlog', () => {
  const src = readFileSync(CLI, 'utf8');
  assert.match(src, /const REVIEW_ACTIVE_DAYS = 5;/);
  assert.match(src, /const REVIEW_BACKLOG_DAYS = 14;/);
});

test('no review line when everything is fresh', () => {
  const root = hub();
  handoff(root, 'alpha');
  assert.equal(reviewLine(gtg(root, ['list'])), undefined);
});

test('an active entry at 5 days is asked about, at 4 days it is not', () => {
  const root = hub();
  handoff(root, 'alpha');
  edit(root, 'active', 'alpha', { updated: daysAgo(4.9) });
  assert.equal(reviewLine(gtg(root, ['list'])), undefined);
  edit(root, 'active', 'alpha', { updated: daysAgo(5) });
  assert.match(reviewLine(gtg(root, ['list'])), /^REVIEW: ALPHA \[alpha\] untouched 5d\. .*gtg complete alpha/);
});

test('one question only, a passed wake date first, then the oldest active entry', () => {
  const root = hub();
  for (const s of ['alpha', 'beta', 'gamma']) handoff(root, s);
  edit(root, 'active', 'alpha', { updated: daysAgo(6) });
  edit(root, 'active', 'beta', { updated: daysAgo(9) });
  assert.equal(gtg(root, ['back', 'gamma', '--wake', isoDay(1)]).status, 0);
  const out = gtg(root, ['list']).stdout;
  assert.equal(out.split('\n').filter((l) => l.startsWith('REVIEW:')).length, 1);
  assert.match(reviewLine({ stdout: out }), /^REVIEW: GAMMA \[gamma\] was parked until /);
  assert.equal(gtg(root, ['keep', 'gamma']).status, 0);
  assert.match(reviewLine(gtg(root, ['list'])), /^REVIEW: BETA \[beta\] untouched 9d\./);
});

test('a future wake date keeps a backlog entry quiet however old it is', () => {
  const root = hub();
  handoff(root, 'alpha');
  gtg(root, ['back', 'alpha', '--wake', '2099-01-01']);
  edit(root, 'backlog', 'alpha', { updated: daysAgo(60) });
  assert.equal(reviewLine(gtg(root, ['list'])), undefined);
});

test('an undated backlog entry is asked about at 14 days, not 13', () => {
  const root = hub();
  handoff(root, 'alpha');
  gtg(root, ['back', 'alpha']);
  edit(root, 'backlog', 'alpha', { updated: daysAgo(13.9) });
  assert.equal(reviewLine(gtg(root, ['list'])), undefined);
  edit(root, 'backlog', 'alpha', { updated: daysAgo(14) });
  assert.match(reviewLine(gtg(root, ['list'])), /^REVIEW: ALPHA \[alpha\] parked 14d\./);
});

test('keep resets the clock without touching updated, and --wake on keep sets a backlog wake', () => {
  const root = hub();
  handoff(root, 'alpha');
  const old = daysAgo(8);
  edit(root, 'active', 'alpha', { updated: old });
  assert.equal(gtg(root, ['keep', 'alpha']).status, 0);
  const rec = readCollection(root, 'docs/handoffs/active')[0];
  assert.equal(rec.updated, old);
  assert.ok(rec.reviewed);
  assert.equal(reviewLine(gtg(root, ['list'])), undefined);
  assert.notEqual(gtg(root, ['keep', 'alpha', '--wake', '2099-01-01']).status, 0, '--wake on an active entry is refused');
  gtg(root, ['back', 'alpha']);
  assert.equal(gtg(root, ['keep', 'alpha', '--wake', '2099-02-03']).status, 0);
  assert.equal(readCollection(root, 'docs/handoffs/backlog')[0].wake, '2099-02-03');
});

test('a malformed wake date is refused', () => {
  const root = hub();
  handoff(root, 'alpha');
  const r = gtg(root, ['back', 'alpha', '--wake', 'next tuesday']);
  assert.equal(r.status, 2);
  assert.equal(readCollection(root, 'docs/handoffs/active').length, 1, 'nothing moved');
});

test('the entry just resumed is never the question, and a filtered list and a checkpoint stay quiet', () => {
  const root = hub();
  handoff(root, 'alpha');
  edit(root, 'active', 'alpha', { updated: daysAgo(7) });
  assert.equal(reviewLine(gtg(root, ['resume', 'alpha'])), undefined);
  assert.equal(reviewLine(gtg(root, ['list', 'alpha'])), undefined);
  handoff(root, 'beta');
  edit(root, 'active', 'beta', { updated: daysAgo(7) });
  const cp = gtg(root, ['handoff', '--project', 'GAMMA', '--slug', 'gamma', '--next', 'x', '--checkpoint'], BODY);
  assert.equal(reviewLine(cp), undefined);
});

test('activate clears a wake date', () => {
  const root = hub();
  handoff(root, 'alpha');
  gtg(root, ['back', 'alpha', '--wake', '2099-01-01']);
  gtg(root, ['active', 'alpha']);
  assert.equal(readCollection(root, 'docs/handoffs/active')[0].wake, undefined);
});
