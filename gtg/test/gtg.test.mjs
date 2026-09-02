#!/usr/bin/env node
// gtg self-check - assert-based, no framework. Runs every command against
// throwaway temp git repos. Non-zero exit on any failure.
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readCollection, writeCollection } from '../skills/gtg/lib/store.mjs';

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
  if (!(opts.env && 'CLAUDE_CODE_SESSION_ID' in opts.env)) delete env.CLAUDE_CODE_SESSION_ID;
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

// Store readers. Through readCollection, not a hand-rolled file read, so a fixture that
// seeds the LEGACY packed file (cases 18, 25) and one that runs a real gtg command (every
// other case, sharded) are both read the same way gtg reads them.
const ACTIVE = ['docs/handoffs/active', 'docs/handoffs/_active.json', 'handoffs'];
const BACKLOG = ['docs/handoffs/backlog', 'docs/handoffs/_backlog.json', 'backlog'];
const active = (root) => readCollection(root, ...ACTIVE);
const backlog = (root) => readCollection(root, ...BACKLOG);
// What a commit actually named, as "<status>\t<path>" lines. --no-renames on purpose: a park
// moves a record between two directories with the body barely changing, and rename detection
// would collapse the pair into one R line - hiding whether BOTH paths were named, which is the
// only thing that decides whether the removal gets committed or left for the next session.
const nameStatus = (root, ref) =>
  execSync(`git show --no-renames --name-status --format= ${ref}`, { cwd: root, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);

// Mutate the store the way the other machine would: read, edit, write each record back.
// Several cases backdate `updated` to trip the 7-day auto-shelf, which is the only way to
// reach that path without waiting a week.
const patchActive = (root, fn) => {
  const items = active(root);
  fn(items);
  writeCollection(root, ACTIVE[0], items);
};

// --- 1. handoff writes doc + an active record, commits ---
{
  const repo = tempRepo();
  const r = gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  assert.equal(r.status, 0, `handoff failed: ${r.stderr}`);
  const rel = r.stdout.split('\n')[0].trim();
  assert.match(rel, /^docs\/handoffs\/\d{4}-\d{2}-\d{2}-\d{4}-proj-a\.md$/);
  assert.ok(existsSync(join(repo, rel)), 'handoff doc missing');
  const doc = readFileSync(join(repo, rel), 'utf8');
  assert.match(doc, /^# Handoff: Project A/);
  assert.match(doc, /## Resume Prompt\nSay: "gtg proj-a"/);
  const entries = active(repo);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].slug, 'proj-a');
  assert.equal(entries[0].file, rel);
  const subject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(subject, /^handoff: Project A/);
  // dedupe by slug: second handoff for same slug replaces, not appends
  const r2 = gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(active(repo).length, 1, 'dedupe by slug failed');
  console.log('ok 1 - handoff');
}

// --- 1b. backlog park lands on the backlog store ---
{
  const repo = tempRepo();
  const r = gtg(repo, ['backlog', '--project', 'Idea X', '--slug', 'idea-x',
    '--eta', '~1h', '--next', 'TBD'], { input: '## The Idea\nsomething\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PARKED on backlog/);
  const bl = backlog(repo);
  assert.equal(bl.length, 1);
  assert.equal(bl[0].slug, 'idea-x');
  assert.ok(!existsSync(join(repo, ACTIVE[0])), 'backlog park must not touch the active store');
  console.log('ok 1b - backlog park');
}

// --- 5. GTG_HUB override: handoff lands in the hub, not the cwd repo ---
{
  const hub = tempRepo();
  const other = tempRepo();
  const r = gtg(other, HANDOFF_ARGS('hub-proj', 'Hub Project'), { input: BODY, hub });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(active(hub).map((e) => e.slug), ['hub-proj'], 'entry not in hub');
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
  // '_lead' and '.lead' are here because the store's SLUG_OK demands an alphanumeric first
  // character and this check has to be at least as strict, or the .md lands and the store throws.
  for (const bad of ['../evil', 'a/b', 'a;rm -rf', 'a b', '_lead', '.lead']) {
    const rb = gtg(repo, HANDOFF_ARGS(bad, 'X'), { input: BODY });
    assert.equal(rb.status, 2, `bad slug '${bad}' should exit 2`);
    assert.match(rb.stderr, /--slug must start with a letter or digit/);
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
  patchActive(repo, (h) => { h[0].updated = new Date(Date.now() - 8 * 86400000).toISOString(); });
  const r = gtg(repo, ['list']);
  assert.match(r.stdout, /Auto-shelved 1 project/);
  assert.match(r.stdout, /No active gtg projects/);
  const bl = backlog(repo);
  assert.equal(bl.length, 1);
  assert.equal(bl[0].slug, 'stale-proj');
  assert.equal(active(repo).length, 0);
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
// failure must exit NON-ZERO while still reporting the write that did happen.
//
// This assertion was inverted on 2026-08-18. It previously required exit 0, reasoning
// that the files are written regardless so the verb succeeded. The 2026-08-11 incident
// in docs/issues/2026-08-11-verb-commit-failure-exits-zero.md is the counter-evidence:
// a 39-call `projects set` backfill hit a stale .git/index.lock, and because every call
// warned on stderr and exited 0, the batch ran to completion and ended with 14 rows
// changed-but-uncommitted plus files left staged and ownerless in the shared home
// checkout, which blocks every other session's merges. A caller checking $? could not
// see it. Exit 0 on a partial success is what made the batch undetectable, so the exit
// code now reports the commit while stdout still reports the write - the four
// assertions below are unchanged from the original test.
{
  const repo = tempRepoNoIdentity();
  const noConfig = join(tmpdir(), `gtg-no-such-gitconfig-${process.pid}-${Date.now()}`);
  const r = gtg(repo, HANDOFF_ARGS('proj-c', 'Project C'), {
    input: BODY,
    env: { GIT_CONFIG_GLOBAL: noConfig, GIT_CONFIG_SYSTEM: noConfig, GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.notEqual(r.status, 0, `a genuine git commit failure must exit non-zero so a batch caller can detect it: ${r.stderr}`);
  assert.match(r.stdout, /^docs\/handoffs\/\d{4}-\d{2}-\d{2}-\d{4}-proj-c\.md$/m, 'handoff success output missing from stdout');
  assert.match(r.stdout, /RESUME: "gtg proj-c"/);
  assert.match(r.stderr, /uncommitted/i, 'genuine git commit failure must be surfaced as a warning, not swallowed');
  // The cause line, via firstMeaningfulLine: never blank (an empty stderr Buffer is TRUTHY and
  // used to shadow e.message, printing a bare dash) and never git's own CRLF warning or the first
  // of nine `hint:` lines, which is what a naive split('\n')[0] hands you on a Windows checkout.
  assert.match(r.stderr, /git commit failed[^\n]*- (?!(?:warning|hint):)\S/,
    `the failure line must name the cause, not advice or nothing at all: ${r.stderr}`);
  assert.equal(active(repo).length, 1, 'entry should still be written to disk despite commit failure');
  console.log('ok 3 - commit failure exits non-zero, write still reported');
}

// --- 3+4. remove empties the active store; undo restores it ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  const r = gtg(repo, ['remove', 'proj-a']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Removed: Project A/);
  assert.equal(active(repo).length, 0, 'remove left entries behind');
  const ru = gtg(repo, ['undo']);
  assert.equal(ru.status, 0, ru.stderr);
  assert.equal(active(repo).length, 1, 'undo did not restore');
  assert.equal(active(repo)[0].slug, 'proj-a');
  console.log('ok 3+4 - remove + undo');
}

// --- 4b. back shelves, active reactivates, remove falls through to backlog ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  const rb = gtg(repo, ['back', 'proj-a']);
  assert.match(rb.stdout, /Parked: Project A/);
  assert.equal(active(repo).length, 0);
  const bl = () => backlog(repo);
  assert.equal(bl().length, 1);
  const ra = gtg(repo, ['active', 'b1']);
  assert.match(ra.stdout, /Activated: Project A/);
  assert.equal(active(repo).length, 1);
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
  assert.equal(active(repo)[0].project, evilProject,
    'stored project must be the literal string including $(...), untouched');
  console.log('ok - Finding C1: shell injection via --project neutralized');
}

// --- Finding I1: undo must restore BOTH stores, not leave the entry duplicated ---
// back/active/autoShelf commit both stores together in one commit. undo used to restore
// only the active side from the pre-commit parent, leaving the moved entry ALSO present on
// the backlog.
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-i1', 'Project I1'), { input: BODY });
  gtg(repo, ['back', 'proj-i1']);
  const ru = gtg(repo, ['undo']);
  assert.equal(ru.status, 0, ru.stderr);
  const inActive = active(repo).some((e) => e.slug === 'proj-i1');
  const inBacklog = backlog(repo).some((e) => e.slug === 'proj-i1');
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
  patchActive(repo, (h) => { h[0].updated = new Date(Date.now() - 8 * 86400000).toISOString(); });
  execSync('git add -A && git commit -q -m "backdate for test"', { cwd: repo, stdio: 'ignore' });
  gtg(repo, ['remove', 'stale-undo']);
  const commitsBeforeUndo = execSync('git rev-list --count HEAD', { cwd: repo, encoding: 'utf8' }).trim();
  const ru = gtg(repo, ['undo']);
  assert.equal(ru.status, 0, ru.stderr);
  assert.equal(active(repo).length, 1, 'undo did not restore the stale entry to active');
  assert.equal(active(repo)[0].slug, 'stale-undo');
  assert.equal(backlog(repo).length, 0, 'undo must not re-park the stale entry to backlog');
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
  assert.equal(active(repo).length, 0, 'resume did not remove the entry');

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

  let e = active(repo)[0];
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
  e = active(repo)[0];
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
  const e = active(repo)[0];
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
  let e = active(repo)[0];
  assert.equal(e.worktree, wt, 'worktree must be stored on the entry');
  assert.equal(e.branch, 'feat/elsewhere',
    `branch must come from the worktree, not the storage root, got: ${e.branch}`);

  // explicit --branch wins over detection
  r = gtg(repo, [...HANDOFF_ARGS('proj-w2', 'Project W2'), '--worktree', wt,
    '--branch', 'stated/branch'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).find((x) => x.slug === 'proj-w2');
  assert.equal(e.branch, 'stated/branch');

  // no --worktree: defaults to 'repo root' and detects in the storage root
  r = gtg(repo, HANDOFF_ARGS('proj-w3', 'Project W3'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).find((x) => x.slug === 'proj-w3');
  assert.equal(e.worktree, 'repo root');
  assert.equal(e.branch, 'main', `storage-root branch expected, got: ${e.branch}`);

  // a worktree path that does not exist must not throw
  r = gtg(repo, [...HANDOFF_ARGS('proj-w4', 'Project W4'),
    '--worktree', join(repo, 'no-such-dir')], { input: BODY });
  assert.equal(r.status, 0, `missing worktree must not fail the handoff: ${r.stderr}`);
  e = active(repo).find((x) => x.slug === 'proj-w4');
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
  let e = active(repo).find((x) => x.slug === 'sub-project');
  assert.equal(e.parent, 'atlas', 'explicit --parent must be honoured verbatim');

  // fallback: slug prefix matches an INDEX.md page slug
  r = gtg(repo, HANDOFF_ARGS('widget-stats-page', 'Widget Stats Page'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).find((x) => x.slug === 'widget-stats-page');
  assert.equal(e.parent, 'widget', 'widget-* should infer the widget family');

  // fallback: two pages qualify ('widget' and 'widget-ads') - longest wins,
  // not whichever the shorter page happened to be listed first in INDEX.md
  r = gtg(repo, HANDOFF_ARGS('widget-ads-report', 'Widget Ads Report'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).find((x) => x.slug === 'widget-ads-report');
  assert.equal(e.parent, 'widget-ads', 'longest matching page slug must win the tie-break, not the first one found');

  // fallback: exact match - a project that IS the family
  r = gtg(repo, HANDOFF_ARGS('bench-and-bar', 'Bench & Bar'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).find((x) => x.slug === 'bench-and-bar');
  assert.equal(e.parent, 'bench-and-bar', 'an exact slug match is its own family');

  // no match: undefined, NOT a wrong guess
  r = gtg(repo, HANDOFF_ARGS('budget-planner', 'Budget Planner'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).find((x) => x.slug === 'budget-planner');
  assert.equal(e.parent, undefined, 'an unmatched slug must be standalone, not mis-assigned');

  // a partial word must not match: 'widgeteer' is not in the 'widget' family
  r = gtg(repo, HANDOFF_ARGS('widgeteer-thing', 'Widgeteer Thing'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).find((x) => x.slug === 'widgeteer-thing');
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
  let e = active(repo)[0];
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
  assert.equal(active(other)[0].duration_min, undefined,
    "another session's stamp must not be borrowed");

  // no _session.json: the field is absent, NOT zero and NOT guessed
  const bare = tempRepo();
  r = gtg(bare, HANDOFF_ARGS('proj-e', 'Project E'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(bare)[0];
  assert.equal(e.duration_min, undefined, 'no stamp must mean no figure, not zero');

  // a stale stamp (>24h) is ignored rather than reported as a 3-day session
  const stale = tempRepo();
  mkdirSync(join(stale, 'docs/handoffs'), { recursive: true });
  writeFileSync(join(stale, 'docs/handoffs/_session.json'),
    JSON.stringify({ sessions: { [stale]: new Date(Date.now() - 72 * 3600000).toISOString() } }));
  r = gtg(stale, HANDOFF_ARGS('proj-f', 'Project F'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(stale)[0];
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
// not the active one alone - a backlog-only mutation (park a new idea) undoes
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

  const names = active(repo).map((e) => e.project).sort();
  assert.deepEqual(names, ['Project A', 'Project B'],
    'undo of a backlog-only park must leave the active list untouched');
  assert.equal(backlog(repo).length, 0,
    'undo must remove the parked idea, not leave the backlog wiped-but-stale or untouched');
  console.log('ok 15 - Finding C1: undo targets a backlog-only mutation correctly');
}

// --- 15b. Finding C1: same bug via the OTHER backlog-only mutation, `gtg resume
// <backlog-slug>` (consumes a backlog entry, writes the backlog store alone) ---
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
  assert.equal(active(repo).length, 1, 'undo of a backlog-only resume must not touch the active list');
  const bl = backlog(repo);
  assert.equal(bl.length, 1, 'undo must restore the consumed backlog entry');
  assert.equal(bl[0].slug, 'idea-y');
  console.log('ok 15b - Finding C1: undo restores a consumed backlog-only entry');
}

// --- 16. Finding C1: undoing the very first-ever handoff removes the record file
// entirely (no last^ to restore) rather than exiting 2 - the intended behaviour
// change called out in the finding ---
{
  const repo = tempRepo();
  const r = gtg(repo, HANDOFF_ARGS('only-one', 'Only One'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  const rec = join(repo, ACTIVE[0], 'only-one.json');
  assert.ok(existsSync(rec));

  const ru = gtg(repo, ['undo']);
  assert.equal(ru.status, 0, `undoing the first-ever handoff must succeed, not exit 2: ${ru.stderr}`);
  assert.match(ru.stdout, /Active entries now \(0\)/);
  assert.ok(!existsSync(rec),
    'the record file must be removed entirely, since it never existed before this commit');
  const st = execSync('git status --porcelain', { cwd: repo, encoding: 'utf8' });
  assert.equal(st.trim(), '', `the undo left the removal uncommitted:\n${st}`);
  console.log('ok 16 - Finding C1: undo of the first-ever handoff removes the record file, not exit 2');
}

// --- 17. Finding I1: parent and eta carry forward from the prior entry when
// --parent / --eta are omitted on a later handoff for the same slug ---
{
  const repo = tempRepo();
  let r = gtg(repo, [...HANDOFF_ARGS('sub-proj', 'Sub Proj'), '--parent', 'atlas', '--eta', '~3h'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  let e = active(repo)[0];
  assert.equal(e.parent, 'atlas');
  assert.equal(e.eta, '~3h');

  // second handoff, same slug, NEITHER flag passed
  r = gtg(repo, ['handoff', '--project', 'Sub Proj', '--slug', 'sub-proj', '--next', 'more work'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo)[0];
  assert.equal(e.parent, 'atlas', 'parent must carry forward from the prior entry when --parent is omitted');
  assert.equal(e.eta, '~3h', 'eta must carry forward from the prior entry when --eta is omitted');

  // explicit --parent/--eta on a later handoff still overrides the carried value
  r = gtg(repo, ['handoff', '--project', 'Sub Proj', '--slug', 'sub-proj', '--next', 'x',
    '--parent', 'other-fam', '--eta', '~10m'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo)[0];
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
  assert.equal(active(repo)[0].sessions, 1);

  // Simulate the regression: bump the stored `sessions` far ahead (as a real
  // history of handoffs would have done), then delete the handoff .md files
  // (plain docs, the README explicitly says fine to prune) so the on-disk
  // count no longer agrees with what was already recorded.
  patchActive(repo, (h) => { h[0].sessions = 5; });
  const handoffDoc = active(repo)[0].file;
  execSync(`git rm -q ${handoffDoc}`, { cwd: repo });
  execSync('git commit -q -m "prune old handoff docs"', { cwd: repo });

  r = gtg(repo, HANDOFF_ARGS('proj-mono', 'Project Mono'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  const sessions = active(repo)[0].sessions;
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
  patchActive(repo, (h) => { for (const e of h) e.updated = new Date(Date.now() - 8 * 86400000).toISOString(); });

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
  const e = active(repo)[0];
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
  // A real prune touches the store under docs/handoffs/ - since the shard that is
  // active/<slug>.json, not the packed file this fixture writes. Either satisfies readEvents,
  // whose pathspec is the whole docs/handoffs/ directory; what the fixture must avoid is a
  // commit touching NOTHING under it (an --allow-empty prune), which the pathspec filters out.
  // Left packed deliberately: this case classifies a historical subject, and the real hub's
  // history has prune commits from both sides of the migration.
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

// --- 32c. effort: the duration pathspec spans the packed-to-sharded migration ---
// readDurations reads HISTORY, and history crosses the shard. A pathspec naming only the
// packed file zeroes every duration recorded after the migration; one naming only the
// directory zeroes every duration recorded before it. Neither failure raises anything - the
// figure just reads low - so both halves are committed here in one repo and the total is the
// assertion. The slug scan needs no per-file reset to make this work, and history.mjs records
// why: a handoff commits exactly ONE active record, and that record's own "slug" line always
// lands in the hunk with its duration_min. Q's 30 minutes landing on Q rather than on P is the
// half of this case that measures it.
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');
  const repo = tempRepo();
  mkdirSync(join(repo, 'docs/handoffs'), { recursive: true });

  // Pre-shard: one duration committed to the packed file.
  writeFileSync(join(repo, ACTIVE[1]),
    JSON.stringify({ handoffs: [{ project: 'P', slug: 'p', duration_min: 45 }] }, null, 2) + '\n');
  execSync('git add -A && git commit -q -m "handoff: P — session 1"', { cwd: repo });

  // Post-shard: P re-timed, then Q added, as per-record files.
  writeCollection(repo, ACTIVE[0], [{ project: 'P', slug: 'p', duration_min: 90 }]);
  execSync('git add -A && git commit -q -m "handoff: P — session 2"', { cwd: repo });
  writeCollection(repo, ACTIVE[0], [{ project: 'P', slug: 'p', duration_min: 90 },
    { project: 'Q', slug: 'q', duration_min: 30 }]);
  execSync('git add -A && git commit -q -m "handoff: Q — session 1"', { cwd: repo });

  const d = H.readDurations(repo);
  assert.equal(d.total, 45 + 90 + 30,
    `every duration on both sides of the migration must be recovered, got ${d.total}`);
  assert.equal(d.sessionsTimed, 3);
  assert.deepEqual(d.bySlug.p.sort((a, b) => a - b), [45, 90], 'P is timed across the migration');
  assert.deepEqual(d.bySlug.q, [30], "Q's duration must be billed to Q, not carried over from P");
  console.log('ok 32c - effort spans the packed-to-sharded migration');
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

  // The ONLY assertion tying the subject gtg.mjs WRITES to the regex history.mjs PARSES.
  // Everything above is store-derived or survives a broken parse: counts.active reads the
  // store, and a prune with no later handoff counts as shipped either way. Case 26 cannot
  // cover this either, because its subjects are string literals rather than this writer's
  // output. Break the separator or the session suffix in one place only and the session
  // number folds into the project NAME, so the handoff joins to no store entry and appears
  // as an extra phantom row here. That is the corruption the separator sweep existed to
  // prevent, and the row count is what detects it.
  assert.equal(doc.perProject.length, 2, 'a phantom project row means the subject no longer parses');
  assert.ok(doc.perProject.some((p) => p.project === 'Live One' && p.sessions === 1),
    'the handoff subject did not round-trip from writer to report');

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
  const before = active(repo).find((e) => e.slug === 'fam').file;

  const r = gtg(repo, ['rename', 'fam', 'family']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Renamed: Family Parent \(fam -> family\)/);
  assert.match(r.stdout, /re-pointed 2 sub-project/);
  assert.match(r.stdout, /projects rename fam family/, 'it points at the portfolio half');

  const hs = active(repo);
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
  assert.deepEqual(active(repo).map((e) => e.slug).sort(), ['proj-a', 'proj-b'],
    'every refusal left both slugs alone');

  // A shelved entry is renameable, since resolve falls through to the backlog.
  gtg(repo, ['back', 'proj-a', '--no-list']);
  const shelved = gtg(repo, ['rename', 'proj-a', 'alpha', '--no-list']);
  assert.equal(shelved.status, 0, shelved.stderr);
  const bl = backlog(repo);
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
  patchActive(repo, (h) => { for (const e of h) if (e.slug === 'bali-trip') e.parent = 'bali-trip-2026'; });

  const r = gtg(repo, ['rename', 'bali-trip-2026', 'bali-trip', '--no-list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Re-pointed 2 entries from parent 'bali-trip-2026' to 'bali-trip'/);
  const after = active(repo);
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
  assert.equal(active(repo).length, 2, 'a refused undo must not touch the stores');

  // A session that never mutated anything has nothing of its own to revert.
  const stranger = gtg(repo, ['undo'], { session: 'sess-C' });
  assert.equal(stranger.status, 2, 'undo must refuse a session with no change of its own');
  assert.match(stranger.stderr, /no change from this session to undo/);
  assert.equal(active(repo).length, 2, 'a refused undo must not touch the stores');

  // No session identity at all: refuse rather than revert a stranger's commit.
  const anon = gtg(repo, ['undo'], { session: null });
  assert.equal(anon.status, 2, 'undo must refuse without a session id');
  assert.match(anon.stderr, /no session id/);
  assert.equal(active(repo).length, 2, 'a refused undo must not touch the stores');

  // B owns the tip, so B's undo is the one that goes through.
  const ownB = gtg(repo, ['undo'], { session: 'sess-B' });
  assert.equal(ownB.status, 0, ownB.stderr);
  const slugs = active(repo).map((e) => e.slug);
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
  assert.deepEqual(active(repo).map((e) => e.slug), ['parent-proj'], 'entry not removed');

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
  patchActive(repo, (h) => { h[0].updated = new Date(Date.now() - 9 * 86400000).toISOString(); });
  const r = gtg(repo, ['list']);
  assert.equal(r.status, 0, r.stderr);
  const bl = backlog(repo);
  assert.ok(bl.some((e) => e.slug === 'issues-p9-x'),
    'an idle extension entry was not auto-shelved, so filtering happened before autoShelf');
  assert.equal(active(repo).length, 0, 'the shelved entry is gone from active');
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
  patchActive(repo, (h) => { for (const e of h) e.updated = new Date(Date.now() - 9 * 86400000).toISOString(); });
  gtg(repo, ['list']);
  const bl = backlog(repo);
  assert.equal(bl.length, 2, 'setup: both entries must be on the shelf');            // GUARD
  assert.equal(active(repo).length, 0, 'setup: nothing left active');       // GUARD

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

// --- 53. the two stores partition: one slug never sits in both ---
// writeHandoff used to dedupe against only the store it was writing, so a handoff for a
// shelved slug appended an active entry and left the backlog copy behind. The two stores
// drive different renderers, so the same project then read as active or shelved depending on
// which command ran. Both directions, because `backlog` writes through the same function.
{
  const repo = tempRepo();
  const backlogOf = (r) => backlog(r);
  const slugs = (xs) => (xs ?? []).map((e) => e.slug);

  gtg(repo, ['backlog', '--project', 'Thing', '--slug', 'thing', '--next', 'TBD'], { input: BODY });
  gtg(repo, HANDOFF_ARGS('thing', 'Thing'), { input: BODY });
  assert.deepEqual(slugs(active(repo)), ['thing'], 'handoff did not unpark the shelved slug');
  assert.deepEqual(slugs(backlogOf(repo)), [], 'the backlog copy survived a handoff for the same slug');

  gtg(repo, ['backlog', '--project', 'Thing', '--slug', 'thing', '--next', 'TBD'], { input: BODY });
  assert.deepEqual(slugs(backlogOf(repo)), ['thing'], 'parking did not land on the backlog');
  assert.deepEqual(slugs(active(repo)), [], 'the active copy survived a park of the same slug');

  const st = execSync('git status --porcelain', { cwd: repo, encoding: 'utf8' });
  assert.equal(st.trim(), '', `the unpark left the tree dirty:\n${st}`);
  console.log('ok 53 - a slug lives in exactly one store, both directions, and the unpark is committed');
}

// --- 54-57. unparent clears a parent, which rename cannot express ---
// rename's <new> is held to /^[A-Za-z0-9_-]+$/, so it can only re-POINT a parent. Re-pointing a
// dangling parent at the entry's own slug just trades it for a self-parent, the same defect.
{
  const dir = tempRepo();
  gtg(dir, ['handoff', '--project', 'Alpha', '--slug', 'alpha', '--next', 'x',
    '--parent', 'ghost'], { input: 'body\n' });
  // Bookkeeping is not work, so the idle clock `list` auto-shelves on must not restart.
  // Backdated first, the way the auto-shelf tests do it, and captured BEFORE the unparent:
  // reading `updated` afterwards can only catch a deletion, and nowIso() is second-
  // granularity, so a stamp taken "now" would compare equal to a restamp in the same second.
  const before = new Date(Date.now() - 2 * 86400000).toISOString();
  patchActive(dir, (h) => { h[0].updated = before; });
  const cleared = gtg(dir, ['unparent', 'alpha']);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.match(cleared.stdout, /Cleared parent 'ghost' from Alpha/);
  const entry = active(dir).find((e) => e.slug === 'alpha');
  // Deleted, not nulled: absent has ONE representation, which is what every reader
  // already branches on.
  assert.equal('parent' in entry, false);
  assert.equal(entry.updated, before, 'updated must not be restamped');
  console.log('ok 54 - unparent deletes the parent key and leaves updated alone');
}

{
  const dir = tempRepo();
  gtg(dir, ['handoff', '--project', 'Solo', '--slug', 'solo', '--next', 'x'],
    { input: 'body\n' });
  const twice = gtg(dir, ['unparent', 'solo']);
  assert.equal(twice.status, 2);
  assert.match(twice.stderr, /'solo' has no parent/);
  console.log('ok 55 - an entry with no parent is refused, not silently succeeded');
}

{
  const dir = tempRepo();
  const missing = gtg(dir, ['unparent', 'nope']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /No project matching 'nope'/);
  const noArg = gtg(dir, ['unparent']);
  assert.equal(noArg.status, 2);
  assert.match(noArg.stderr, /Usage: gtg unparent/);
  console.log('ok 56 - unparent rejects an unknown target and a missing argument');
}

{
  // A backlog entry resolves too, with active winning a collision the way rename does.
  const dir = tempRepo();
  gtg(dir, ['backlog', '--project', 'Shelved', '--slug', 'shelved', '--next', 'x',
    '--parent', 'ghost'], { input: 'body\n' });
  const out = gtg(dir, ['unparent', 'shelved']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal('parent' in backlog(dir).find((e) => e.slug === 'shelved'), false);
  console.log('ok 57 - unparent reaches a backlog entry too');
}

// --- 1.11.0: slug reuse in the CLI, --wip, after-handoff hook, harness ---
{
  // One name-matching entry lends its slug, so the skill needs no `list <name>` probe first.
  const dir = tempRepo();
  gtg(dir, HANDOFF_ARGS('alpha-project', 'Alpha Project'), { input: BODY });
  const r = gtg(dir, HANDOFF_ARGS('alpha', 'Alpha'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /slug: reusing alpha-project/);
  const hs = active(dir);
  assert.equal(hs.length, 1, 'must update the existing entry, not mint a second');
  assert.equal(hs[0].slug, 'alpha-project');
  assert.equal(hs[0].sessions, 2);
  console.log('ok 58 - a fresh slug whose project name matches one entry reuses that slug');
}

{
  // --exact keeps the given slug (the `gtg [project]` override); two+ matches stay ambiguous.
  const dir = tempRepo();
  gtg(dir, HANDOFF_ARGS('alpha-one', 'Alpha One'), { input: BODY });
  const exact = gtg(dir, [...HANDOFF_ARGS('alpha', 'Alpha'), '--exact'], { input: BODY });
  assert.equal(exact.status, 0, exact.stderr);
  assert.doesNotMatch(exact.stdout, /slug: reusing/);
  assert.equal(active(dir).length, 2);
  gtg(dir, HANDOFF_ARGS('alpha-two', 'Alpha Two'), { input: BODY });
  const amb = gtg(dir, HANDOFF_ARGS('alpha-x', 'Alpha'), { input: BODY });
  assert.doesNotMatch(amb.stdout, /slug: reusing/);
  assert.equal(active(dir).length, 4, 'two name matches must not pick one');
  console.log('ok 59 - --exact and ambiguous matches keep the given slug');
}

{
  // --wip commits the worktree's uncommitted work in the same call; a clean tree is fine;
  // 'repo root' is never swept (a shared checkout).
  const hub = tempRepo();
  const wt = tempRepo();
  writeFileSync(join(wt, 'a.txt'), 'a\n');
  execSync('git add a.txt && git commit -q -m init', { cwd: wt });
  writeFileSync(join(wt, 'a.txt'), 'b\n');
  writeFileSync(join(wt, 'new.txt'), 'n\n');
  let r = gtg(hub, [...HANDOFF_ARGS('w', 'W'), '--worktree', wt, '--wip'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wip: committed/);
  assert.equal(execSync('git status --porcelain', { cwd: wt }).toString().trim(), '');
  assert.match(execSync('git log -1 --format=%s', { cwd: wt }).toString(), /wip: gtg checkpoint - W/);
  r = gtg(hub, [...HANDOFF_ARGS('w', 'W'), '--worktree', wt, '--wip'], { input: BODY });
  assert.equal(r.status, 0, 'a clean worktree is not an error');
  assert.doesNotMatch(r.stdout, /wip: committed/);
  writeFileSync(join(hub, 'stray.txt'), 'other session\n');
  r = gtg(hub, [...HANDOFF_ARGS('h', 'H'), '--wip'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.match(execSync('git status --porcelain', { cwd: hub }).toString(), /\?\? stray\.txt/,
    'repo root must never be swept by --wip');
  console.log('ok 60 - --wip checkpoints the worktree only');
}

{
  // after-handoff.mjs runs once the handoff is committed, sees the entry/body, and is skipped
  // for a backlog park. A throwing hook is reported (exit 1) without undoing the handoff.
  const dir = tempRepo();
  mkdirSync(join(dir, '.gtg'), { recursive: true });
  writeFileSync(join(dir, '.gtg', 'after-handoff.mjs'),
    `import { writeFileSync } from 'node:fs';
export default async (ctx) => {
  writeFileSync(ctx.root + '/hook-ran.json', JSON.stringify({ keys: Object.keys(ctx).sort(), slug: ctx.entry.slug, file: ctx.file, body: ctx.body }));
  console.log('hook says hi');
};\n`);
  let r = gtg(dir, HANDOFF_ARGS('hk', 'Hooked'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /hook says hi/);
  const ran = JSON.parse(readFileSync(join(dir, 'hook-ran.json'), 'utf8'));
  assert.deepEqual(ran.keys, ['body', 'commit', 'entry', 'file', 'readStore', 'root', 'worktree', 'writeStore']);
  assert.equal(ran.slug, 'hk');
  assert.match(ran.file, /docs\/handoffs\/.*-hk\.md$/);
  assert.equal(ran.body, BODY.trim());
  assert.ok(r.stdout.trim().endsWith('RESUME: "gtg hk"'), 'RESUME stays the last line');
  execSync('git rm -q --cached hook-ran.json 2>/dev/null || true', { cwd: dir });
  execSync('rm -f hook-ran.json', { cwd: dir });
  gtg(dir, ['backlog', '--project', 'Idea', '--slug', 'idea', '--next', 'x'], { input: 'body\n' });
  assert.equal(existsSync(join(dir, 'hook-ran.json')), false, 'hook must not fire on a backlog park');
  writeFileSync(join(dir, '.gtg', 'after-handoff.mjs'), `export default () => { throw new Error('boom'); };\n`);
  r = gtg(dir, HANDOFF_ARGS('hk2', 'Hooked Two'), { input: BODY });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /after-handoff hook failed - boom/);
  assert.ok(active(dir).some((e) => e.slug === 'hk2'), 'handoff survives a failing hook');
  assert.match(execSync('git log -1 --format=%s', { cwd: dir }).toString(), /^handoff: Hooked Two/);
  console.log('ok 61 - after-handoff hook: ctx, handoff-only, failure reported not hidden');
}

{
  // Which harness wrote it: detected from the env, --harness overrides, shown on the list row.
  const dir = tempRepo();
  let r = gtg(dir, HANDOFF_ARGS('c', 'Claude Side'), { input: BODY, env: { CLAUDECODE: '1' } });
  assert.equal(active(dir)[0].harness, 'claude');
  r = gtg(dir, HANDOFF_ARGS('x', 'Codex Side'), { input: BODY, env: { CLAUDECODE: '', CODEX_HOME: 'C:/x' } });
  assert.equal(active(dir).find((e) => e.slug === 'x').harness, 'codex');
  r = gtg(dir, [...HANDOFF_ARGS('o', 'Other'), '--harness', 'hermes'], { input: BODY, env: { CLAUDECODE: '1' } });
  assert.equal(active(dir).find((e) => e.slug === 'o').harness, 'hermes');
  const list = gtg(dir, ['list']).stdout;
  assert.match(list, /Claude Side s1 \[~2h\] \([^)]*\) ·claude/);
  assert.match(list, /Codex Side s1 \[~2h\] \([^)]*\) ·codex/);
  assert.match(list, /Other s1 \[~2h\] \([^)]*\) ·hermes/);
  // An unidentified caller leaves the field off rather than guessing.
  r = gtg(dir, HANDOFF_ARGS('u', 'Unknown'), { input: BODY, env: { CLAUDECODE: '' } });
  const u = active(dir).find((e) => e.slug === 'u');
  assert.equal('harness' in u && u.harness !== undefined, false);
  assert.doesNotMatch(gtg(dir, ['list']).stdout, /Unknown s1 \[~2h\] \([^)]*\) ·/);
  console.log('ok 62 - harness recorded from env or --harness and shown on the row');
}

// --- 2.0.0: --next from the body, worktree from cwd, git + task sections the CLI appends ---
{
  const dir = tempRepo();
  const body = '## Where We Stopped\npara\n\n## Next Action\nShip the thing.\nsecond line ignored\n';
  let r = gtg(dir, ['handoff', '--project', 'Derived', '--slug', 'derived'], { input: body });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(active(dir)[0].next, 'Ship the thing.');
  r = gtg(dir, ['handoff', '--project', 'NoNext', '--slug', 'nonext'], { input: '## Where We Stopped\nx\n' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /missing --next \(or a ## Next Action section in the body\)/);
  console.log('ok 63 - --next is read from the body; a body with neither is refused');
}

// --- 63b. a blank line after the heading is still a section ---
// sectionOf's lookahead used to end on a bare `$` under the `m` flag, where `$` matches at every
// line end, so a lazy capture starting at a blank line matched EMPTY. The section then read as
// absent: the handoff below was refused for "missing --next" with its Next Action right there
// (it bit a real departure on 2026-09-02, worked around by passing --next by hand), and a Task
// list the caller wrote itself was read as missing and a second one appended underneath it.
{
  const dir = tempRepo();
  const body = '## Where We Stopped\n\npara\n\n## Next Action\n\nShip the thing.\n\n## Task list\n\n- [x] mine\n';
  const r = gtg(dir, ['handoff', '--project', 'Blank Lines', '--slug', 'blanks'], { input: body });
  assert.equal(r.status, 0, `a well-formed body must not be refused for a blank line: ${r.stderr}`);
  assert.equal(active(dir)[0].next, 'Ship the thing.');
  const doc = readFileSync(join(dir, active(dir)[0].file), 'utf8');
  assert.equal(doc.match(/^## Task list$/gm)?.length, 1,
    'a Task list read as absent gets a second one appended under it');
  console.log('ok 63b - a section with a blank line after its heading is read, not seen as absent');
}

// --- 63c. a slug the store would refuse is refused BEFORE the markdown is written ---
// writeHandoff writes the .md to disk and only then saves the entry, so its no-orphan-file
// guarantee holds only while nothing after that write can still refuse. `--slug _foo` passed the
// CLI's looser [A-Za-z0-9_-]+ and then threw inside writeCollection, whose SLUG_OK demands an
// alphanumeric first character: an untracked .md left in docs/handoffs, no entry anywhere, and
// the body - which came from stdin - simply gone. Same hazard Task 6 closed on the projects side.
{
  const dir = tempRepo();
  const r = gtg(dir, ['handoff', '--project', 'Bad Slug', '--slug', '_foo', '--next', 'x'], { input: BODY });
  assert.equal(r.status, 2, `a leading underscore must be refused, got: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /--slug must start with a letter or digit/);
  assert.equal(existsSync(join(dir, 'docs/handoffs')), false,
    'refused BEFORE any write: nothing may be left on disk for the user to find and clean up');
  assert.deepEqual(active(dir), []);
  console.log('ok 63c - a slug the store would refuse is refused before the handoff file is written');
}

{
  // Run from a worktree: worktree + branch inferred, commits and files since the session
  // start appended. Run from the hub: 'repo root', no git sections (a shared checkout).
  const hub = tempRepo();
  const wt = tempRepo();
  writeFileSync(join(wt, 'a.txt'), 'a\n');
  execSync('git add a.txt && git commit -q -m "feat: first"', { cwd: wt });
  writeFileSync(join(wt, 'b.txt'), 'b\n');
  let r = gtg(wt, [...HANDOFF_ARGS('inf', 'Inferred'), '--wip'], { input: BODY, hub });
  assert.equal(r.status, 0, r.stderr);
  const e = active(hub)[0];
  const norm = (s) => s.toLowerCase().split(String.fromCharCode(92)).join("/");
  assert.equal(norm(e.worktree), norm(wt));
  assert.equal(e.branch, 'main');
  const doc = readFileSync(join(hub, e.file), 'utf8');
  assert.match(doc, /## Commits this session\n- [0-9a-f]+ wip: gtg checkpoint - Inferred\n- [0-9a-f]+ feat: first/);
  assert.match(doc, /## Files touched\n- a\.txt\n- b\.txt/);
  r = gtg(hub, HANDOFF_ARGS('root', 'Root Project'), { input: BODY, hub });
  const e2 = active(hub).find((x) => x.slug === 'root');
  assert.equal(e2.worktree, 'repo root');
  assert.doesNotMatch(readFileSync(join(hub, e2.file), 'utf8'), /## Commits this session/);
  console.log('ok 64 - worktree inferred from cwd; commits + files appended for a worktree only');
}

{
  // Task list read from the harness store; a body that carries its own is left alone.
  const dir = tempRepo();
  const cfg = mkdtempSync(join(tmpdir(), 'gtg-cfg-'));
  mkdirSync(join(cfg, 'tasks', 'sess-1'), { recursive: true });
  writeFileSync(join(cfg, 'tasks', 'sess-1', '2.json'), JSON.stringify({ id: '2', subject: 'Second', status: 'in_progress' }));
  writeFileSync(join(cfg, 'tasks', 'sess-1', '1.json'), JSON.stringify({ id: '1', subject: 'First', status: 'completed' }));
  writeFileSync(join(cfg, 'tasks', 'sess-1', '.lock'), '');
  const env = { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: 'sess-1' };
  let r = gtg(dir, HANDOFF_ARGS('t', 'Tasked'), { input: BODY, env });
  assert.equal(r.status, 0, r.stderr);
  let doc = readFileSync(join(dir, active(dir)[0].file), 'utf8');
  assert.match(doc, /## Task list\n- \[completed\] First\n- \[in_progress\] Second\n/);
  r = gtg(dir, HANDOFF_ARGS('t2', 'Own List'), { input: BODY + '\n## Task list\n- [pending] mine\n', env });
  doc = readFileSync(join(dir, active(dir).find((x) => x.slug === 't2').file), 'utf8');
  assert.equal((doc.match(/## Task list/g) || []).length, 1);
  assert.match(doc, /- \[pending\] mine/);
  r = gtg(dir, HANDOFF_ARGS('t3', 'No Session'), { input: BODY, env: { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: 'nope' } });
  assert.doesNotMatch(readFileSync(join(dir, active(dir).find((x) => x.slug === 't3').file), 'utf8'), /## Task list/);
  console.log('ok 65 - task list appended from the harness store, never duplicated, absent when unknown');
}

// --- 3.0.0: resume is the whole pick-up in one call ---
{
  // Prints the handoff, consumes, keeps the commit subject; --keep reads without consuming.
  const dir = tempRepo();
  gtg(dir, HANDOFF_ARGS('one', 'Only One'), { input: BODY });
  let r = gtg(dir, ['resume', 'one', '--keep']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^RESUME: "Only One" - handoff of \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(docs\/handoffs\/.*-one\.md\)\n# Handoff: Only One\n/);
  assert.match(r.stdout, /## Next Action\ndo the next thing/);
  assert.match(r.stdout, /Kept: Only One \(not consumed\)/);
  assert.equal(active(dir).length, 1, '--keep must not consume');
  // Bare resume with exactly one active project picks it without a name.
  r = gtg(dir, ['resume']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RESUME: "Only One"/);
  assert.match(r.stdout, /Consumed: Only One$/m);
  assert.equal(active(dir).length, 0);
  assert.match(execSync('git log -1 --format=%s', { cwd: dir }).toString(), /^gtg resume: Only One - handoff consumed/);
  r = gtg(dir, ['resume']);
  assert.equal(r.status, 2, 'nothing to resume exits 2');
  assert.match(r.stdout, /Nothing to resume/);
  console.log('ok 66 - resume prints the handoff and consumes in one call; --keep reads only');
}

{
  // Several candidates are a question (exit 1 + list), never a guess: bare with 2+, a name
  // fragment fitting 2+, or a project sharing its token with a command.
  const dir = tempRepo();
  gtg(dir, HANDOFF_ARGS('alpha-one', 'Alpha One'), { input: BODY });
  gtg(dir, HANDOFF_ARGS('alpha-two', 'Alpha Two'), { input: BODY });
  let r = gtg(dir, ['resume']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Alpha One[\s\S]*Alpha Two[\s\S]*Which\? gtg <project>/);
  r = gtg(dir, ['resume', 'alpha']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /'alpha' matches 2 active projects:\n  1\. Alpha One \(alpha-one\)/);
  assert.equal(active(dir).length, 2, 'ambiguity must not consume');
  r = gtg(dir, ['resume', 'alpha-two']);
  assert.equal(r.status, 0, 'an exact slug is never ambiguous');
  gtg(dir, HANDOFF_ARGS('issues', 'Issues Triage'), { input: BODY });
  r = gtg(dir, ['resume', 'issues']);
  assert.equal(r.status, 1, 'project + bundled command of the same name must ask');
  assert.match(r.stdout, /'issues' is both a project and a command:\n  1\. Issues Triage \(issues\)[\s\S]*2\. run the `issues` command/);
  r = gtg(dir, ['resume', 'stats']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /'stats' is a command - run gtg stats/);
  console.log('ok 67 - resume asks on ambiguity and on a project/command collision');
}

{
  // after-resume.mjs runs after the consume with the entry and body; a throwing hook is
  // reported without undoing the consume.
  const dir = tempRepo();
  mkdirSync(join(dir, '.gtg'), { recursive: true });
  writeFileSync(join(dir, '.gtg', 'after-resume.mjs'),
    `import { writeFileSync } from 'node:fs';
export default async (ctx) => { writeFileSync(ctx.root + '/resumed.json', JSON.stringify({ keys: Object.keys(ctx).sort(), slug: ctx.entry.slug, kept: ctx.kept, hasBody: ctx.body.includes('## Next Action') })); console.log('resume hook ran'); };\n`);
  gtg(dir, HANDOFF_ARGS('hk', 'Hooked'), { input: BODY });
  let r = gtg(dir, ['resume', 'hk']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Consumed: Hooked\nresume hook ran/);
  const ran = JSON.parse(readFileSync(join(dir, 'resumed.json'), 'utf8'));
  assert.deepEqual(ran.keys, ['body', 'commit', 'entry', 'file', 'kept', 'readStore', 'root', 'writeStore']);
  assert.deepEqual([ran.slug, ran.kept, ran.hasBody], ['hk', false, true]);
  writeFileSync(join(dir, '.gtg', 'after-resume.mjs'), `export default () => { throw new Error('kaboom'); };\n`);
  gtg(dir, HANDOFF_ARGS('hk2', 'Hooked Two'), { input: BODY });
  r = gtg(dir, ['resume', 'hk2']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /after-resume hook failed - kaboom/);
  assert.equal(active(dir).length, 0, 'consume survives a failing hook');
  console.log('ok 68 - after-resume hook: ctx, runs after consume, failure reported not hidden');
}

// --- 69. unrelated project edits on two machines produce disjoint file sets ---
// The whole reason the store was sharded. store.test.mjs already pins this at the
// writeCollection level; what it cannot see is whether a real handoff through the CLI still
// rewrites only its own record. If it names a second project's file, two machines editing
// unrelated projects still collide on bytes neither of them meant to touch, and a JSON array
// conflict has no semantic merge.
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('alpha', 'Alpha'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('beta', 'Beta'), { input: BODY });

  const obelisk = gtg(repo, [...HANDOFF_ARGS('alpha', 'Alpha'), '--next', 'from obelisk'], { input: BODY });
  assert.equal(obelisk.status, 0, obelisk.stderr);
  const aFiles = nameStatus(repo, 'HEAD');
  const reborn = gtg(repo, [...HANDOFF_ARGS('beta', 'Beta'), '--next', 'from reborn'], { input: BODY });
  assert.equal(reborn.status, 0, reborn.stderr);
  const bFiles = nameStatus(repo, 'HEAD');

  const records = (lines) => lines.map((l) => l.split('\t')[1])
    .filter((f) => f.startsWith(`${ACTIVE[0]}/`)).sort();
  assert.deepEqual(records(aFiles), [`${ACTIVE[0]}/alpha.json`],
    `Alpha's handoff must rewrite Alpha's record and no other, got: ${aFiles.join(' | ')}`);
  assert.deepEqual(records(bFiles), [`${ACTIVE[0]}/beta.json`],
    `Beta's handoff must rewrite Beta's record and no other, got: ${bFiles.join(' | ')}`);
  assert.equal(records(aFiles).some((f) => records(bFiles).includes(f)), false,
    'the two projects still share a record file, so the two machines still conflict');
  console.log('ok 69 - unrelated project edits touch disjoint record files');
}

// --- 70. a park commits both the created and the deleted record file by name ---
// commit() names its paths on `git add` AND `git commit`. A move between the two stores is
// now a delete plus a create in different directories, and the delete is the half that goes
// missing: unnamed, it stays in the working tree for whichever session commits next, which is
// exactly the ownerless-staged-file class the pathspec rule exists to stop.
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('alpha', 'Alpha'), { input: BODY });
  const r = gtg(repo, ['back', 'alpha', '--no-list']);
  assert.equal(r.status, 0, r.stderr);

  const files = nameStatus(repo, 'HEAD');
  assert.ok(files.includes(`D\t${ACTIVE[0]}/alpha.json`),
    `the deletion must be in the commit, got: ${files.join(' | ')}`);
  assert.ok(files.includes(`A\t${BACKLOG[0]}/alpha.json`),
    `the creation must be in the commit, got: ${files.join(' | ')}`);
  const st = execSync('git status --porcelain', { cwd: repo, encoding: 'utf8' });
  assert.equal(st.trim(), '',
    `nothing may be left staged or dirty for another session to commit:\n${st}`);
  console.log('ok 70 - a park commits both the created and the deleted record file');
}

// --- 71. report and stats read the SHARDED store ---
// The silent one. history.mjs used to read records through ctx.readStore, a whole-file JSON
// reader, and `readStore('docs/handoffs/_active.json')?.handoffs ?? []` degrades to [] with no
// error whatsoever once the records live one per file - so `report` and `stats` printed a
// clean, plausible, empty answer. This fixture has NO packed file at all, which is the state
// every hub created after the migration is in, and both expected counts are derived from the
// store rather than written down, so a reader that goes back through readStore reports zero
// against a non-zero store and fails here instead of lying.
{
  const repo = tempRepo();
  for (const [slug, project] of [['ra', 'R A'], ['rb', 'R B'], ['rc', 'R C']]) {
    const r = gtg(repo, HANDOFF_ARGS(slug, project), { input: BODY });
    assert.equal(r.status, 0, r.stderr);
  }
  gtg(repo, ['back', 'rc', '--no-list']);

  assert.ok(!existsSync(join(repo, ACTIVE[1])), 'setup: no packed active file may exist here');
  assert.ok(!existsSync(join(repo, BACKLOG[1])), 'setup: no packed backlog file may exist here');
  const nActive = active(repo).length;
  const nBacklog = backlog(repo).length;
  assert.equal(nActive, 2, 'setup: two records left active');   // GUARD
  assert.equal(nBacklog, 1, 'setup: one record parked');        // GUARD

  const rs = gtg(repo, ['stats']);
  assert.equal(rs.status, 0, rs.stderr);
  assert.match(rs.stdout, new RegExp(`^${nActive} active, ${nBacklog} backlog$`, 'm'),
    `stats must count the sharded store, got:\n${rs.stdout}`);

  const rr = gtg(repo, ['report']);
  assert.equal(rr.status, 0, rr.stderr);
  const doc = JSON.parse(readFileSync(join(repo, 'docs/handoffs/_report.json'), 'utf8'));
  assert.equal(doc.counts.active, nActive, 'report must count the sharded active store');
  assert.equal(doc.counts.backlog, nBacklog, 'report must count the sharded backlog store');
  assert.deepEqual(doc.perProject.map((pp) => pp.project).sort(), ['R A', 'R B', 'R C'],
    'every project must reach the report through the sharded store');
  console.log('ok 71 - report and stats read the sharded store with no packed file present');
}

// --- 72. readStore keeps its packed shape for the published extension ctx ---
// Case 6 pins that ctx.readStore EXISTS; this pins what it returns. Nothing bundled reads
// records through it since Task 4 - buildReport calls readCollection - so the contract now
// rests on no bundled caller at all, and a future edit could "simplify" readStore into
// returning a bare array with the whole suite still green. Third-party extensions in
// .gtg/commands/ are the real callers, and they index the wrapper key themselves, so
// `readStore('...')?.handoffs ?? []` over a bare array yields [] with no error whatsoever -
// exactly the silence that emptied `report` and `stats`, which case 71 caught from the other
// side. Case 71 is now indifferent to readStore's shape; this case is the only thing holding it.
{
  const repo = tempRepo();
  mkdirSync(join(repo, 'docs/handoffs'), { recursive: true });
  mkdirSync(join(repo, '.gtg/commands'), { recursive: true });
  // Packed on purpose: readStore is a whole-file JSON reader and this is the file a
  // third-party extension names. gtg shards it on startup and leaves it in place, so it
  // stays readable either way.
  writeFileSync(join(repo, ACTIVE[1]),
    JSON.stringify({ handoffs: [{ project: 'Shape', slug: 'shape', next: 'x' }] }, null, 2) + '\n');
  writeFileSync(join(repo, '.gtg/commands/shape.mjs'),
    `export default ({ readStore }) => {
      const s = readStore('docs/handoffs/_active.json');
      console.log(JSON.stringify({
        isArray: Array.isArray(s),
        wrapped: Array.isArray(s?.handoffs),
        slugs: (s?.handoffs ?? []).map((e) => e.slug),
      }));
    }\n`);

  const r = gtg(repo, ['shape']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.isArray, false,
    'readStore must NOT return a bare array - an extension indexing .handoffs on one gets undefined');
  assert.equal(out.wrapped, true,
    'readStore must return the packed wrapper object, so `readStore(rel)?.handoffs` resolves');
  assert.deepEqual(out.slugs, ['shape'], 'and the records inside it must be reachable');
  console.log('ok 72 - readStore keeps its packed shape on the published extension ctx');
}

// --- 73. resume fast-forwards from the mirror BEFORE it reads the store ---
// The sync's whole value is its POSITION. It first shipped in .gtg/after-resume.mjs, which runs
// after entries() has read, the handoff has printed and the consume has committed, so it could
// only ever succeed when there was nothing to pull (2026-09-01, docs/runbooks/git-parity.md).
// So this case pins the ordering rather than the call: the resumed record exists ONLY in the
// commit sitting on the mirror, which makes it resolvable if and only if the fetch already ran.
// A fetch anywhere after the read cannot make this pass, which is exactly the property wanted.
//
// A local bare repo stands in for Obelisk's Forgejo: same git, no network, no Tailscale.
{
  const mirror = mkdtempSync(join(tmpdir(), 'gtg-mirror-'));
  execSync('git init -q --bare -b master', { cwd: mirror });
  const url = mirror.split('\\').join('/');
  const fromMirror = (dir, sh) => execSync(sh, { cwd: dir, encoding: 'utf8' }).trim();

  // The hub, on master: the branch the sync fast-forwards, and the branch home actually sits on.
  const repo = tempRepo();
  execSync('git checkout -q -b master', { cwd: repo });
  assert.equal(gtg(repo, HANDOFF_ARGS('local-a', 'Local A'), { input: BODY }).status, 0);
  assert.equal(gtg(repo, HANDOFF_ARGS('local-c', 'Local C'), { input: BODY }).status, 0);
  execSync(`git remote add obelisk-backup "${url}"`, { cwd: repo });
  execSync('git push -q obelisk-backup master', { cwd: repo });
  // No -u, deliberately: this fixture is HOME's shape, where nothing sets branch.*.remote, so
  // the whole case runs down the fallback to the obelisk-backup/master pair. Case 74 covers the
  // upstream lookup that comes first. Asserted, not assumed - a push that quietly set an
  // upstream would move this case onto the other path and neither would be tested twice over.
  assert.throws(() => execSync('git config --get branch.master.remote', { cwd: repo, stdio: 'ignore' }),
    'fixture: master must have NO upstream here, or this stops testing the fallback');

  // The other machine: clone the mirror, wrap a project there, push. The hub has never seen it.
  const other = mkdtempSync(join(tmpdir(), 'gtg-other-'));
  execSync(`git clone -q "${url}" "${other.split('\\').join('/')}"`, { cwd: tmpdir() });
  execSync('git config user.email test@test', { cwd: other });
  execSync('git config user.name test', { cwd: other });
  assert.equal(gtg(other, HANDOFF_ARGS('remote-b', 'Remote B'), { input: BODY }).status, 0);
  execSync('git push -q origin master', { cwd: other });
  assert.ok(!active(repo).some((e) => e.slug === 'remote-b'),
    'fixture: the hub must not hold the record yet, or the case proves nothing');

  const r = gtg(repo, ['resume', 'remote-b']);
  assert.equal(r.status, 0,
    `resume could not see a record that exists only on the mirror - the fetch ran after the read, or not at all: ${r.stderr}`);
  assert.match(r.stdout, /RESUME: "Remote B"/);
  assert.match(r.stdout, /- stuff/, 'and the handoff BODY came down with it');
  assert.match(r.stdout, /fast-forward/i, 'a real fast-forward is the ONE case that speaks on stdout');

  // Up to date: silence. A line on every resume is noise, and noise is how a real one goes unread.
  const q = gtg(repo, ['resume', 'local-a']);
  assert.equal(q.status, 0, q.stderr);
  assert.doesNotMatch(q.stdout, /fast-forward/i, 'nothing to pull must say nothing');

  // Diverged: both sides hold commits the other lacks. --ff-only refuses, and refusing is the
  // point - auto-merging a divergence is what caused the 2026-08-02 fork. The resume still
  // runs, on local state, and the notice goes to stderr so stdout keeps its one rule.
  writeFileSync(join(repo, 'local.txt'), 'local only'); // no trailing LF: git's autocrlf warning is not test output
  execSync('git add local.txt', { cwd: repo });
  execSync('git commit -q -m "local only"', { cwd: repo });
  assert.equal(gtg(other, HANDOFF_ARGS('remote-d', 'Remote D'), { input: BODY }).status, 0);
  execSync('git push -q origin master', { cwd: other });
  const d = gtg(repo, ['resume', 'local-c']);
  assert.equal(d.status, 0, `a divergence must not fail the resume: ${d.stderr}`);
  assert.match(d.stdout, /RESUME: "Local C"/, 'and it resumes from local state');
  assert.doesNotMatch(d.stdout, /fast-forward/i, 'stdout stays silent when nothing moved');
  assert.match(d.stderr, /will not fast-forward/, 'but a real fork has to surface somewhere');
  assert.ok(!active(repo).some((e) => e.slug === 'remote-d'),
    'and nothing from the diverged mirror was merged in');
  assert.equal(fromMirror(repo, 'git rev-parse --abbrev-ref HEAD'), 'master',
    'no rebase, no detach: the branch is where it was');
  console.log('ok 73 - resume fast-forwards from the mirror before reading the store');
}

// --- 74. the sync target is the branch's own upstream, not a hardcoded pair ---
// Obelisk's shape is a CLONE: its remote is `origin`, its branch can be `main`, and neither
// half matches the obelisk-backup/master pair the first cut named. That made the sync
// one-directional - home pulled Obelisk's work, Obelisk's every resume fetched nothing and said
// nothing - and handing entries BOTH ways is the whole reason the store is git. So the target
// comes from branch.<b>.remote + branch.<b>.merge, and this case stands on the far side of the
// exchange: nothing named obelisk-backup exists anywhere in it.
{
  const mirror = mkdtempSync(join(tmpdir(), 'gtg-mirror2-'));
  execSync('git init -q --bare -b main', { cwd: mirror });
  const url = mirror.split('\\').join('/');
  const clone = (prefix) => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    execSync(`git clone -q "${url}" "${d.split('\\').join('/')}"`, { cwd: tmpdir() });
    execSync('git config user.email test@test', { cwd: d });
    execSync('git config user.name test', { cwd: d });
    return d;
  };

  // Seed the mirror so there is something to clone.
  const seed = tempRepo();
  assert.equal(gtg(seed, HANDOFF_ARGS('seed-a', 'Seed A'), { input: BODY }).status, 0);
  execSync(`git remote add origin "${url}"`, { cwd: seed });
  execSync('git push -q origin main', { cwd: seed });

  const obelisk = clone('gtg-obelisk-');
  assert.equal(execSync('git config --get branch.main.remote', { cwd: obelisk, encoding: 'utf8' }).trim(),
    'origin', 'fixture: a clone tracks origin, which is precisely what the hardcoded pair missed');
  assert.equal(execSync('git rev-parse --abbrev-ref HEAD', { cwd: obelisk, encoding: 'utf8' }).trim(),
    'main', 'fixture: and it is not on master either');
  assert.equal(execSync('git remote', { cwd: obelisk, encoding: 'utf8' }).trim(), 'origin',
    'fixture: no obelisk-backup remote exists here at all');

  // reborn wraps a project and pushes. Obelisk has never seen it.
  const reborn = clone('gtg-reborn-');
  assert.equal(gtg(reborn, HANDOFF_ARGS('from-reborn', 'From Reborn'), { input: BODY }).status, 0);
  execSync('git push -q origin main', { cwd: reborn });

  const r = gtg(obelisk, ['resume', 'from-reborn']);
  assert.equal(r.status, 0,
    `the far side of the exchange saw nothing - the target was not resolved from its upstream: ${r.stderr}`);
  assert.match(r.stdout, /RESUME: "From Reborn"/);
  assert.match(r.stdout, /Synced origin\/main: fast-forwarded/,
    'and it names the upstream it actually used, not the fallback pair');

  // A feature branch with no upstream: nothing to resolve, nothing to fall back to, so the sync
  // skips. This is the guard the old branch comparison held, now carried by the lookup itself.
  execSync('git checkout -q -b feat/y', { cwd: obelisk });
  assert.equal(gtg(reborn, HANDOFF_ARGS('later-work', 'Later Work'), { input: BODY }).status, 0);
  execSync('git push -q origin main', { cwd: reborn });
  const f = gtg(obelisk, ['resume', 'seed-a']);
  assert.equal(f.status, 0, f.stderr);
  assert.doesNotMatch(f.stdout, /fast-forward/i, 'a branch with no upstream must not be moved');
  assert.equal(f.stderr, '', 'and must not be narrated either');
  assert.ok(!active(obelisk).some((e) => e.slug === 'later-work'),
    'nothing was pulled onto the feature branch');
  console.log('ok 74 - the sync target comes from the branch upstream, with the named pair as fallback');
}

// --- 75. the self-migration runs AFTER the sync, so a still-packed tree cannot fork ---
// The migration is import-time code: it executes before dispatch, so before resumeConsume's own
// syncHub(). The order on the second machine's first command of this version was therefore
// migrate -> commit "gtg: shard ..." -> fetch -> --ff-only REFUSED, because by then both machines
// held their own shard commit over the same source records, and every cross-machine handoff after
// that needed a human to resolve a fork. On exactly the two-machine round trip this store change
// exists to make work.
//
// Pinned the way case 73 pins its ordering: the record being resumed exists ONLY in the mirror's
// packed file, so it is resolvable if and only if the fetch ran before the shard commit was made.
// A sync anywhere after the migration cannot make this pass.
{
  const packed = (items) => JSON.stringify({ handoffs: items }, null, 2) + '\n';
  const rec = (slug, project) => ({
    project, slug, next: 'do the thing', sessions: 1,
    created: '2026-09-01', updated: new Date().toISOString(), worktree: 'repo root',
  });

  const mirror = mkdtempSync(join(tmpdir(), 'gtg-mirror3-'));
  execSync('git init -q --bare -b master', { cwd: mirror });
  const url = mirror.split('\\').join('/');

  // The hub, still PACKED: no gtg of this version has ever run here, so there is no shard
  // directory and the migration below is genuinely pending.
  const repo = tempRepo();
  execSync('git checkout -q -b master', { cwd: repo });
  mkdirSync(join(repo, 'docs/handoffs'), { recursive: true });
  writeFileSync(join(repo, 'docs/handoffs/_active.json'), packed([rec('local-a', 'Local A')]));
  execSync('git add docs/handoffs/_active.json', { cwd: repo });
  execSync('git commit -q -m "packed store"', { cwd: repo });
  execSync(`git remote add obelisk-backup "${url}"`, { cwd: repo });
  execSync('git push -q obelisk-backup master', { cwd: repo });

  // The other machine parks a second project while still on the old, packed plugin.
  const other = mkdtempSync(join(tmpdir(), 'gtg-other3-'));
  execSync(`git clone -q "${url}" "${other.split('\\').join('/')}"`, { cwd: tmpdir() });
  execSync('git config user.email test@test', { cwd: other });
  execSync('git config user.name test', { cwd: other });
  writeFileSync(join(other, 'docs/handoffs/_active.json'),
    packed([rec('local-a', 'Local A'), rec('remote-b', 'Remote B')]));
  execSync('git commit -q -am "packed store: remote-b"', { cwd: other });
  execSync('git push -q origin master', { cwd: other });

  assert.equal(existsSync(join(repo, ACTIVE[0])), false,
    'fixture: the hub must still be unsharded, or there is no migration to order against');
  const r = gtg(repo, ['resume', 'remote-b']);
  assert.equal(r.status, 0,
    `the shard commit landed before the fetch, so the mirror could not fast-forward: ${r.stderr}`);
  assert.match(r.stdout, /RESUME: "Remote B"/);
  assert.doesNotMatch(r.stderr, /will not fast-forward/,
    'a divergence here means the migration committed ahead of the sync');
  assert.ok(existsSync(join(repo, ACTIVE[0])),
    'and the tree still got sharded - after the pull, over the merged records');
  console.log('ok 75 - the resume sync runs before the self-migration, so a packed tree cannot fork');
}

console.log('ALL PASS');
