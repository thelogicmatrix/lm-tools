#!/usr/bin/env node
// gtg self-check — assert-based, no framework. Runs every command against
// throwaway temp git repos. Non-zero exit on any failure.
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'gtg', 'gtg.mjs');

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gtg-'));
  execSync('git init -q -b main', { cwd: dir });
  execSync('git config user.email test@test', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
  return dir;
}

// Like tempRepo() but deliberately WITHOUT a local identity, so commit() can be
// forced into a genuine (non-"nothing to commit") git failure by also isolating
// global/system config (see the commit-failure test below).
function tempRepoNoIdentity() {
  const dir = mkdtempSync(join(tmpdir(), 'gtg-noid-'));
  execSync('git init -q -b main', { cwd: dir });
  return dir;
}

// Run the CLI. GTG_HUB is stripped from the inherited env unless opts.hub is given,
// so the dev machine's own hub setting can't leak into the tests.
// GIT_CEILING_DIRECTORIES pins git's upward repo search at tmpdir so a bare
// temp dir can't resolve to an enclosing repo (e.g. a git-tracked home dir).
function gtg(cwd, args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  delete env.GTG_HUB;
  env.GIT_CEILING_DIRECTORIES = tmpdir();
  if (opts.hub) env.GTG_HUB = opts.hub;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, env, encoding: 'utf8', input: opts.input ?? '',
  });
}

const HANDOFF_ARGS = (slug, project) => [
  'handoff', '--project', project, '--slug', slug,
  '--phase', 'executing', '--tier', 'Sonnet', '--next', 'do the next thing',
];
const BODY = '## What Was Done This Session\n- stuff\n\n## Next Action\ndo the next thing\n';
const active = (root) => JSON.parse(readFileSync(join(root, 'docs/handoffs/_active.json'), 'utf8'));

// --- 1. handoff writes doc + _active.json entry, commits ---
{
  const repo = tempRepo();
  const r = gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  assert.equal(r.status, 0, `handoff failed: ${r.stderr}`);
  const rel = r.stdout.split('\n')[0].trim();
  assert.match(rel, /^docs\/handoffs\/\d{4}-\d{2}-\d{2}-\d{4}-proj-a\.md$/);
  assert.ok(existsSync(join(repo, rel)), 'handoff doc missing');
  const doc = readFileSync(join(repo, rel), 'utf8');
  assert.match(doc, /^# Handoff: Project A/);
  assert.match(doc, /## Resume Prompt\nSay: "let's continue Project A"/);
  const entries = active(repo).handoffs;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].slug, 'proj-a');
  assert.equal(entries[0].file, rel);
  const subject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(subject, /^handoff: Project A/);
  // dedupe by slug: second handoff for same slug replaces, not appends
  const r2 = gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(active(repo).handoffs.length, 1, 'dedupe by slug failed');
  console.log('ok 1 - handoff');
}

// --- 1b. backlog park lands in _backlog.json ---
{
  const repo = tempRepo();
  const r = gtg(repo, ['backlog', '--project', 'Idea X', '--slug', 'idea-x',
    '--phase', 'free-form', '--tier', 'Haiku', '--next', 'TBD'], { input: '## The Idea\nsomething\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PARKED on backlog/);
  const bl = JSON.parse(readFileSync(join(repo, 'docs/handoffs/_backlog.json'), 'utf8')).backlog;
  assert.equal(bl.length, 1);
  assert.equal(bl[0].slug, 'idea-x');
  assert.ok(!existsSync(join(repo, 'docs/handoffs/_active.json')), 'backlog park must not touch _active.json');
  console.log('ok 1b - backlog park');
}

// --- 5. GTG_HUB override: handoff lands in the hub, not the cwd repo ---
{
  const hub = tempRepo();
  const other = tempRepo();
  const r = gtg(other, HANDOFF_ARGS('hub-proj', 'Hub Project'), { input: BODY, hub });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(hub, 'docs/handoffs/_active.json')), 'entry not in hub');
  assert.ok(!existsSync(join(other, 'docs/handoffs')), 'entry leaked into cwd repo');
  const subject = execSync('git log -1 --format=%s', { cwd: hub, encoding: 'utf8' }).trim();
  assert.match(subject, /^handoff: Hub Project/, 'commit not in hub repo');
  console.log('ok 5 - GTG_HUB');
}

// --- error cases: no repo + no hub; missing flags; empty body ---
{
  const bare = mkdtempSync(join(tmpdir(), 'gtg-bare-'));
  const r = gtg(bare, ['list']);
  assert.equal(r.status, 2, 'expected exit 2 outside a repo without GTG_HUB');
  assert.match(r.stderr, /GTG_HUB/);
  const repo = tempRepo();
  const r2 = gtg(repo, ['handoff', '--project', 'X'], { input: BODY });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /missing --/);
  const r3 = gtg(repo, HANDOFF_ARGS('x', 'X'), { input: '' });
  assert.equal(r3.status, 2);
  assert.match(r3.stderr, /empty body/);
  // slug must not traverse paths or inject shell — rejected before any write
  for (const bad of ['../evil', 'a/b', 'a;rm -rf', 'a b']) {
    const rb = gtg(repo, HANDOFF_ARGS(bad, 'X'), { input: BODY });
    assert.equal(rb.status, 2, `bad slug '${bad}' should exit 2`);
    assert.match(rb.stderr, /--slug must match/);
  }
  console.log('ok - error cases');
}

// --- 2. list shows entries; list <project> filters ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('proj-b', 'Project B'), { input: BODY });
  const r = gtg(repo, ['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 active gtg projects/);
  assert.match(r.stdout, /Project A/);
  assert.match(r.stdout, /Project B/);
  const rf = gtg(repo, ['list', 'proj-a']);
  assert.match(rf.stdout, /Project A/);
  assert.doesNotMatch(rf.stdout, /Project B/, 'filter leaked other project');
  console.log('ok 2 - list + filter');
}

// --- 2b. 7-day auto-shelf: stale active entry moves to backlog on list ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('stale-proj', 'Stale Project'), { input: BODY });
  // Backdate the entry 8 days
  const ap = join(repo, 'docs/handoffs/_active.json');
  const data = JSON.parse(readFileSync(ap, 'utf8'));
  data.handoffs[0].updated = new Date(Date.now() - 8 * 86400000).toISOString();
  writeFileSync(ap, JSON.stringify(data, null, 2) + '\n');
  const r = gtg(repo, ['list']);
  assert.match(r.stdout, /Auto-shelved 1 project/);
  assert.match(r.stdout, /No active gtg projects/);
  const bl = JSON.parse(readFileSync(join(repo, 'docs/handoffs/_backlog.json'), 'utf8')).backlog;
  assert.equal(bl.length, 1);
  assert.equal(bl[0].slug, 'stale-proj');
  assert.equal(JSON.parse(readFileSync(ap, 'utf8')).handoffs.length, 0);
  // shelf listing shows it
  const rb = gtg(repo, ['backlog']);
  assert.match(rb.stdout, /b1\. Stale Project/);
  console.log('ok 2b - auto-shelf + backlog list');
}

// --- 2c. list numbering matches resolveEntry's full-list order (not filtered subset) ---
// resolveEntry (used by remove/back/active) resolves a numeric "<n>" against the
// FULL sorted active list — so `list <filter>` must number entries by their
// position in that full list, not by their index within the filtered subset.
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('alpha', 'Alpha'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('bravo', 'Bravo'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('charlie', 'Charlie'), { input: BODY });
  const r = gtg(repo, ['list', 'bravo']);
  assert.equal(r.status, 0, r.stderr);
  // Full sorted order is Alpha, Bravo, Charlie — Bravo is position 2, even though
  // it's the only entry shown here. Numbering by filtered-subset index would wrongly show "1.".
  assert.match(r.stdout, /^2\. Bravo/m, 'list <filter> must number by full sorted-list position, not filtered index');
  console.log('ok 2c - list numbering matches resolve order');
}

// --- 3. commit() failure discrimination: a genuine (non-"nothing to commit") git
// failure must still let the CLI succeed (files are written regardless) while
// surfacing a warning to stderr, not swallowing it as silent success ---
{
  const repo = tempRepoNoIdentity();
  const noConfig = join(tmpdir(), `gtg-no-such-gitconfig-${process.pid}-${Date.now()}`);
  const r = gtg(repo, HANDOFF_ARGS('proj-c', 'Project C'), {
    input: BODY,
    env: { GIT_CONFIG_GLOBAL: noConfig, GIT_CONFIG_SYSTEM: noConfig, GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.equal(r.status, 0, `CLI should still exit 0 even if the git commit fails: ${r.stderr}`);
  assert.match(r.stdout, /^docs\/handoffs\/\d{4}-\d{2}-\d{2}-\d{4}-proj-c\.md$/m, 'handoff success output missing from stdout');
  assert.match(r.stdout, /RESUME: "let's continue Project C"/);
  assert.match(r.stderr, /uncommitted/i, 'genuine git commit failure must be surfaced as a warning, not swallowed');
  assert.ok(existsSync(join(repo, 'docs/handoffs/_active.json')), 'entry should still be written to disk despite commit failure');
  console.log('ok 3 - commit failure surfaces warning, CLI still succeeds');
}

// --- 3+4. remove empties _active.json; undo restores it ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  const r = gtg(repo, ['remove', 'proj-a']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Removed: Project A/);
  assert.equal(active(repo).handoffs.length, 0, 'remove left entries behind');
  const ru = gtg(repo, ['undo']);
  assert.equal(ru.status, 0, ru.stderr);
  assert.equal(active(repo).handoffs.length, 1, 'undo did not restore');
  assert.equal(active(repo).handoffs[0].slug, 'proj-a');
  console.log('ok 3+4 - remove + undo');
}

// --- 4b. back shelves, active reactivates, remove falls through to backlog ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  const rb = gtg(repo, ['back', 'proj-a']);
  assert.match(rb.stdout, /Parked: Project A/);
  assert.equal(active(repo).handoffs.length, 0);
  const bl = () => JSON.parse(readFileSync(join(repo, 'docs/handoffs/_backlog.json'), 'utf8')).backlog;
  assert.equal(bl().length, 1);
  const ra = gtg(repo, ['active', 'b1']);
  assert.match(ra.stdout, /Activated: Project A/);
  assert.equal(active(repo).handoffs.length, 1);
  assert.equal(bl().length, 0);
  // remove falls through to backlog when not in active
  gtg(repo, ['back', 'proj-a']);
  const rr = gtg(repo, ['remove', 'proj-a']);
  assert.match(rr.stdout, /Removed from backlog: Project A/);
  assert.equal(bl().length, 0);
  console.log('ok 4b - back/active/backlog-remove');
}

console.log('ALL PASS');
