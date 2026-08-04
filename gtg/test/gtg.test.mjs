#!/usr/bin/env node
// gtg self-check - assert-based, no framework. Runs every command against
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
// opts.session pins the session id undo scopes itself to: a string names one, null
// strips it entirely (the no-identity case). Defaulted rather than inherited so a run
// inside a Claude session and a run in CI behave identically - a real
// CLAUDE_CODE_SESSION_ID leaking in would make undo pass locally and fail in CI.
function gtg(cwd, args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  delete env.GTG_HUB;
  delete env.CLAUDE_CODE_SESSION_ID;
  env.GIT_CEILING_DIRECTORIES = tmpdir();
  if (opts.session === null) delete env.GTG_SESSION_ID;
  else env.GTG_SESSION_ID = opts.session || 'test-session';
  if (opts.hub) env.GTG_HUB = opts.hub;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, env, encoding: 'utf8', input: opts.input ?? '',
  });
}

const HANDOFF_ARGS = (slug, project) => [
  'handoff', '--project', project, '--slug', slug,
  '--eta', '~2h', '--next', 'do the next thing',
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
    '--eta', '~1h', '--next', 'TBD'], { input: '## The Idea\nsomething\n' });
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
  // slug must not traverse paths or inject shell - rejected before any write
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
// FULL sorted active list - so `list <filter>` must number entries by their
// position in that full list, not by their index within the filtered subset.
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('alpha', 'Alpha'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('bravo', 'Bravo'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('charlie', 'Charlie'), { input: BODY });
  const r = gtg(repo, ['list', 'bravo']);
  assert.equal(r.status, 0, r.stderr);
  // Full sorted order is Alpha, Bravo, Charlie - Bravo is position 2, even though
  // it's the only entry shown here. Numbering by filtered-subset index would wrongly show "1.".
  assert.match(r.stdout, /^\s*2\. Bravo/m, 'list <filter> must number by full sorted-list position, not filtered index');
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

// --- Finding C1: shell injection via unvalidated --project must not execute ---
// commit() used to interpolate the commit message (built from --project/--phase) into
// a shell string run via execSync (POSIX: /bin/sh -c). Only --slug was validated.
// NOTE (platform caveat): this proves the fix on POSIX (sh interprets $(...)). On
// Windows, execSync's default shell is cmd.exe, which does NOT interpret $(...), so
// this assertion could pass even against the old vulnerable code when run on Windows.
// Kept anyway as the correct regression guard for POSIX/CI.
{
  const repo = tempRepo();
  const marker = join(repo, 'INJECTED_MARKER');
  const evilProject = 'Pwn$(touch INJECTED_MARKER)Name';
  const r = gtg(repo, HANDOFF_ARGS('inject-test', evilProject), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(marker), 'shell injection via --project executed a command');
  assert.equal(active(repo).handoffs[0].project, evilProject,
    'stored project must be the literal string including $(...), untouched');
  console.log('ok - Finding C1: shell injection via --project neutralized');
}

// --- Finding I1: undo must restore BOTH stores, not leave the entry duplicated ---
// back/active/autoShelf commit _active.json + _backlog.json together in one commit.
// undo used to restore only _active.json from the pre-commit parent, leaving the
// moved entry ALSO present in _backlog.json.
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-i1', 'Project I1'), { input: BODY });
  gtg(repo, ['back', 'proj-i1']);
  const ru = gtg(repo, ['undo']);
  assert.equal(ru.status, 0, ru.stderr);
  const inActive = active(repo).handoffs.some((e) => e.slug === 'proj-i1');
  const blPath = join(repo, 'docs/handoffs/_backlog.json');
  const inBacklog = existsSync(blPath)
    && JSON.parse(readFileSync(blPath, 'utf8')).backlog.some((e) => e.slug === 'proj-i1');
  assert.ok(inActive, 'undo should restore the entry to active');
  assert.ok(!inBacklog, 'undo left the entry duplicated in backlog too');
  console.log('ok - Finding I1: undo restores both stores after back');
}

// --- Finding 1: unresolvable target must exit non-zero and print to stderr ---
{
  const repo = tempRepo();
  const r1 = gtg(repo, ['remove', 'no-such-slug']);
  assert.notEqual(r1.status, 0, 'remove of unknown slug should exit non-zero');
  assert.ok(r1.stderr.length > 0, 'remove of unknown slug should print to stderr');
  const r2 = gtg(repo, ['back', '99']);
  assert.notEqual(r2.status, 0, 'back of out-of-range number should exit non-zero');
  assert.ok(r2.stderr.length > 0, 'back of out-of-range number should print to stderr');
  console.log('ok - Finding 1: unresolvable target exits non-zero');
}

// --- Finding 2: back/active success-message hint must point at the moved entry's
// sorted position in the destination list, not the raw post-push array length ---
{
  const repo = tempRepo();
  // back: shelve Zebra first (backlog = [Zebra]), then shelve Apple.
  // Sorted backlog = [Apple, Zebra] - Apple's hint must be 1, not length (2).
  gtg(repo, HANDOFF_ARGS('zebra', 'Zebra'), { input: BODY });
  gtg(repo, ['back', 'zebra']);
  gtg(repo, HANDOFF_ARGS('apple', 'Apple'), { input: BODY });
  const rb = gtg(repo, ['back', 'apple']);
  assert.equal(rb.status, 0, rb.stderr);
  assert.match(rb.stdout, /Bring back: gtg active 1(?!\d)/, 'back hint must use sorted position (Apple=1), not raw length');
  console.log('ok - Finding 2a: back hint uses sorted position');
}
{
  const repo = tempRepo();
  // active: Zebra stays active, Apple parked straight to backlog, then activated.
  // Sorted active after move = [Apple, Zebra] - Apple's hint must be 1, not length (2).
  gtg(repo, HANDOFF_ARGS('zebra', 'Zebra'), { input: BODY });
  gtg(repo, ['backlog', '--project', 'Apple', '--slug', 'apple',
    '--eta', '~2h', '--next', 'do the next thing'], { input: BODY });
  const ra = gtg(repo, ['active', 'apple']);
  assert.equal(ra.status, 0, ra.stderr);
  assert.match(ra.stdout, /Shelve again: gtg back 1(?!\d)/, 'active hint must use sorted position (Apple=1), not raw length');
  console.log('ok - Finding 2b: active hint uses sorted position');
}

// --- Finding 3: undo must not re-trigger autoShelf (no re-park, no extra commit) ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('stale-undo', 'Stale Undo'), { input: BODY });
  const ap = join(repo, 'docs/handoffs/_active.json');
  const data = JSON.parse(readFileSync(ap, 'utf8'));
  data.handoffs[0].updated = new Date(Date.now() - 8 * 86400000).toISOString();
  writeFileSync(ap, JSON.stringify(data, null, 2) + '\n');
  execSync('git add -A && git commit -q -m "backdate for test"', { cwd: repo, stdio: 'ignore' });
  gtg(repo, ['remove', 'stale-undo']);
  const commitsBeforeUndo = execSync('git rev-list --count HEAD', { cwd: repo, encoding: 'utf8' }).trim();
  const ru = gtg(repo, ['undo']);
  assert.equal(ru.status, 0, ru.stderr);
  assert.equal(active(repo).handoffs.length, 1, 'undo did not restore the stale entry to active');
  assert.equal(active(repo).handoffs[0].slug, 'stale-undo');
  assert.ok(!existsSync(join(repo, 'docs/handoffs/_backlog.json'))
    || JSON.parse(readFileSync(join(repo, 'docs/handoffs/_backlog.json'), 'utf8')).backlog.length === 0,
    'undo must not re-park the stale entry to backlog');
  const commitsAfterUndo = execSync('git rev-list --count HEAD', { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(Number(commitsAfterUndo), Number(commitsBeforeUndo) + 1, 'undo must create exactly one commit, no autoShelf side-commit');
  console.log('ok - Finding 3: undo does not re-trigger autoShelf');
}

// --- 6. extension dispatch + ctx contract ---
{
  const repo = tempRepo();
  mkdirSync(join(repo, '.gtg/commands'), { recursive: true });
  writeFileSync(join(repo, '.gtg/commands/ping.mjs'),
    `export default (ctx) => console.log(JSON.stringify({
      hasRoot: !!ctx.root,
      hasArgs: Array.isArray(ctx.args),
      hasReadStore: typeof ctx.readStore === 'function',
      hasWriteStore: typeof ctx.writeStore === 'function',
      hasCommit: typeof ctx.commit === 'function',
      argsThrough: ctx.args.join(','),
    }))\n`);
  const r = gtg(repo, ['ping', 'a', 'b']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  for (const k of ['hasRoot', 'hasArgs', 'hasReadStore', 'hasWriteStore', 'hasCommit']) {
    assert.equal(out[k], true, `ctx contract broken: ${k}`);
  }
  assert.equal(out.argsThrough, 'a,b');
  // built-ins win: an extension named list.mjs must NOT be dispatched
  writeFileSync(join(repo, '.gtg/commands/list.mjs'), `export default () => console.log('EXTENSION-LIST')\n`);
  const rl = gtg(repo, ['list']);
  assert.doesNotMatch(rl.stdout, /EXTENSION-LIST/, 'extension shadowed a builtin');
  // unknown command with no extension file still errors
  const rx = gtg(repo, ['nonesuch']);
  assert.equal(rx.status, 2);
  assert.match(rx.stderr, /unknown command/);
  console.log('ok 6 - extension dispatch + ctx contract');
}

// --- Finding T5-1: unknown <cmd> must not traverse paths outside .gtg/commands ---
// `gtg ../evil` builds join(ROOT, '.gtg', 'commands', '../evil.mjs') which path.join
// normalizes to ROOT/.gtg/evil.mjs - outside the commands dir. Unvalidated, this would
// import and execute that file. cmd must be constrained the same way --slug is.
{
  const repo = tempRepo();
  mkdirSync(join(repo, '.gtg/commands'), { recursive: true });
  writeFileSync(join(repo, '.gtg/evil.mjs'), `export default () => console.log('EVIL-MARKER')\n`);
  const r = gtg(repo, ['../evil']);
  assert.doesNotMatch(r.stdout, /EVIL-MARKER/, 'path traversal executed a file outside .gtg/commands');
  assert.equal(r.status, 2, 'traversal attempt should fall through to the unknown-command exit 2');
  assert.match(r.stderr, /unknown command/);
  console.log('ok - Finding T5-1: cmd path traversal rejected');
}

// --- Finding T5-2: extension import/invoke failures must fail cleanly, not crash raw ---
{
  const repo = tempRepo();
  mkdirSync(join(repo, '.gtg/commands'), { recursive: true });
  writeFileSync(join(repo, '.gtg/commands/boom.mjs'), `throw new Error('kaboom')\n`);
  const r = gtg(repo, ['boom']);
  assert.equal(r.status, 1, 'extension throw should exit 1 (controlled), not crash uncontrolled');
  assert.match(r.stderr, /extension 'boom' failed/);
  assert.match(r.stderr, /kaboom/);
  assert.doesNotMatch(r.stderr, /at Object|node:internal|Unhandled/, 'raw node stack/unhandled-rejection dump leaked');
  console.log('ok - Finding T5-2a: extension import throw handled cleanly');
}
{
  const repo = tempRepo();
  mkdirSync(join(repo, '.gtg/commands'), { recursive: true });
  writeFileSync(join(repo, '.gtg/commands/nodefault.mjs'), `export const x = 1;\n`);
  const r = gtg(repo, ['nodefault']);
  assert.equal(r.status, 1, 'missing default export should exit 1 cleanly');
  assert.match(r.stderr, /extension 'nodefault' failed/);
  assert.doesNotMatch(r.stderr, /TypeError/, 'raw TypeError leaked instead of the clean message');
  console.log('ok - Finding T5-2b: extension missing default export handled cleanly');
}

// --- 7. bundled command dispatches with NO user .gtg present ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  const r = gtg(repo, ['stats']);
  assert.equal(r.status, 0, `bundled stats failed: ${r.stderr}`);
  assert.match(r.stdout, /1 active/);
  // Task 6 rewrote stats.mjs on top of buildReport() (history.mjs); the old
  // "sessions: N total · deepest: X (Y)" line is gone. Assert the counts line
  // plus the new session-depth line ("N sessions · deepest: X (Y)"), not the
  // exact total (perProject can split a row when --slug diverges from
  // slugify(project) - a pre-existing Tasks 1-5 quirk, out of scope here).
  const sessLine = r.stdout.match(/(\d+) sessions · deepest: (.+?) \((\d+)\)/);
  assert.ok(sessLine, `session-depth line missing/malformed in stats output: ${r.stdout}`);
  assert.equal(sessLine[2], 'Project A');
  console.log('ok 7 - bundled stats dispatch');
}

// --- 7b. stats on an empty/absent store prints zeros, never throws ---
{
  const repo = tempRepo();
  const r = gtg(repo, ['stats']);
  assert.equal(r.status, 0, `stats on empty store failed: ${r.stderr}`);
  assert.match(r.stdout, /0 active/);
  assert.match(r.stdout, /0 backlog/);
  console.log('ok 7b - stats empty store');
}

// --- 7c. user .gtg/commands/<verb> OVERRIDES a bundled command of the same name ---
{
  const repo = tempRepo();
  mkdirSync(join(repo, '.gtg/commands'), { recursive: true });
  writeFileSync(join(repo, '.gtg/commands/stats.mjs'),
    `export default () => console.log('USER-STATS-OVERRIDE')\n`);
  const r = gtg(repo, ['stats']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /USER-STATS-OVERRIDE/, 'user command did not override bundled');
  console.log('ok 7c - user overrides bundled');
}

// --- 7d. update-safety: a user command survives an unrelated bundled command existing ---
{
  const repo = tempRepo();
  mkdirSync(join(repo, '.gtg/commands'), { recursive: true });
  writeFileSync(join(repo, '.gtg/commands/mine.mjs'),
    `export default (ctx) => console.log('MINE:' + (typeof ctx.readStore))\n`);
  const r = gtg(repo, ['mine']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MINE:function/, 'user command lost its ctx');
  console.log('ok 7d - user command intact alongside bundled command');
}

// --- 8. resume consumes an entry with its OWN commit subject (not prune) ---
{
  const repo = tempRepo();
  let r = gtg(repo, HANDOFF_ARGS('proj-r', 'Project R'), { input: BODY });
  assert.equal(r.status, 0, `handoff failed: ${r.stderr}`);

  r = gtg(repo, ['resume', 'proj-r']);
  assert.equal(r.status, 0, `resume failed: ${r.stderr}`);
  assert.equal(active(repo).handoffs.length, 0, 'resume did not remove the entry');

  const subject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(subject, /^gtg resume: Project R - handoff consumed$/,
    `resume must not reuse the prune subject, got: ${subject}`);

  // falls back to the backlog when the slug is not active
  r = gtg(repo, ['backlog', '--project', 'Idea Z', '--slug', 'idea-z',
    '--next', 'TBD'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  r = gtg(repo, ['resume', 'idea-z']);
  assert.equal(r.status, 0, `backlog resume failed: ${r.stderr}`);
  const blSubject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(blSubject, /^gtg resume: Idea Z - backlog handoff consumed$/);

  // no match exits 2
  r = gtg(repo, ['resume', 'nope']);
  assert.equal(r.status, 2, 'resume on a missing slug should exit 2');

  console.log('ok 8 - resume has its own verb and commit subject');
}

// --- 9. phase is gone; sessions counts up; created is stable ---
{
  const repo = tempRepo();
  let r = gtg(repo, HANDOFF_ARGS('proj-s', 'Project S'), { input: BODY });
  assert.equal(r.status, 0, `handoff failed: ${r.stderr}`);

  let e = active(repo).handoffs[0];
  assert.equal(e.sessions, 1, 'first handoff should be session 1');
  assert.ok(!('phase' in e), 'phase must not be written');
  assert.match(e.created, /^\d{4}-\d{2}-\d{2}T/, 'created must be an ISO stamp');
  const firstCreated = e.created;

  const doc = readFileSync(join(repo, e.file), 'utf8');
  assert.ok(!/^Phase:/m.test(doc), 'handoff doc must not carry a Phase: line');

  let subject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(subject, /^handoff: Project S - session 1$/, `got: ${subject}`);

  // second handoff for the same slug: sessions increments, created is carried
  r = gtg(repo, HANDOFF_ARGS('proj-s', 'Project S'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).handoffs[0];
  assert.equal(e.sessions, 2, 'second handoff should be session 2');
  assert.equal(e.created, firstCreated, 'created must not move on later handoffs');
  subject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(subject, /^handoff: Project S - session 2$/, `got: ${subject}`);

  // --phase is no longer required
  r = gtg(repo, ['handoff', '--project', 'Project T', '--slug', 'proj-t',
    '--next', 'thing'], { input: BODY });
  assert.equal(r.status, 0, `handoff without --phase must succeed: ${r.stderr}`);

  console.log('ok 9 - phase dropped, sessions counts, created is stable');
}

// --- 10. created backfills from disk when handoff files exist but no store entry does
// (a real project whose entry was consumed by `gtg resume`, now handed off again) ---
{
  const repo = tempRepo();
  const dir = join(repo, 'docs/handoffs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-01-05-0900-old-proj.md'), '# old\n');
  writeFileSync(join(dir, '2026-01-10-1200-old-proj.md'), '# old\n');

  const r = gtg(repo, HANDOFF_ARGS('old-proj', 'Old Proj'), { input: BODY });
  assert.equal(r.status, 0, `handoff failed: ${r.stderr}`);
  const e = active(repo).handoffs[0];
  // minor fix: firstHandoffDate() now carries the same local-offset suffix
  // nowIso() uses (a bare vs aware datetime otherwise breaks Python fromisoformat
  // comparisons) - assert via regex so the test isn't tied to the CI box's own tz.
  assert.match(e.created, /^2026-01-05T00:00:00[+-]\d{2}:\d{2}$/,
    'created must backfill to the EARLIEST pre-existing handoff file, not today, with a local-offset suffix');
  assert.equal(e.sessions, 3, 'sessions must count the 2 pre-existing files plus this one');
  console.log('ok 10 - created backfills from disk when no store entry exists');
}

// --- 11. worktree + branch land on the entry; branch is read FROM the worktree ---
{
  const repo = tempRepo();

  // a separate repo standing in for a project worktree, on a distinctive branch
  const wt = tempRepo();
  execSync('git commit -q --allow-empty -m init', { cwd: wt });
  execSync('git checkout -q -b feat/elsewhere', { cwd: wt });

  let r = gtg(repo, [...HANDOFF_ARGS('proj-w', 'Project W'), '--worktree', wt], { input: BODY });
  assert.equal(r.status, 0, `handoff failed: ${r.stderr}`);
  let e = active(repo).handoffs[0];
  assert.equal(e.worktree, wt, 'worktree must be stored on the entry');
  assert.equal(e.branch, 'feat/elsewhere',
    `branch must come from the worktree, not the storage root, got: ${e.branch}`);

  // explicit --branch wins over detection
  r = gtg(repo, [...HANDOFF_ARGS('proj-w2', 'Project W2'), '--worktree', wt,
    '--branch', 'stated/branch'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).handoffs.find((x) => x.slug === 'proj-w2');
  assert.equal(e.branch, 'stated/branch');

  // no --worktree: defaults to 'repo root' and detects in the storage root
  r = gtg(repo, HANDOFF_ARGS('proj-w3', 'Project W3'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).handoffs.find((x) => x.slug === 'proj-w3');
  assert.equal(e.worktree, 'repo root');
  assert.equal(e.branch, 'main', `storage-root branch expected, got: ${e.branch}`);

  // a worktree path that does not exist must not throw
  r = gtg(repo, [...HANDOFF_ARGS('proj-w4', 'Project W4'),
    '--worktree', join(repo, 'no-such-dir')], { input: BODY });
  assert.equal(r.status, 0, `missing worktree must not fail the handoff: ${r.stderr}`);
  e = active(repo).handoffs.find((x) => x.slug === 'proj-w4');
  assert.equal(e.branch, '?', `unresolvable branch should be '?', got: ${e.branch}`);

  console.log('ok 11 - worktree and branch stored, detected in the right repo');
}

// --- 12. parent: explicit flag wins, INDEX.md prefix match is the fallback ---
{
  const repo = tempRepo();
  mkdirSync(join(repo, 'docs/projects'), { recursive: true });
  writeFileSync(join(repo, 'docs/projects/INDEX.md'), [
    '| Project | Status |',
    '|---|---|',
    '| [atlas](atlas.md) | active |',
    '| [Bench & Bar](bench-and-bar.md) | paused |',
    '| [Widget — parts catalog](widget.md) | paused |',
    '| [Widget Ads](widget-ads.md) | paused |',
    '',
  ].join('\n'));

  // explicit --parent wins, even when it matches nothing in INDEX.md
  let r = gtg(repo, [...HANDOFF_ARGS('sub-project', 'Ships Worldbuilding'),
    '--parent', 'atlas'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  let e = active(repo).handoffs.find((x) => x.slug === 'sub-project');
  assert.equal(e.parent, 'atlas', 'explicit --parent must be honoured verbatim');

  // fallback: slug prefix matches an INDEX.md page slug
  r = gtg(repo, HANDOFF_ARGS('widget-stats-page', 'Widget Stats Page'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).handoffs.find((x) => x.slug === 'widget-stats-page');
  assert.equal(e.parent, 'widget', 'widget-* should infer the widget family');

  // fallback: two pages qualify ('widget' and 'widget-ads') - longest wins,
  // not whichever the shorter page happened to be listed first in INDEX.md
  r = gtg(repo, HANDOFF_ARGS('widget-ads-report', 'Widget Ads Report'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).handoffs.find((x) => x.slug === 'widget-ads-report');
  assert.equal(e.parent, 'widget-ads', 'longest matching page slug must win the tie-break, not the first one found');

  // fallback: exact match - a project that IS the family
  r = gtg(repo, HANDOFF_ARGS('bench-and-bar', 'Bench & Bar'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).handoffs.find((x) => x.slug === 'bench-and-bar');
  assert.equal(e.parent, 'bench-and-bar', 'an exact slug match is its own family');

  // no match: undefined, NOT a wrong guess
  r = gtg(repo, HANDOFF_ARGS('budget-planner', 'Budget Planner'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).handoffs.find((x) => x.slug === 'budget-planner');
  assert.equal(e.parent, undefined, 'an unmatched slug must be standalone, not mis-assigned');

  // a partial word must not match: 'widgeteer' is not in the 'widget' family
  r = gtg(repo, HANDOFF_ARGS('widgeteer-thing', 'Widgeteer Thing'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).handoffs.find((x) => x.slug === 'widgeteer-thing');
  assert.equal(e.parent, undefined, 'prefix match must respect the hyphen boundary');

  // no INDEX.md at all must not throw
  const bare = tempRepo();
  r = gtg(bare, HANDOFF_ARGS('anything', 'Anything'), { input: BODY });
  assert.equal(r.status, 0, `missing INDEX.md must not fail the handoff: ${r.stderr}`);

  console.log('ok 12 - parent inferred from flag then INDEX.md, never guessed wrong');
}

// --- 13. duration_min computed from _session.json, absent when unavailable ---
{
  const repo = tempRepo();
  mkdirSync(join(repo, 'docs/handoffs'), { recursive: true });

  // a session that started 90 minutes ago, keyed by THIS session's cwd (the repo,
  // which is where gtg() spawns the CLI). The stamp is a per-cwd map so concurrent
  // worktree sessions don't clobber each other's clock.
  const started = new Date(Date.now() - 90 * 60000).toISOString();
  writeFileSync(join(repo, 'docs/handoffs/_session.json'),
    JSON.stringify({ sessions: { [repo]: started } }, null, 2));

  let r = gtg(repo, HANDOFF_ARGS('proj-d', 'Project D'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  let e = active(repo).handoffs[0];
  assert.ok(e.duration_min >= 89 && e.duration_min <= 92,
    `expected ~90 minutes, got: ${e.duration_min}`);

  // concurrency isolation: a stamp keyed to a DIFFERENT cwd must be ignored -
  // this session's clock is absent, not another session's.
  const other = tempRepo();
  mkdirSync(join(other, 'docs/handoffs'), { recursive: true });
  writeFileSync(join(other, 'docs/handoffs/_session.json'),
    JSON.stringify({ sessions: { 'C:/some/other/session': started } }, null, 2));
  r = gtg(other, HANDOFF_ARGS('proj-o', 'Project O'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(active(other).handoffs[0].duration_min, undefined,
    "another session's stamp must not be borrowed");

  // no _session.json: the field is absent, NOT zero and NOT guessed
  const bare = tempRepo();
  r = gtg(bare, HANDOFF_ARGS('proj-e', 'Project E'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(bare).handoffs[0];
  assert.equal(e.duration_min, undefined, 'no stamp must mean no figure, not zero');

  // a stale stamp (>24h) is ignored rather than reported as a 3-day session
  const stale = tempRepo();
  mkdirSync(join(stale, 'docs/handoffs'), { recursive: true });
  writeFileSync(join(stale, 'docs/handoffs/_session.json'),
    JSON.stringify({ sessions: { [stale]: new Date(Date.now() - 72 * 3600000).toISOString() } }));
  r = gtg(stale, HANDOFF_ARGS('proj-f', 'Project F'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(stale).handoffs[0];
  assert.equal(e.duration_min, undefined, 'a stale stamp must be discarded');

  // a malformed stamp must not throw
  const bad = tempRepo();
  mkdirSync(join(bad, 'docs/handoffs'), { recursive: true });
  writeFileSync(join(bad, 'docs/handoffs/_session.json'), 'not json at all');
  r = gtg(bad, HANDOFF_ARGS('proj-g', 'Project G'), { input: BODY });
  assert.equal(r.status, 0, `malformed _session.json must not fail: ${r.stderr}`);

  console.log('ok 13 - duration_min from the session stamp, absent when unknown');
}

// --- 14. grouped list: families, location, dirty flag, collision warning ---
{
  const repo = tempRepo();
  const wt = tempRepo();
  execSync('git commit -q --allow-empty -m init', { cwd: wt });

  // two projects in the SAME family
  let r = gtg(repo, [...HANDOFF_ARGS('fam-one', 'Fam One'), '--parent', 'fam'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  r = gtg(repo, [...HANDOFF_ARGS('fam-two', 'Fam Two'), '--parent', 'fam'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  // two standalone projects sharing one worktree AND branch - a collision
  r = gtg(repo, [...HANDOFF_ARGS('solo-a', 'Solo A'), '--worktree', wt], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  r = gtg(repo, [...HANDOFF_ARGS('solo-b', 'Solo B'), '--worktree', wt], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  // a standalone project sorting BEFORE the family alphabetically. Numbering
  // follows DISPLAY order (family group first, then standalone) - NOT full-sorted
  // order - so AAA First, though alphabetically first, numbers AFTER the two
  // family members. displayOrder = [Fam One, Fam Two, AAA First, Solo A, Solo B].
  r = gtg(repo, HANDOFF_ARGS('aaa-first', 'AAA First'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);

  r = gtg(repo, ['list']);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;

  assert.match(out, /▸ fam/, 'family header missing');
  assert.match(out, /▸ standalone/, 'standalone group missing');
  // assert on the warning LINE, not just the project name - the name also
  // appears in the listing above, which would pass a weaker match vacuously.
  const warnLine = out.split('\n').find((l) => /projects share/.test(l) && /Solo A/.test(l));
  assert.ok(warnLine, `no collision warning naming Solo A; got:\n${out}`);
  assert.match(warnLine, /Solo B/, 'collision warning must name both colliding projects');

  // numbering contract: numbers run 1..N in DISPLAY order AND round-trip via
  // resolveEntry. Fam One heads the family group -> 1; AAA First is alphabetically
  // first but standalone, so it sits after both family members -> 3. That gap
  // (1 vs a sorted-order 2) is what proves display order, not sorted position.
  const numOf = (proj) => out.split('\n').find((l) => l.includes(proj)).match(/(\d+)\./)[1];
  assert.equal(numOf('Fam One'), '1', `expected Fam One numbered 1 (display order), got ${numOf('Fam One')}`);
  assert.equal(numOf('AAA First'), '3', `expected AAA First numbered 3 (display order), got ${numOf('AAA First')}`);
  const num = numOf('Fam One');
  r = gtg(repo, ['back', num]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Parked: Fam One/,
    `number ${num} shown next to Fam One resolved to a different project`);

  // dirty worktree is flagged
  writeFileSync(join(wt, 'scratch.txt'), 'uncommitted');
  r = gtg(repo, ['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /uncommitted/, 'dirty worktree not flagged');

  console.log('ok 14 - grouped list with location, dirty flag, collision warning');
}

// --- 15. Finding C1: undo anchors on whichever store the last commit touched,
// not _active.json alone - a backlog-only mutation (park a new idea) undoes
// itself, not an unrelated older active-list commit ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('proj-b', 'Project B'), { input: BODY });
  const rp = gtg(repo, ['backlog', '--project', 'Idea X', '--slug', 'idea-x', '--next', 'TBD'], { input: BODY });
  assert.equal(rp.status, 0, rp.stderr);

  const ru = gtg(repo, ['undo']);
  assert.equal(ru.status, 0, ru.stderr);
  // Match on WHICH commit got undone (Idea X's park, not Project B's unrelated
  // handoff) rather than the exact subject wording - that wording is Finding I4's
  // concern, this test's concern is purely the anchor-commit selection (C1).
  assert.match(ru.stdout, /Undone:.*Idea X/,
    `undo must target the backlog-only park commit, not an unrelated active-list commit, got: ${ru.stdout}`);
  assert.doesNotMatch(ru.stdout, /Undone:.*Project B/,
    'undo must not revert the unrelated Project B handoff commit');

  const names = active(repo).handoffs.map((e) => e.project).sort();
  assert.deepEqual(names, ['Project A', 'Project B'],
    'undo of a backlog-only park must leave the active list untouched');
  const blPath = join(repo, 'docs/handoffs/_backlog.json');
  const backlogEmpty = !existsSync(blPath) || JSON.parse(readFileSync(blPath, 'utf8')).backlog.length === 0;
  assert.ok(backlogEmpty, 'undo must remove the parked idea, not leave the backlog wiped-but-stale or untouched');
  console.log('ok 15 - Finding C1: undo targets a backlog-only mutation correctly');
}

// --- 15b. Finding C1: same bug via the OTHER backlog-only mutation, `gtg resume
// <backlog-slug>` (consumes a backlog entry, writes _backlog.json alone) ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  gtg(repo, ['backlog', '--project', 'Idea Y', '--slug', 'idea-y', '--next', 'TBD'], { input: BODY });
  const rr = gtg(repo, ['resume', 'idea-y']);
  assert.equal(rr.status, 0, rr.stderr);

  const ru = gtg(repo, ['undo']);
  assert.equal(ru.status, 0, ru.stderr);
  assert.match(ru.stdout, /Undone: gtg resume: Idea Y/,
    `undo must target the backlog-consume commit, got: ${ru.stdout}`);
  assert.equal(active(repo).handoffs.length, 1, 'undo of a backlog-only resume must not touch the active list');
  const bl = JSON.parse(readFileSync(join(repo, 'docs/handoffs/_backlog.json'), 'utf8')).backlog;
  assert.equal(bl.length, 1, 'undo must restore the consumed backlog entry');
  assert.equal(bl[0].slug, 'idea-y');
  console.log('ok 15b - Finding C1: undo restores a consumed backlog-only entry');
}

// --- 16. Finding C1: undoing the very first-ever handoff removes _active.json
// entirely (no last^ to restore) rather than exiting 2 - the intended behaviour
// change called out in the finding ---
{
  const repo = tempRepo();
  const r = gtg(repo, HANDOFF_ARGS('only-one', 'Only One'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(repo, 'docs/handoffs/_active.json')));

  const ru = gtg(repo, ['undo']);
  assert.equal(ru.status, 0, `undoing the first-ever handoff must succeed, not exit 2: ${ru.stderr}`);
  assert.match(ru.stdout, /Active entries now \(0\)/);
  assert.ok(!existsSync(join(repo, 'docs/handoffs/_active.json')),
    '_active.json must be removed entirely, since it never existed before this commit');
  console.log('ok 16 - Finding C1: undo of the first-ever handoff removes _active.json, not exit 2');
}

// --- 17. Finding I1: parent and eta carry forward from the prior entry when
// --parent / --eta are omitted on a later handoff for the same slug ---
{
  const repo = tempRepo();
  let r = gtg(repo, [...HANDOFF_ARGS('sub-proj', 'Sub Proj'), '--parent', 'atlas', '--eta', '~3h'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  let e = active(repo).handoffs[0];
  assert.equal(e.parent, 'atlas');
  assert.equal(e.eta, '~3h');

  // second handoff, same slug, NEITHER flag passed
  r = gtg(repo, ['handoff', '--project', 'Sub Proj', '--slug', 'sub-proj', '--next', 'more work'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).handoffs[0];
  assert.equal(e.parent, 'atlas', 'parent must carry forward from the prior entry when --parent is omitted');
  assert.equal(e.eta, '~3h', 'eta must carry forward from the prior entry when --eta is omitted');

  // explicit --parent/--eta on a later handoff still overrides the carried value
  r = gtg(repo, ['handoff', '--project', 'Sub Proj', '--slug', 'sub-proj', '--next', 'x',
    '--parent', 'other-fam', '--eta', '~10m'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).handoffs[0];
  assert.equal(e.parent, 'other-fam', 'an explicit --parent must still override the carried-forward value');
  assert.equal(e.eta, '~10m', 'an explicit --eta must still override the carried-forward value');
  console.log('ok 17 - Finding I1: parent and eta carry forward when the flags are omitted');
}

// --- 18. Finding I2: `list()` falls back to the TRUE handoff-file count for a
// legacy entry (no `sessions` field), not a hardcoded 1 ---
{
  const repo = tempRepo();
  const dir = join(repo, 'docs/handoffs');
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 9; i++) writeFileSync(join(dir, `2026-01-0${i}-0900-legacy-proj.md`), '# old\n');
  writeFileSync(join(dir, '_active.json'), JSON.stringify({
    handoffs: [{ project: 'Legacy Proj', slug: 'legacy-proj', next: 'x', file: 'f', updated: new Date().toISOString() }],
  }, null, 2));

  const r = gtg(repo, ['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Legacy Proj s9/,
    `legacy entry with 9 handoff files on disk must render s9, not a hardcoded s1, got:\n${r.stdout}`);
  console.log('ok 18 - Finding I2: list() computes true session count for legacy entries');
}

// --- 19. Finding I3: sessions is monotonic - Math.max(disk count, prior + 1)
// so deleted handoff files (or a same-minute filename collision) never make the
// next handoff report a LOWER session number than one already recorded ---
{
  const repo = tempRepo();
  let r = gtg(repo, HANDOFF_ARGS('proj-mono', 'Project Mono'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(active(repo).handoffs[0].sessions, 1);

  // Simulate the regression: bump the stored `sessions` far ahead (as a real
  // history of handoffs would have done), then delete the handoff .md files
  // (plain docs, the README explicitly says fine to prune) so the on-disk
  // count no longer agrees with what was already recorded.
  const ap = join(repo, 'docs/handoffs/_active.json');
  const data = JSON.parse(readFileSync(ap, 'utf8'));
  data.handoffs[0].sessions = 5;
  writeFileSync(ap, JSON.stringify(data, null, 2) + '\n');
  const handoffDoc = data.handoffs[0].file;
  execSync(`git rm -q ${handoffDoc}`, { cwd: repo });
  execSync('git commit -q -m "prune old handoff docs"', { cwd: repo });

  r = gtg(repo, HANDOFF_ARGS('proj-mono', 'Project Mono'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  const sessions = active(repo).handoffs[0].sessions;
  assert.equal(sessions, 6, `sessions must never go backwards from a prior high-water mark, got: ${sessions}`);
  console.log('ok 19 - Finding I3: sessions counter never regresses');
}

// --- 20. Finding I4 (part 1): parking a NEW idea gets an unambiguous commit
// subject ('gtg backlog: new ...'), distinct from `back` shelving an active
// entry ('gtg backlog: park ...', unchanged - historical commits use it) ---
{
  const repo = tempRepo();
  const rp = gtg(repo, ['backlog', '--project', 'Fresh Idea', '--slug', 'fresh-idea', '--next', 'TBD'], { input: BODY });
  assert.equal(rp.status, 0, rp.stderr);
  let subject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(subject, /^gtg backlog: new Fresh Idea - session 1$/, `got: ${subject}`);

  gtg(repo, HANDOFF_ARGS('proj-shelve', 'Project Shelve'), { input: BODY });
  const rb = gtg(repo, ['back', 'proj-shelve']);
  assert.equal(rb.status, 0, rb.stderr);
  subject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(subject, /^gtg backlog: park Project Shelve$/,
    'shelving an active entry must keep its historical subject unchanged');
  console.log('ok 20 - Finding I4a: new-idea park has its own unambiguous commit subject');
}

// --- 21. Finding I4 (part 2): autoShelf's commit subject names the projects it
// swept, not just a bare count ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('s-one', 'S One'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('s-two', 'S Two'), { input: BODY });
  const ap = join(repo, 'docs/handoffs/_active.json');
  const data = JSON.parse(readFileSync(ap, 'utf8'));
  for (const e of data.handoffs) e.updated = new Date(Date.now() - 8 * 86400000).toISOString();
  writeFileSync(ap, JSON.stringify(data, null, 2) + '\n');

  const r = gtg(repo, ['list']);
  assert.equal(r.status, 0, r.stderr);
  const subject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(subject, /^gtg backlog: auto-park 2 stale \(>7d\): S One, S Two$/, `got: ${subject}`);
  console.log('ok 21 - Finding I4b: autoShelf commit subject names the swept projects');
}

// --- 22. minor: firstHandoffDate() emits the same local-offset suffix nowIso()
// does (both aware, not one bare/one aware) ---
{
  const repo = tempRepo();
  const dir = join(repo, 'docs/handoffs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-03-10-0900-off-proj.md'), '# old\n');

  const r = gtg(repo, HANDOFF_ARGS('off-proj', 'Off Proj'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  const e = active(repo).handoffs[0];
  const createdOffset = e.created.match(/([+-]\d{2}:\d{2})$/);
  const updatedOffset = e.updated.match(/([+-]\d{2}:\d{2})$/);
  assert.ok(createdOffset, `created must carry a local-offset suffix like nowIso(), got: ${e.created}`);
  assert.ok(updatedOffset, `updated (nowIso) must carry a local-offset suffix, got: ${e.updated}`);
  assert.equal(createdOffset[1], updatedOffset[1], 'firstHandoffDate() and nowIso() must agree on the offset format');
  console.log('ok 22 - minor: created/updated offset format matches between firstHandoffDate and nowIso');
}

// --- 23. minor: dirtyCount() failure renders '?', distinct from a clean (0)
// worktree which renders nothing ---
{
  const repo = tempRepo();
  const r = gtg(repo, [...HANDOFF_ARGS('unreachable-wt', 'Unreachable Wt'),
    '--worktree', join(repo, 'no-such-worktree-dir')], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  const rl = gtg(repo, ['list']);
  assert.equal(rl.status, 0, rl.stderr);
  assert.match(rl.stdout, /●\s*\?\s*uncommitted/,
    `an unreachable explicit worktree must render '?', not silently show nothing, got:\n${rl.stdout}`);
  console.log('ok 23 - minor: unreachable worktree renders ? instead of silence');
}

// --- 23b. minor: entries with worktree 'repo root' (or legacy-undefined) must
// NEVER show a dirty flag, even when the hub itself is dirty - that count
// belongs to the hub, not to any one project (misattribution fix) ---
{
  const repo = tempRepo();
  const r = gtg(repo, HANDOFF_ARGS('hub-entry', 'Hub Entry'), { input: BODY }); // worktree: 'repo root'
  assert.equal(r.status, 0, r.stderr);
  writeFileSync(join(repo, 'unrelated-hub-churn.txt'), 'noise'); // dirty the HUB, not any project's worktree
  const rl = gtg(repo, ['list']);
  assert.equal(rl.status, 0, rl.stderr);
  assert.doesNotMatch(rl.stdout, /uncommitted/,
    `a 'repo root' entry must not be flagged dirty from hub churn, got:\n${rl.stdout}`);
  console.log('ok 23b - minor: repo-root entries never misattributed with hub dirty count');
}

// --- 24. minor: `list()`'s resolveDir duplication is gone - both the dirty-map
// build and per-entry render agree on where a project's worktree resolves,
// proven end-to-end via the SAME dirty flag appearing for the entry that owns it ---
{
  const repo = tempRepo();
  const wt = tempRepo();
  execSync('git commit -q --allow-empty -m init', { cwd: wt });
  writeFileSync(join(wt, 'dirty.txt'), 'x');
  const r = gtg(repo, [...HANDOFF_ARGS('own-wt-proj', 'Own Wt Proj'), '--worktree', wt], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  const rl = gtg(repo, ['list']);
  assert.equal(rl.status, 0, rl.stderr);
  assert.match(rl.stdout, /Own Wt Proj[\s\S]*?● 1 uncommitted/, 'dirty count for the entry\'s own worktree must resolve consistently');
  console.log('ok 24 - minor: resolveDir consistent between dirty-map build and render');
}

// --- 25. I2's ctx extension surface: `stats` (a bundled extension, receiving
// ONLY the documented ctx) also gets `countHandoffFiles` and uses it for the
// same legacy-entry fallback, instead of a hardcoded 1 ---
{
  const repo = tempRepo();
  const dir = join(repo, 'docs/handoffs');
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 4; i++) writeFileSync(join(dir, `2026-02-0${i}-0900-legacy-stats.md`), '# old\n');
  writeFileSync(join(dir, '_active.json'), JSON.stringify({
    handoffs: [{ project: 'Legacy Stats', slug: 'legacy-stats', next: 'x', file: 'f', updated: new Date().toISOString() }],
  }, null, 2));

  const r = gtg(repo, ['stats']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /deepest: Legacy Stats \(4\)/,
    `stats extension must use ctx.countHandoffFiles for a legacy entry's true count, got:\n${r.stdout}`);
  console.log('ok 25 - ctx contract: countHandoffFiles reaches the stats extension');
}

// --- 26. history: classify handoff (both formats), prune backfill, noise ---
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');

  // both handoff formats
  assert.deepEqual(H.classify('handoff: Project A — session 3'),
    { type: 'handoff', project: 'Project A', sessions: 3 });
  assert.deepEqual(H.classify('handoff: Legacy Proj — executing'),
    { type: 'handoff', project: 'Legacy Proj', sessions: undefined });

  // project name containing an em-dash must not be split by it
  assert.deepEqual(H.classify('handoff: Widget — parts catalog — session 2'),
    { type: 'handoff', project: 'Widget — parts catalog', sessions: 2 });

  // Hyphen twins. Every em-dash assertion in this case is a backward-compatibility
  // guard over commit subjects already in git history, so none of them may be swept.
  // These mirror them in the hyphen format gtg has written since 2026-08-05.
  assert.deepEqual(H.classify('handoff: Project A - session 3'),
    { type: 'handoff', project: 'Project A', sessions: 3 });
  assert.deepEqual(H.classify('handoff: Legacy Proj - executing'),
    { type: 'handoff', project: 'Legacy Proj', sessions: undefined });
  // the anchored session tail saves a project name that contains the separator
  assert.deepEqual(H.classify('handoff: Widget - parts catalog - session 2'),
    { type: 'handoff', project: 'Widget - parts catalog', sessions: 2 });
  // The legacy fallback has no anchor, so it must bind to the LAST separator.
  // Widening only the separator of the old negated-class pattern, and leaving the
  // negated class itself on the em dash, passes every other line in this case and
  // fails exactly here: it would strip from the FIRST separator and yield 'Widget'.
  assert.deepEqual(H.classify('handoff: Widget - parts catalog - executing'),
    { type: 'handoff', project: 'Widget - parts catalog', sessions: undefined });
  // a hyphen with no spaces around it is part of the name, not a separator
  assert.deepEqual(H.classify('handoff: gtg-extensions - session 4'),
    { type: 'handoff', project: 'gtg-extensions', sessions: 4 });
  assert.equal(H.classify('gtg backlog: new Idea Z - session 1').type, 'park');
  assert.equal(H.classify('gtg resume: Picked Up - handoff consumed').type, 'resume');
  assert.equal(H.classify('gtg resume: Picked Up - backlog handoff consumed').type, 'resume');

  // the other verbs
  assert.equal(H.classify('gtg backlog: new Idea Z — session 1').type, 'park');
  assert.equal(H.classify('gtg backlog: park Shelf Me').type, 'shelve');
  assert.equal(H.classify('gtg backlog: auto-park 2 stale (>7d): A, B').type, 'autoshelf');
  assert.equal(H.classify('gtg activate: Bring Back').type, 'activate');
  assert.equal(H.classify('gtg prune: remove Done Thing - confirmed done').type, 'prune');
  assert.equal(H.classify('gtg resume: Picked Up — handoff consumed').type, 'resume');
  assert.equal(H.classify("gtg undo: revert 'handoff: X — session 1'").type, 'undo');
  assert.equal(H.classify('Merge branch main into feature').type, 'noise');

  // slugify matches CLI conventions
  assert.equal(H.slugify('Widget — parts catalog'), 'widget-parts-catalog');
  assert.equal(H.slugify('Bench & Bar'), 'bench-bar');

  // backfill: a prune that recurs later is a resume; one that never returns shipped.
  // rawLog is newest-first, like `git log`.
  const raw = [
    { date: '2026-07-10T00:00:00+08:00', subject: 'handoff: Recurring — session 2' }, // later
    { date: '2026-07-08T00:00:00+08:00', subject: 'gtg prune: remove Recurring - confirmed done' },
    { date: '2026-07-05T00:00:00+08:00', subject: 'handoff: Recurring — session 1' },
    { date: '2026-07-04T00:00:00+08:00', subject: 'gtg prune: remove Gone Forever - confirmed done' },
    { date: '2026-07-03T00:00:00+08:00', subject: 'handoff: Gone Forever — session 1' },
  ];
  const ev = H.classifyEvents(raw);
  const recurringPrune = ev.find((e) => e.type === 'prune' && e.project === 'Recurring');
  const goneForeverPrune = ev.find((e) => e.type === 'prune' && e.project === 'Gone Forever');
  assert.equal(recurringPrune.resumed, true, 'a prune with a later handoff is a resume');
  assert.equal(recurringPrune.shipped, undefined);
  assert.equal(goneForeverPrune.shipped, true, 'a prune that never recurs is a ship');
  assert.equal(goneForeverPrune.resumed, undefined);

  console.log('ok 26 - history classifier + backfill');
}

// --- 27. history readers against a throwaway repo ---
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');
  const repo = tempRepo();
  mkdirSync(join(repo, 'docs/handoffs'), { recursive: true });

  // two handoff docs (readSessions reads filenames) + commits (readEvents reads subjects)
  writeFileSync(join(repo, 'docs/handoffs/2026-07-05-0900-alpha.md'), '# h');
  writeFileSync(join(repo, 'docs/handoffs/2026-07-06-1830-alpha.md'), '# h');
  execSync('git add -A', { cwd: repo });
  execSync('git commit -q -m "handoff: Alpha — session 2"', { cwd: repo });
  // a real prune touches _active.json under docs/handoffs/ (unlike --allow-empty,
  // which the readEvents pathspec would filter out - pathspec follows real usage).
  writeFileSync(join(repo, 'docs/handoffs/_active.json'), '{"handoffs":[]}');
  execSync('git add -A', { cwd: repo });
  execSync('git commit -q -m "gtg prune: remove Alpha - confirmed done"', { cwd: repo });

  const { events, available } = H.readEvents(repo);
  assert.equal(available, true, 'a real repo must report available');
  assert.ok(events.some((e) => e.type === 'handoff' && e.project === 'Alpha'), 'handoff event missing');
  assert.ok(events.some((e) => e.type === 'prune'), 'prune event missing');

  const sessions = H.readSessions(repo);
  assert.equal(sessions.length, 2, 'two handoff files → two sessions');
  assert.deepEqual(sessions.map((s) => s.hour).sort((a, b) => a - b), [9, 18]);
  assert.ok(sessions.every((s) => s.slug === 'alpha'));

  // a non-git dir degrades, never throws. GIT_CEILING_DIRECTORIES pins git's
  // upward search at tmpdir - readEvents() is called in-process here (unlike the
  // gtg() CLI helper above), so it inherits process.env directly; without the
  // ceiling, git would walk up and resolve the enclosing dev-machine repo.
  const bare = mkdtempSync(join(tmpdir(), 'gtg-nogit-'));
  const prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  let r;
  try { r = H.readEvents(bare); } finally {
    if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
  }
  assert.equal(r.available, false, 'non-git dir → available:false');
  assert.deepEqual(r.events, []);

  console.log('ok 27 - history readers');
}

// --- 28. readEvents walk-up guard: a subdir of a real repo that is NOT itself
// a repo must NOT inherit the enclosing repo's history as its own. Without the
// guard, `git -C <subdir> log` walks up and returns the OUTER repo's commits
// with available:true - a wrong answer presented as good data.
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');
  const outer = tempRepo();
  mkdirSync(join(outer, 'docs/handoffs'), { recursive: true });
  writeFileSync(join(outer, 'docs/handoffs/2026-07-05-0900-alpha.md'), '# h');
  execSync('git add -A', { cwd: outer });
  execSync('git commit -q -m "handoff: Alpha — session 1"', { cwd: outer });

  // subdir inside outer's worktree, deliberately NOT its own repo (no git init)
  const sub = join(outer, 'scratch-hub');
  mkdirSync(sub, { recursive: true });

  const prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
  delete process.env.GIT_CEILING_DIRECTORIES; // must NOT block the walk-up; the guard must
  let r, rOuter;
  try {
    r = H.readEvents(sub);
    rOuter = H.readEvents(outer);
  } finally {
    if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
  }
  assert.equal(r.available, false, 'non-repo subdir of a real repo must degrade, not inherit outer history');
  assert.deepEqual(r.events, []);
  assert.equal(rOuter.available, true, 'the real repo top-level itself must still report available');

  console.log('ok 28 - readEvents walk-up guard');
}

// --- 29. habit + throughput derivations (pure, injected data) ---
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');

  const ev = [ // newest-first
    { date: '2026-07-10T18:00:00+08:00', type: 'prune', project: 'P', slug: 'p', shipped: true },
    { date: '2026-07-09T09:00:00+08:00', type: 'handoff', project: 'P', slug: 'p', sessions: 2 },
    { date: '2026-07-08T11:00:00+08:00', type: 'handoff', project: 'P', slug: 'p', sessions: 1 },
    { date: '2026-07-05T14:00:00+08:00', type: 'park', project: 'Q', slug: 'q' },
  ];
  const sessions = [
    { date: '2026-07-08', hour: 11, slug: 'p' },
    { date: '2026-07-09', hour: 9, slug: 'p' },
  ];

  const h = H.habit(ev, sessions);
  assert.equal(h.activeDays, 4, 'four distinct active days');
  // 07-08, 07-09 (handoffs) and 07-10 (the ship/prune day, also an active
  // type per spec) are three calendar-consecutive days -> streak of 3.
  assert.equal(h.longestStreak, 3, '07-08, 07-09 & 07-10 (ship day) are consecutive');
  assert.equal(h.byHour[11], 1);
  assert.equal(h.byHour[9], 1);
  assert.equal(h.grid[0].date, '2026-07-05', 'grid starts at the earliest active day');
  assert.equal(h.grid[h.grid.length - 1].date, '2026-07-10', 'grid ends at the latest');

  const t = H.throughput(ev);
  assert.equal(t.shipped, 1);
  assert.equal(t.parked, 1);
  assert.equal(t.lastShip.project, 'P');
  // P shipped 07-10, first handoff 07-08 → 2 days to ship
  assert.equal(t.medianDaysToShip, 2);
  assert.equal(t.shipRate, null, 'shipRate is filled by the assembler, not here');

  console.log('ok 29 - habit + throughput');
}

// --- 30. family / per-project / health / fun derivations ---
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');
  const ev = [
    { date: '2026-07-12T10:00:00+08:00', type: 'prune', project: 'Widget Stats', slug: 'widget-stats', shipped: true },
    { date: '2026-07-11T10:00:00+08:00', type: 'handoff', project: 'Widget Stats', slug: 'widget-stats', sessions: 1 },
    { date: '2026-07-06T10:00:00+08:00', type: 'activate', project: 'Old Idea', slug: 'old-idea' },
    { date: '2026-07-05T10:00:00+08:00', type: 'park', project: 'Old Idea', slug: 'old-idea' },
    { date: '2026-07-04T10:00:00+08:00', type: 'resume', project: 'Widget Data', slug: 'widget-data' },
    { date: '2026-07-02T10:00:00+08:00', type: 'handoff', project: 'Widget Data', slug: 'widget-data', sessions: 1 },
  ];
  const sessions = [
    { date: '2026-07-11', hour: 10, slug: 'widget-stats' },
    { date: '2026-07-02', hour: 10, slug: 'widget-data' },
  ];
  const active = [{ slug: 'old-idea', project: 'Old Idea', parent: undefined, updated: '2026-07-06T10:00:00+08:00' }];
  const backlog = [];

  const rows = H.perProject(ev, sessions, active, backlog);
  const stats = rows.find((r) => r.slug === 'widget-stats');
  assert.equal(stats.status, 'shipped');
  assert.equal(stats.daysToShip, 1, 'handoff 07-11 → ship 07-12');
  const idea = rows.find((r) => r.slug === 'old-idea');
  assert.equal(idea.status, 'active', 'in the active store → active');

  // family grouping needs parent on the rows; assign via a fake INDEX join
  rows.forEach((r) => { if (r.slug.startsWith('widget')) r.parent = 'widget'; });
  const fams = H.families(rows);
  const widget = fams.find((f) => f.parent === 'widget');
  assert.equal(widget.subProjects, 2, 'widget-stats + widget-data');
  assert.equal(widget.shipped, 1);
  assert.equal(widget.first, '2026-07-02', 'earliest born date across the family');
  assert.equal(widget.latest, '2026-07-12', 'latest activity across the family');
  assert.equal(widget.totalHours, 0, 'no effort passed → no hours claimed');

  // effort join: rows carry minutes off the REAL slug, families sum them exactly
  const effort = { bySlug: { 'widget-stats': [45, 45], 'widget-data': [30] } };
  const timed = H.perProject(ev, sessions, active, backlog, effort);
  timed.forEach((r) => { if (r.slug.startsWith('widget')) r.parent = 'widget'; });
  assert.equal(timed.find((r) => r.slug === 'widget-stats').minutes, 90);
  assert.equal(timed.find((r) => r.slug === 'old-idea').minutes, null, 'untimed → null, not 0');
  assert.equal(H.families(timed).find((f) => f.parent === 'widget').totalHours, 2, '120min across the family');

  const hl = H.health(ev, rows);
  assert.equal(hl.resurrectionRate, 1, 'one activate, one park → 1.0');

  const fn = H.fun(ev, rows);
  assert.equal(fn.mostResumed.slug, 'widget-data', 'widget-data has the resume');

  console.log('ok 30 - family / per-project / health / fun');
}

// --- 31. health(): wipByDay must not invert spans (Finding 1), abandonmentRate
// must be computed over distinct parked slugs, not raw park/shelve events (Finding 2) ---
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');

  // Finding 1: resume-before-handoff must not produce an inverted (empty) span.
  const wipEvents = [
    { date: '2026-07-01T09:00:00+08:00', type: 'resume', project: 'Resumed No Ship', slug: 'resumed-no-ship' },
    { date: '2026-07-05T09:00:00+08:00', type: 'handoff', project: 'Resumed No Ship', slug: 'resumed-no-ship' },
    { date: '2026-07-10T09:00:00+08:00', type: 'handoff', project: 'Shipped After', slug: 'shipped-after' },
    { date: '2026-07-12T09:00:00+08:00', type: 'prune', project: 'Shipped After', slug: 'shipped-after', shipped: true },
  ];
  const wipHealth = H.health(wipEvents, []);
  assert.ok(wipHealth.wipByDay.length > 0,
    'wipByDay must not come back empty when a slug has resume-before-handoff (old code inverted the span)');
  const handoffDay = wipHealth.wipByDay.find((d) => d.date === '2026-07-05');
  assert.ok(handoffDay && handoffDay.count >= 1,
    'the resumed-then-handed-off project must be counted as in-progress on its first handoff day');
  const shipDay = wipHealth.wipByDay.find((d) => d.date === '2026-07-12');
  assert.ok(shipDay, "the genuinely-shipped project's ship day must fall within the wipByDay range");
  for (const d of wipHealth.wipByDay) assert.ok(d.count >= 0, `negative/garbage count at ${d.date}`);

  // Finding 2: abandonmentRate/resurrectionRate must share a distinct-slug denominator.
  const abEvents = [
    { date: '2026-06-01T09:00:00+08:00', type: 'park', project: 'Parked Twice', slug: 'parked-twice' },
    { date: '2026-06-10T09:00:00+08:00', type: 'park', project: 'Parked Twice', slug: 'parked-twice' },
    { date: '2026-06-01T09:00:00+08:00', type: 'park', project: 'Parked Recovered', slug: 'parked-recovered' },
    { date: '2026-06-05T09:00:00+08:00', type: 'activate', project: 'Parked Recovered', slug: 'parked-recovered' },
  ];
  const abRows = [
    { slug: 'parked-twice', status: 'dormant' },
    { slug: 'parked-recovered', status: 'active' },
  ];
  const abHealth = H.health(abEvents, abRows);
  assert.equal(abHealth.abandonmentRate, 0.5,
    'abandonmentRate must be 1 abandoned / 2 distinct parked slugs, not 1/3 raw park events');
  assert.equal(abHealth.resurrectionRate, 0.5,
    'resurrectionRate must share the same distinct-parked-slug denominator');

  console.log('ok 31 - health(): wipByDay non-inversion + abandonment/resurrection distinct-slug units');
}

// --- 32. effort: recover committed durations from _active.json diffs ---
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');
  const repo = tempRepo();
  mkdirSync(join(repo, 'docs/handoffs'), { recursive: true });
  const write = (obj) => writeFileSync(join(repo, 'docs/handoffs/_active.json'), JSON.stringify(obj, null, 2) + '\n');

  write({ handoffs: [{ project: 'P', slug: 'p', duration_min: 45 }] });
  execSync('git add -A && git commit -q -m "handoff: P — session 1"', { cwd: repo });
  write({ handoffs: [{ project: 'P', slug: 'p', duration_min: 90 }] });
  execSync('git add -A && git commit -q -m "handoff: P — session 2"', { cwd: repo });
  write({ handoffs: [{ project: 'Q', slug: 'q', duration_min: 30 }] });
  execSync('git add -A && git commit -q -m "handoff: Q — session 1"', { cwd: repo });

  const d = H.readDurations(repo);
  assert.equal(d.total, 45 + 90 + 30, 'sum of all committed durations');
  assert.equal(d.sessionsTimed, 3);
  assert.deepEqual(d.bySlug.p.sort((a, b) => a - b), [45, 90]);
  assert.deepEqual(d.bySlug.q, [30]);

  // derived roll-ups
  assert.equal(d.avgSessionMin, 55, '(45+90+30)/3');
  assert.equal(d.longestSessionMin, 90);
  assert.equal(d.hoursBySlug.p, 2.3, '135min -> 2.3h (1dp)');
  const weekHours = Object.values(d.hoursByWeek).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(weekHours - 165 / 60) < 0.11, 'weekly buckets account for the whole total');

  // no git → empty, no throw
  const bare = mkdtempSync(join(tmpdir(), 'gtg-nod-'));
  const bareResult = H.readDurations(bare);
  assert.equal(bareResult.total, 0);
  assert.equal(bareResult.sessionsTimed, 0);
  assert.deepEqual(bareResult.bySlug, {});
  assert.equal(bareResult.avgSessionMin, null, 'no data → null, never 0');

  // walk-up guard: a non-repo subdir nested in an outer repo that HAS committed
  // durations (tracked at a path that lines up with cwd-relative pathspec
  // resolution - git's pathspec is relative to cwd, so the nested file's repo
  // path must physically match "scratch-hub/docs/handoffs/_active.json" for the
  // leak to be reachable at all) must yield the empty result, never that data.
  const outer = tempRepo();
  mkdirSync(join(outer, 'scratch-hub/docs/handoffs'), { recursive: true });
  writeFileSync(join(outer, 'scratch-hub/docs/handoffs/_active.json'),
    JSON.stringify({ handoffs: [{ project: 'Leak', slug: 'leak', duration_min: 999 }] }, null, 2) + '\n');
  execSync('git add -A && git commit -q -m "handoff: Leak — session 1"', { cwd: outer });
  const sub = join(outer, 'scratch-hub'); // deliberately NOT its own repo (no git init)

  const prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
  delete process.env.GIT_CEILING_DIRECTORIES; // must NOT block the walk-up; the guard must
  let subResult;
  try { subResult = H.readDurations(sub); } finally {
    if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
  }
  assert.equal(subResult.total, 0, 'non-repo subdir of a real repo must degrade, not inherit outer durations');
  assert.deepEqual(subResult.bySlug, {});

  console.log('ok 32 - effort durations');
}

// --- 32b. effort: a non-handoff commit that re-adds an entry must NOT re-bill
// its duration. `gtg activate` (backlog -> active) and `gtg undo` both rewrite
// the whole entry with duration_min unchanged; counting those double-billed
// sessions that only ever happened once. ---
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');
  const repo = tempRepo();
  mkdirSync(join(repo, 'docs/handoffs'), { recursive: true });
  const write = (obj) => writeFileSync(join(repo, 'docs/handoffs/_active.json'), JSON.stringify(obj, null, 2) + '\n');
  const entry = { project: 'R', slug: 'r', duration_min: 60 };

  write({ handoffs: [entry] });
  execSync('git add -A && git commit -q -m "handoff: R — session 1"', { cwd: repo });
  write({ handoffs: [] });                                   // shelved to the backlog
  execSync('git add -A && git commit -q -m "gtg backlog: park R"', { cwd: repo });
  write({ handoffs: [entry] });                              // reactivated, same duration
  execSync('git add -A && git commit -q -m "gtg activate: R"', { cwd: repo });

  const d = H.readDurations(repo);
  assert.equal(d.total, 60, 'one real session, counted once - the activate re-add must not re-bill it');
  assert.equal(d.sessionsTimed, 1);
  assert.deepEqual(d.bySlug.r, [60]);

  console.log('ok 32b - effort ignores non-handoff re-adds');
}

// --- 33. buildReport assembler + report/stats commands ---
{
  const repo = tempRepo();
  // one shipped project, one active
  let r = gtg(repo, HANDOFF_ARGS('live-one', 'Live One'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  r = gtg(repo, HANDOFF_ARGS('shipme', 'Ship Me'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  r = gtg(repo, ['remove', 'shipme']); // ships it
  assert.equal(r.status, 0, r.stderr);

  // stats prints without crashing and reports the ship
  r = gtg(repo, ['stats']);
  assert.equal(r.status, 0, `stats failed: ${r.stderr}`);
  assert.match(r.stdout, /1 active, 0 backlog/);
  assert.match(r.stdout, /shipped/i);

  // report writes JSON to the default path and prints it
  r = gtg(repo, ['report']);
  assert.equal(r.status, 0, `report failed: ${r.stderr}`);
  const path = r.stdout.trim().split('\n').find((l) => l.includes('_report.json'));
  assert.ok(path, 'report must print the json path');
  const doc = JSON.parse(readFileSync(join(repo, 'docs/handoffs/_report.json'), 'utf8'));
  assert.equal(doc.historyAvailable, true);
  assert.equal(doc.counts.active, 1);
  assert.equal(doc.throughput.shipped, 1);
  assert.ok(doc.habit && doc.perProject && doc.families && doc.health && doc.fun, 'all sections present');
  assert.ok(doc.effort, 'effort section present');
  assert.ok(typeof doc.throughput.shipRate === 'number', 'assembler fills shipRate');

  // --json override
  r = gtg(repo, ['report', '--json', join(repo, 'custom.json')]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(repo, 'custom.json')));

  console.log('ok 33 - buildReport + report/stats commands');
}

// --- 34. perProject: canonicalise the join key to slugify(project). An event's
// slug comes from the commit subject (slugify(project)); a store entry's slug is
// the hand-chosen --slug. When they diverge, the old code (keyed store maps by
// entry.slug) produced a phantom event-row PLUS a separate store-row for one
// project. Keying both sides by slugify(project) merges them into one row. ---
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');
  const rawLog = [
    { date: '2026-07-20T10:00:00+08:00', subject: 'handoff: GTG Stats History Upgrade — session 2' },
    { date: '2026-07-18T10:00:00+08:00', subject: 'handoff: GTG Stats History Upgrade — session 1' },
    { date: '2026-07-15T10:00:00+08:00', subject: 'handoff: Same Slug Project — session 1' },
  ];
  const events = H.classifyEvents(rawLog);
  assert.ok(events.some((e) => e.slug === 'gtg-stats-history-upgrade'),
    'sanity: event slug is slugify(project), not the store slug');

  const active = [
    { project: 'GTG Stats History Upgrade', slug: 'gtg-stats-history', parent: 'gtg', updated: '2026-07-20T10:00:00+08:00' },
    { project: 'Same Slug Project', slug: 'same-slug-project', parent: undefined, updated: '2026-07-15T10:00:00+08:00' },
  ];
  const rows = H.perProject(events, [], active, []);

  // divergent slug ("gtg-stats-history" vs slugify → "gtg-stats-history-upgrade")
  const upgradeRows = rows.filter((r) => r.project === 'GTG Stats History Upgrade');
  assert.equal(upgradeRows.length, 1,
    'divergent slug must merge into ONE row, not a phantom dormant row + a separate active row');
  assert.equal(upgradeRows[0].status, 'active');
  assert.equal(upgradeRows[0].slug, 'gtg-stats-history', 'display slug is the store\'s REAL slug');
  assert.equal(upgradeRows[0].parent, 'gtg');

  // matching slug (slugify(project) already equals the store slug) - unaffected
  const sameRows = rows.filter((r) => r.project === 'Same Slug Project');
  assert.equal(sameRows.length, 1, 'matching-slug case must still yield exactly one row');
  assert.equal(sameRows[0].status, 'active');
  assert.equal(sameRows[0].slug, 'same-slug-project');

  console.log('ok 34 - perProject canonicalises the join key to slugify(project)');
}

// --- 35. tuned collision warning: master/main @ repo root is the sanctioned home
// for docs/meta work (home-repo doctrine) and must NOT warn; a genuine
// feature-branch collision (even at repo root) still does ---
{
  const repo = tempRepo(); // inits on -b main
  gtg(repo, HANDOFF_ARGS('meta-a', 'Meta A'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('meta-b', 'Meta B'), { input: BODY });
  let out = gtg(repo, ['list']).stdout;
  assert.doesNotMatch(out, /projects share/, 'main @ repo root must not be flagged as a collision');

  // two projects sharing a FEATURE branch at repo root - a real tangle
  gtg(repo, [...HANDOFF_ARGS('feat-a', 'Feat A'), '--branch', 'feat/x'], { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('feat-b', 'Feat B'), '--branch', 'feat/x'], { input: BODY });
  out = gtg(repo, ['list']).stdout;
  const warn = out.split('\n').find((l) => /projects share/.test(l));
  assert.ok(warn && /feat\/x/.test(warn), `feature-branch collision must still warn; got:\n${out}`);
  assert.match(warn, /Feat A/); assert.match(warn, /Feat B/);
  assert.doesNotMatch(warn, /Meta A/, 'base-branch @ repo root entries must be excluded from the warning');
  console.log('ok 35 - collision warning skips master/main @ repo root, still flags a feature branch');
}

// --- 36. auto-list after a move: suppressed when piped (AI / non-TTY, no wasted
// context), forced by --list, muted by --no-list ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('proj-b', 'Project B'), { input: BODY });

  // piped stdout (spawnSync) is not a TTY => no auto-render, just the move's line
  const rb = gtg(repo, ['back', 'proj-a']);
  assert.equal(rb.status, 0, rb.stderr);
  assert.match(rb.stdout, /Parked: Project A/);
  assert.doesNotMatch(rb.stdout, /active gtg project/,
    'a piped move must not dump the list - that is the wasted-context case');

  // --list forces the full render even when piped
  const ra = gtg(repo, ['active', 'proj-a', '--list']);
  assert.equal(ra.status, 0, ra.stderr);
  assert.match(ra.stdout, /Activated: Project A/);
  assert.match(ra.stdout, /active gtg project/, '--list must force the render');
  assert.match(ra.stdout, /Project B/, 'forced render shows the current active list');

  // --no-list suppresses it explicitly
  const rn = gtg(repo, ['back', 'proj-a', '--no-list']);
  assert.equal(rn.status, 0, rn.stderr);
  assert.doesNotMatch(rn.stdout, /active gtg project/);
  console.log('ok 36 - auto-list: off when piped, forced by --list, muted by --no-list');
}


// --- 37. rename: slug changes, children re-point, handoff files keep their names ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('fam', 'Family Parent'), { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('kid-one', 'Kid One'), '--parent', 'fam'], { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('kid-two', 'Kid Two'), '--parent', 'fam'], { input: BODY });
  const before = active(repo).handoffs.find((e) => e.slug === 'fam').file;

  const r = gtg(repo, ['rename', 'fam', 'family']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Renamed: Family Parent \(fam -> family\)/);
  assert.match(r.stdout, /re-pointed 2 sub-project/);
  assert.match(r.stdout, /projects rename fam family/, 'it points at the portfolio half');

  const hs = active(repo).handoffs;
  assert.equal(hs.filter((e) => e.slug === 'family').length, 1, 'renamed, not duplicated');
  assert.equal(hs.filter((e) => e.slug === 'fam').length, 0);
  assert.deepEqual(hs.filter((e) => e.parent === 'family').map((e) => e.slug).sort(),
    ['kid-one', 'kid-two'], 'both children follow the parent');
  assert.equal(hs.filter((e) => e.parent === 'fam').length, 0,
    'no orphan left pointing at the old slug');

  // History is retained: the handoff file keeps the name it was written under, and the entry
  // still points at a file that exists.
  const after = hs.find((e) => e.slug === 'family').file;
  assert.equal(after, before, 'the file field is untouched');
  assert.match(after, /-fam\.md$/, 'the old slug stays in the filename, which is the record');
  assert.ok(existsSync(join(repo, after)), 'and that file is still on disk');
  console.log('ok 37 - rename: slug changes, children re-point, handoff files keep their names');
}

// --- 38. rename: refusals, and a backlog entry renames too ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('proj-b', 'Project B'), { input: BODY });

  assert.equal(gtg(repo, ['rename']).status, 2, 'no args is a usage error');
  assert.equal(gtg(repo, ['rename', 'proj-a']).status, 2, 'a missing target is a usage error');
  const bad = gtg(repo, ['rename', 'proj-a', 'has spaces']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /must match/, 'a slug becomes a path segment, so it is constrained');
  const taken = gtg(repo, ['rename', 'proj-a', 'proj-b']);
  assert.equal(taken.status, 2);
  assert.match(taken.stderr, /already used by another project/);
  const self = gtg(repo, ['rename', 'proj-a', 'proj-a']);
  assert.equal(self.status, 2);
  assert.match(self.stderr, /already its slug/);
  assert.equal(gtg(repo, ['rename', 'nope', 'whatever']).status, 2);
  assert.deepEqual(active(repo).handoffs.map((e) => e.slug).sort(), ['proj-a', 'proj-b'],
    'every refusal left both slugs alone');

  // A shelved entry is renameable, since resolve falls through to the backlog.
  gtg(repo, ['back', 'proj-a', '--no-list']);
  const shelved = gtg(repo, ['rename', 'proj-a', 'alpha', '--no-list']);
  assert.equal(shelved.status, 0, shelved.stderr);
  const bl = JSON.parse(readFileSync(join(repo, 'docs/handoffs/_backlog.json'), 'utf8')).backlog;
  assert.equal(bl.filter((e) => e.slug === 'alpha').length, 1, 'the backlog entry was renamed');
  console.log('ok 38 - rename: refusals, and a backlog entry renames too');
}

// --- 39. log reads git, filters by project, and survives a rename ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('proj-b', 'Project B'), { input: BODY });
  gtg(repo, ['rename', 'proj-a', 'alpha', '--no-list']);

  const all = gtg(repo, ['log']);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /gtg rename: proj-a to alpha/);
  assert.match(all.stdout, /Project B/, 'bare log covers every project');

  // Subjects carry the NAME, not the slug, so filtering by the new slug still finds history
  // written under the old one. That is why rename leaves names alone.
  const one = gtg(repo, ['log', 'alpha']);
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /Project A/);
  assert.doesNotMatch(one.stdout, /Project B/, 'the filter is per project');

  assert.equal(gtg(repo, ['log', 'nope']).status, 2, 'an unknown project is a usage error');
  const bounded = gtg(repo, ['log', '-n', '1']);
  assert.equal(bounded.status, 0, bounded.stderr);
  assert.equal(bounded.stdout.trim().split('\n').length, 1, '-n bounds the output');
  console.log('ok 39 - log reads git, filters by project, and survives a rename');
}

// --- 40. an inherited Object key is not a verb ---
{
  const repo = tempRepo();
  // These resolved up the prototype chain off the builtins literal, so each called something
  // that is not a verb and reported success instead of reaching the unknown-command error.
  for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    const r = gtg(repo, [key]);
    assert.equal(r.status, 2, `${key} must be refused, got ${r.status}`);
  }
  console.log('ok 40 - an inherited Object key is not a verb');
}


// --- 41. rename repairs a stale parent reference when nothing carries that slug ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('bali-trip', 'Bali Trip'), { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('bali-shopping', 'Bali Shopping'), '--parent', 'bali-trip-2026'],
    { input: BODY });
  // Simulate what a PORTFOLIO rename leaves behind: entries pointing at a portfolio slug that no
  // longer exists, while no gtg entry carries that slug itself.
  const store = JSON.parse(readFileSync(join(repo, 'docs/handoffs/_active.json'), 'utf8'));
  for (const e of store.handoffs) if (e.slug === 'bali-trip') e.parent = 'bali-trip-2026';
  writeFileSync(join(repo, 'docs/handoffs/_active.json'), JSON.stringify(store, null, 2));

  const r = gtg(repo, ['rename', 'bali-trip-2026', 'bali-trip', '--no-list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Re-pointed 2 entries from parent 'bali-trip-2026' to 'bali-trip'/);
  const after = active(repo).handoffs;
  assert.equal(after.filter((e) => e.parent === 'bali-trip-2026').length, 0, 'no dangle left');
  assert.equal(after.filter((e) => e.parent === 'bali-trip').length, 2);
  // The target already existing as a slug is normal here, and must NOT be refused: that is the
  // opposite of what renaming an entry requires.
  assert.equal(after.filter((e) => e.slug === 'bali-trip').length, 1, 'no slug was harmed');
  assert.equal(after.filter((e) => e.slug === 'bali-shopping').length, 1);

  // A slug that is neither an entry nor any parent is still an error.
  const nothing = gtg(repo, ['rename', 'not-a-thing-anywhere', 'whatever']);
  assert.equal(nothing.status, 2);
  assert.match(nothing.stderr, /No project or parent reference matching/);
  console.log('ok 41 - rename repairs a stale parent reference when nothing carries that slug');
}

// --- 42. undo is scoped to the calling session ---
// The 2026-07-14 hazard: session A removes an entry, session B parks something,
// A's undo reverted B's park and left A's entry gone. Two concurrent sessions on
// one checkout is the normal setup here, so this is the default case, not an edge.
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY, session: 'sess-A' });
  gtg(repo, HANDOFF_ARGS('proj-b', 'Project B'), { input: BODY, session: 'sess-B' });

  // B's handoff is the tip, so A has a change in history but not the latest one.
  const crossA = gtg(repo, ['undo'], { session: 'sess-A' });
  assert.equal(crossA.status, 2, 'undo must refuse when another session committed after ours');
  assert.match(crossA.stderr, /another session changed the store after yours/);
  assert.equal(active(repo).handoffs.length, 2, 'a refused undo must not touch the stores');

  // A session that never mutated anything has nothing of its own to revert.
  const stranger = gtg(repo, ['undo'], { session: 'sess-C' });
  assert.equal(stranger.status, 2, 'undo must refuse a session with no change of its own');
  assert.match(stranger.stderr, /no change from this session to undo/);
  assert.equal(active(repo).handoffs.length, 2, 'a refused undo must not touch the stores');

  // No session identity at all: refuse rather than revert a stranger's commit.
  const anon = gtg(repo, ['undo'], { session: null });
  assert.equal(anon.status, 2, 'undo must refuse without a session id');
  assert.match(anon.stderr, /no session id/);
  assert.equal(active(repo).handoffs.length, 2, 'a refused undo must not touch the stores');

  // B owns the tip, so B's undo is the one that goes through.
  const ownB = gtg(repo, ['undo'], { session: 'sess-B' });
  assert.equal(ownB.status, 0, ownB.stderr);
  const slugs = active(repo).handoffs.map((e) => e.slug);
  assert.deepEqual(slugs, ['proj-a'], 'B\'s undo must revert B\'s own handoff only');
  console.log('ok 42 - undo is scoped to the calling session');
}

// --- 43. supersede is neither a ship nor an abandonment ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('slice-1', 'Slice One'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('parent-proj', 'Parent Proj'), { input: BODY });

  assert.equal(gtg(repo, ['supersede']).status, 2, 'supersede needs a target');
  assert.equal(gtg(repo, ['supersede', 'slice-1', '--into']).status, 2, '--into needs a value');
  assert.equal(gtg(repo, ['supersede', 'nope']).status, 2, 'an unknown project is a usage error');
  assert.equal(gtg(repo, ['supersede', 'slice-1', '--into', 'slice-1']).status, 2,
    'an entry cannot supersede itself');

  const r = gtg(repo, ['supersede', 'slice-1', '--into', 'parent-proj']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Superseded: Slice One -> Parent Proj/);
  assert.deepEqual(active(repo).handoffs.map((e) => e.slug), ['parent-proj'], 'entry not removed');

  const subject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(subject, 'gtg supersede: Slice One into Parent Proj');

  // The point of the verb: the roll-up must not read as a ship or an abandonment.
  const { classify } = await import('../skills/gtg/extensions/lib/history.mjs');
  const c = classify(subject);
  assert.equal(c.type, 'supersede');
  assert.equal(c.project, 'Slice One');
  assert.equal(c.into, 'Parent Proj');
  assert.equal(classify('gtg supersede: Filed In Error').type, 'supersede');
  assert.equal(classify('gtg supersede: Filed In Error').into, undefined);
  console.log('ok 43 - supersede is neither a ship nor an abandonment');
}

// --- 44. a superseded slug stops counting as abandoned ---
{
  const { classifyEvents, health } = await import('../skills/gtg/extensions/lib/history.mjs');
  const raw = [
    { date: '2026-07-25T12:12:00+08:00', subject: 'gtg supersede: Slice One into Parent Proj' },
    { date: '2026-07-25T12:00:00+08:00', subject: 'gtg backlog: new Slice One — session 1' },
    { date: '2026-07-25T11:00:00+08:00', subject: 'gtg backlog: new Dropped Thing — session 1' },
  ];
  const events = classifyEvents(raw);
  // No rows: both slugs were parked and then left the stores, which is exactly the
  // shape that used to report every consolidated slice as abandoned forever.
  // 2 parked slugs, 1 of them genuinely dropped. Before the fix this read 1.0.
  const { abandonmentRate } = health(events, []);
  assert.equal(abandonmentRate, 0.5, 'only the genuinely dropped slug should count as abandoned');
  console.log('ok 44 - a superseded slug stops counting as abandoned');
}

// --- 45. an entry in a registered extension namespace does not render in `list` ---
// Extensions (issues, learn) own handoff entries and render their own separated
// list, so leaving them in `gtg list` shows the same work twice and buries the
// projects the list exists for. Asserted on the project NAME, which is what the
// renderer prints, not the slug.
{
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('issues-p9-x', 'Issues P9: x'), '--parent', 'issues'], { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('learning-go', 'Learning: Go'), '--parent', 'learning'], { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('real-project', 'Real Project'), '--parent', 'gtg'], { input: BODY });
  const r = gtg(repo, ['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('Issues P9: x'), 'issue package leaked into gtg list');
  assert.ok(!r.stdout.includes('Learning: Go'), 'learning sprint leaked into gtg list');
  assert.ok(r.stdout.includes('Real Project'), 'a real project was wrongly excluded');
  // The families the header counts must not include the excluded namespaces either.
  assert.doesNotMatch(r.stdout, /▸ issues/, 'an extension namespace rendered as a family group');
  assert.doesNotMatch(r.stdout, /▸ learning/, 'an extension namespace rendered as a family group');
  console.log('ok 45 - an extension namespace does not render in list');
}

// --- 46. the same exclusion applies to `backlog` ---
{
  const repo = tempRepo();
  gtg(repo, ['backlog', '--project', 'Issues P8: y', '--slug', 'issues-p8-y',
    '--next', 'TBD', '--parent', 'issues'], { input: '## The Idea\nsomething\n' });
  gtg(repo, ['backlog', '--project', 'Parked Idea', '--slug', 'parked-idea',
    '--next', 'TBD'], { input: '## The Idea\nsomething\n' });
  const r = gtg(repo, ['backlog']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('Issues P8: y'), 'issue package leaked into gtg backlog');
  assert.ok(r.stdout.includes('Parked Idea'), 'a real backlog item was wrongly excluded');
  assert.match(r.stdout, /^1 backlogged project\b/m, 'the shelf count still includes extension entries');
  // b<n> is what `gtg active <n>` resolves, so it has to number the rows shown.
  assert.match(r.stdout, /b1\. Parked Idea/, 'shelf numbering must run 1..N over the rows rendered');
  console.log('ok 46 - the exclusion applies to backlog too');
}

// --- 47. the count in the rendered summary agrees with what was rendered ---
// A banner or header saying 17 while the rows show 12 is the whole defect this
// exclusion exists to prevent.
{
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('issues-p9-x', 'Issues P9: x'), '--parent', 'issues'], { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('real-project', 'Real Project'), '--parent', 'gtg'], { input: BODY });
  const r = gtg(repo, ['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 active gtg project\b/, 'the count still includes extension entries');
  console.log('ok 47 - the rendered count agrees with the rendered rows');
}

// --- 48. autoShelf still acts on extension entries even though list hides them ---
// The regression guard for filtering at READ time instead of render time: `list` is
// the only path that runs the 7-day sweep, so an early filter would stop extension
// entries ever auto-shelving and silently empty `gtg learn`'s shelved section.
{
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('issues-p9-x', 'Issues P9: x'), '--parent', 'issues'], { input: BODY });
  const ap = join(repo, 'docs/handoffs/_active.json');
  const data = JSON.parse(readFileSync(ap, 'utf8'));
  data.handoffs[0].updated = new Date(Date.now() - 9 * 86400000).toISOString();
  writeFileSync(ap, JSON.stringify(data, null, 2) + '\n');
  const r = gtg(repo, ['list']);
  assert.equal(r.status, 0, r.stderr);
  const bl = JSON.parse(readFileSync(join(repo, 'docs/handoffs/_backlog.json'), 'utf8')).backlog;
  assert.ok(bl.some((e) => e.slug === 'issues-p9-x'),
    'an idle extension entry was not auto-shelved, so filtering happened before autoShelf');
  assert.equal(active(repo).handoffs.length, 0, 'the shelved entry is gone from active');
  console.log('ok 48 - autoShelf still sees extension entries');
}

// --- 49. ctx.ownEntries hands an extension both its shelves, and only its own ---
// The interface the issues and learn extensions read their own entries through. A
// user extension stands in for them here so this tests the ctx rather than either
// extension's output.
{
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('issues-p9-x', 'Issues P9: x'), '--parent', 'issues'], { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('real-project', 'Real Project'), '--parent', 'gtg'], { input: BODY });
  gtg(repo, ['backlog', '--project', 'Issues P8: y', '--slug', 'issues-p8-y',
    '--next', 'TBD', '--parent', 'issues'], { input: '## The Idea\nsomething\n' });
  gtg(repo, ['backlog', '--project', 'Parked Idea', '--slug', 'parked-idea',
    '--next', 'TBD'], { input: '## The Idea\nsomething\n' });
  const probe = 'export default async ({ ownEntries }) => {\n'
    + '  const { active, shelved } = ownEntries();\n'
    + '  console.log(JSON.stringify({ active: active.map((e) => e.slug), shelved: shelved.map((e) => e.slug) }));\n'
    + '};\n';
  mkdirSync(join(repo, '.gtg/commands'), { recursive: true });
  writeFileSync(join(repo, '.gtg/commands/issues.mjs'), probe);
  const r = gtg(repo, ['issues']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { active: ['issues-p9-x'], shelved: ['issues-p8-y'] },
    'ownEntries must return only the calling command\'s namespace, from BOTH stores');
  // A command that owns no namespace gets two empty arrays, never undefined.
  writeFileSync(join(repo, '.gtg/commands/nomad.mjs'), probe);
  const r2 = gtg(repo, ['nomad']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(JSON.parse(r2.stdout.trim()), { active: [], shelved: [] },
    'a command that owns no namespace must get empty arrays');
  console.log('ok 49 - ctx.ownEntries returns the calling extension\'s own entries');
}

// --- 50. an explicit query finds an extension entry, the bare listing still hides it ---
// Decluttering is not lookup. SKILL.md's exit procedure probes with `list <candidate>` before
// slugifying and reuses the matched entry's slug, so a blind probe would mint a SECOND entry
// beside a live issue package rather than updating it in place. The bare listing must still
// hide them, and the row numbers on a queried listing must keep meaning the same rows that
// `gtg back <n>` resolves, which is why a queried extension entry carries its slug instead of
// a number it has no claim to.
{
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('alpha-widget', 'Alpha Widget'), '--parent', 'gtg'], { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('beta-widget', 'Beta Widget'), '--parent', 'gtg'], { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('issues-p9-widget', 'Issues P9: widget'), '--parent', 'issues'],
    { input: BODY });

  // Exact slug, the form the reuse probe and every other verb use.
  const rs = gtg(repo, ['list', 'issues-p9-widget']);
  assert.equal(rs.status, 0, rs.stderr);
  assert.ok(rs.stdout.includes('Issues P9: widget'),
    'an exact-slug query must find an extension entry');
  assert.match(rs.stdout, /1 active gtg project\b.*matching 'issues-p9-widget'/,
    'a queried extension entry must be counted in the header it appears under');

  // Fuzzy project name, the form the exit procedure actually probes with.
  const rn = gtg(repo, ['list', 'Issues P9']);
  assert.equal(rn.status, 0, rn.stderr);
  assert.ok(rn.stdout.includes('Issues P9: widget'),
    'a project-name query must find an extension entry');

  // A query matching both kinds: real entries keep their canonical numbers, the extension
  // entry is labelled by slug because it has no position in the list those numbers index.
  const rq = gtg(repo, ['list', 'widget']);
  assert.equal(rq.status, 0, rq.stderr);
  assert.match(rq.stdout, /1\. Alpha Widget/, 'a queried real entry keeps its canonical number');
  assert.match(rq.stdout, /2\. Beta Widget/, 'a queried real entry keeps its canonical number');
  assert.match(rq.stdout, /issues-p9-widget: Issues P9: widget/,
    'a queried extension entry must be labelled by slug');
  assert.doesNotMatch(rq.stdout, /\d+\. Issues P9: widget/,
    'a queried extension entry must NOT carry a row number, it would address a different row');

  // The bare listing is unchanged: still hidden, still numbered the same way.
  const rb = gtg(repo, ['list']);
  assert.equal(rb.status, 0, rb.stderr);
  assert.ok(!rb.stdout.includes('Issues P9: widget'), 'the bare listing must still hide it');
  assert.match(rb.stdout, /1\. Alpha Widget/, 'bare and queried numbering must agree');
  assert.match(rb.stdout, /2\. Beta Widget/, 'bare and queried numbering must agree');

  // The consistency that matters: `<n>` resolves to the row the listing numbered <n>.
  const rback = gtg(repo, ['back', '2', '--no-list']);
  assert.equal(rback.status, 0, rback.stderr);
  assert.match(rback.stdout, /Parked: Beta Widget/,
    'back <n> must target the row both listings numbered <n>');

  // And an extension entry stays reachable by slug, which is what its label tells you to use.
  const rbe = gtg(repo, ['back', 'issues-p9-widget', '--no-list']);
  assert.equal(rbe.status, 0, rbe.stderr);
  assert.match(rbe.stdout, /Parked: Issues P9: widget/,
    'an extension entry must stay reachable by slug');
  // The hint on that same line must name something that resolves. sortByProject is filtered, so
  // indexOf is -1 and the number would be a 0 that `gtg active` cannot resolve.
  assert.match(rbe.stdout, /Bring back: gtg active issues-p9-widget/,
    'the bring-back hint must name the slug, not the 0 the filtered order yields');
  assert.doesNotMatch(rbe.stdout, /gtg active 0\b/, 'a 0 hint is not a resolvable target');
  console.log('ok 50 - an explicit query finds an extension entry, the bare listing hides it');
}

// --- 51. a targeted query reaches a SHELVED extension entry ---
// autoShelf parks anything idle over 7 days (case 48), which is normal for an issue package
// between fix sessions, and `backlog` hides extension entries. So without this, the moment a
// package is shelved no builtin listing shows it, `list <candidate>` goes blind again, and a
// departure mints the duplicate case 50 exists to prevent.
{
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('issues-p9-shelved', 'Issues P9: shelved'), '--parent', 'issues'],
    { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('real-shelved', 'Real Shelved'), '--parent', 'gtg'], { input: BODY });
  // Backdate both past the 7-day cutoff, then let `list` run the sweep (same trick as case 2b).
  const ap = join(repo, 'docs/handoffs/_active.json');
  const data = JSON.parse(readFileSync(ap, 'utf8'));
  for (const e of data.handoffs) e.updated = new Date(Date.now() - 9 * 86400000).toISOString();
  writeFileSync(ap, JSON.stringify(data, null, 2) + '\n');
  gtg(repo, ['list']);
  const bl = JSON.parse(readFileSync(join(repo, 'docs/handoffs/_backlog.json'), 'utf8')).backlog;
  assert.equal(bl.length, 2, 'setup: both entries must be on the shelf');            // GUARD
  assert.equal(active(repo).handoffs.length, 0, 'setup: nothing left active');       // GUARD

  // The "No active gtg projects matching '<filter>'" line echoes the query back, so each
  // assertion below deliberately looks for the OTHER identifier: querying by slug asserts on the
  // project name, querying by name asserts on the slug. Asserting on the echoed one would pass
  // with no fix at all.
  // FAIL-PRE-FIX: exact slug, the form the reuse probe uses.
  const rs = gtg(repo, ['list', 'issues-p9-shelved']);
  assert.equal(rs.status, 0, rs.stderr);
  assert.ok(rs.stdout.includes('Issues P9: shelved'),
    'a targeted query must reach a shelved extension entry');
  assert.match(rs.stdout, /gtg active issues-p9-shelved/,
    'the shelved line must name the command that brings it back');
  // FAIL-PRE-FIX: fuzzy project name, the form the exit procedure probes with.
  const rn = gtg(repo, ['list', 'Issues P9']);
  assert.equal(rn.status, 0, rn.stderr);
  assert.ok(rn.stdout.includes('issues-p9-shelved'),
    'a project-name query must reach a shelved extension entry');

  // GUARD: the bare listing is still the decluttered view and says nothing is active.
  const rb = gtg(repo, ['list']);
  assert.match(rb.stdout, /No active gtg projects/, 'the bare listing must not gain shelved rows');
  assert.ok(!rb.stdout.includes('issues-p9-shelved'), 'the bare listing must not name it');

  // GUARD, and the scope boundary: a shelved NORMAL project is still invisible to a query. That
  // hole predates the extension model and widening it is a documented-behaviour change.
  const rr = gtg(repo, ['list', 'Real Shelved']);
  assert.ok(!rr.stdout.includes('real-shelved'),
    'the generic shelved-project case is deliberately unchanged');

  // The co-occurrence case, and the one that was missing: a query matching ACTIVE work AND a
  // shelved extension entry. printShelved was called only on the `!shown.length` branch, so any
  // query that also hit active work silently dropped the shelved entry, which is exactly when
  // SKILL.md's "reuse the slug if EXACTLY ONE matches" rule does damage: two matches look like
  // one, and it is the wrong one. Live example: `gtg list Issues` matched an active package plus
  // two shelved ones and printed only the active rows.
  gtg(repo, [...HANDOFF_ARGS('issues-tracker-rewrite', 'Issues Tracker Rewrite'), '--parent', 'gtg'],
    { input: BODY });
  const rc = gtg(repo, ['list', 'Issues']);
  assert.equal(rc.status, 0, rc.stderr);
  // GUARD: the active match still renders as a numbered row on the normal path.
  assert.match(rc.stdout, /1\. Issues Tracker Rewrite/,
    'the active match must still render as a numbered row');
  // FAIL-PRE-FIX: the shelved hit must survive a query that also matched active work.
  assert.ok(rc.stdout.includes('Issues P9: shelved'),
    'a shelved extension entry was dropped because the query also matched active work');
  assert.match(rc.stdout, /gtg active issues-p9-shelved/,
    'the shelved line must still name its bring-back command on the non-empty path');

  // GUARD: `activate` resolves by slug and always did, so this only pins that the command the
  // shelved line advertises is a real one.
  const ra = gtg(repo, ['active', 'issues-p9-shelved', '--no-list']);
  assert.equal(ra.status, 0, ra.stderr);
  assert.match(ra.stdout, /Activated: Issues P9: shelved/);
  console.log('ok 51 - a targeted query reaches a shelved extension entry');
}

// --- 52. the hints back and active print are runnable for an extension entry ---
// Not a cosmetic bug: the README now tells you to address an extension entry by slug, so this is
// the documented flow. Before the fix `back <slug>` printed 'gtg active 0', and running it exits
// 2 because resolveEntry indexes arr[-1]. The test executes whatever the hint printed rather than
// asserting a shape, so it cannot pass while the advice is unrunnable.
{
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('issues-p9-round', 'Issues P9: round'), '--parent', 'issues'],
    { input: BODY });

  const rb = gtg(repo, ['back', 'issues-p9-round', '--no-list']);
  assert.equal(rb.status, 0, rb.stderr);
  const backHint = /Bring back: gtg (\S+ \S+)/.exec(rb.stdout);
  assert.ok(backHint, 'back must print a bring-back hint');                          // GUARD
  // FAIL-PRE-FIX: pre-fix this runs `gtg active 0` and exits 2.
  const ra = gtg(repo, [...backHint[1].split(' '), '--no-list']);
  assert.equal(ra.status, 0, `the printed hint 'gtg ${backHint[1]}' failed: ${ra.stderr}`);
  assert.match(ra.stdout, /Activated: Issues P9: round/);

  const activeHint = /Shelve again: gtg (\S+ \S+)/.exec(ra.stdout);
  assert.ok(activeHint, 'active must print a shelve-again hint');                    // GUARD
  // FAIL-PRE-FIX: the mirror-image bug in activate(), 'gtg back 0'.
  const rb2 = gtg(repo, [...activeHint[1].split(' '), '--no-list']);
  assert.equal(rb2.status, 0, `the printed hint 'gtg ${activeHint[1]}' failed: ${rb2.stderr}`);
  assert.match(rb2.stdout, /Parked: Issues P9: round/);
  console.log('ok 52 - the hints back and active print are runnable for an extension entry');
}

console.log('ALL PASS');
