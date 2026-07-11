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

// Run the CLI. GTG_HUB is stripped from the inherited env unless opts.hub is given,
// so the dev machine's own hub setting can't leak into the tests.
function gtg(cwd, args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  delete env.GTG_HUB;
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
  console.log('ok - error cases');
}

console.log('ALL PASS');
