// Self-check for .gtg/commands/issues.mjs. Run: node .gtg/commands/issues.test.mjs
// ponytail: no framework, no fixtures dir. A temp root plus a stubbed ctx is the
// whole harness. Reach for node:test only if this grows past a dozen cases.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import issues from '../skills/gtg/extensions/commands/issues.mjs';

const setup = (files, active = [], backlog = []) => {
  const root = mkdtempSync(join(tmpdir(), 'gtg-issues-'));
  mkdirSync(join(root, 'docs/issues'), { recursive: true });
  mkdirSync(join(root, 'docs/handoffs'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, 'docs/issues', name), body);
  }
  writeFileSync(join(root, 'docs/handoffs/_active.json'), JSON.stringify({ handoffs: active }));
  writeFileSync(join(root, 'docs/handoffs/_backlog.json'), JSON.stringify({ backlog }));
  return root;
};

// Captures stdout/stderr and the exitCode the command sets, then restores both.
// Restoring exitCode matters: a refusal test would otherwise fail the whole run.
// ⚠ Every `pack` case here MUST refuse or pass --dry-run. A pack that reaches the park
// spawns `process.argv[1]`, which under test is THIS FILE, so it re-runs the suite and
// spawns again, forever. Cover the park by hand, never from here.
const run = (root, args = []) => {
  const out = [];
  const [log, err] = [console.log, console.error];
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  const commits = [];
  const restore = () => { console.log = log; console.error = err; };
  try {
    issues({
      root,
      args,
      readStore: (rel) => {
        try { return JSON.parse(readFileSync(join(root, rel), 'utf8')); } catch { return null; }
      },
      writeStore: () => { throw new Error('writeStore must not be used'); },
      commit: (paths, msg) => commits.push({ paths, msg }),
      countHandoffFiles: () => 1,
    });
  } finally {
    restore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = 0;
  return { out: out.join('\n'), commits, code };
};

// `commits.length === 0` only proves ctx commit() was never called, and writeFileSync
// runs BEFORE it — so a write-then-fail passes that check. Byte-compare every issue
// file instead, which also catches one case contaminating the next.
const snapshot = (root) => Object.fromEntries(
  readdirSync(join(root, 'docs/issues')).map((f) => [f, readFileSync(join(root, 'docs/issues', f), 'utf8')]),
);
const assertUntouched = (root, before, label) => assert.deepEqual(snapshot(root), before, `wrote to disk: ${label}`);

const issue = (fields, title = 'A thing is broken') => `# ${title}\n\n${fields}\n\nBody text.\n`;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
const pkg = (over) => ({ parent: 'issues', next: 'Do the first thing', updated: iso(1), ...over });

const P1 = pkg({ project: 'Issues P1: hook false positives', slug: 'issues-p1-hooks' });
const P3 = pkg({ project: 'Issues P3: Obelisk housekeeping', slug: 'issues-p3-obelisk-housekeeping', updated: iso(6) });

// 1. A package lists its stamped members with effort, and rolls effort up by bucket.
{
  const root = setup({
    '2026-07-03-rtk-grep-flag-mangle.md': issue('**Area:** claude-stack · **Effort:** minutes · **Package:** p1'),
    '2026-07-25-model-guard-false-positive.md': issue('**Area:** claude-stack · **Effort:** hour · **Package:** p1'),
  }, [P1]);
  const { out } = run(root);
  assert.match(out, /Issues P1: hook false positives \[issues-p1-hooks\] \(active\)/);
  assert.match(out, /2 issues \(1× minutes, 1× hour\)/);
  assert.match(out, /• \[minutes\] rtk-grep-flag-mangle/);
  assert.match(out, /→ Do the first thing/);
}

// 2. A shelved package is found too, proving both stores are read, not just active.
{
  const root = setup({}, [], [P3]);
  const { out } = run(root);
  assert.match(out, /\[issues-p3-obelisk-housekeeping\] \(shelved 6d\)/);
}

// 3. A package with no stamped members says so instead of looking empty.
{
  const root = setup({}, [P1]);
  const { out } = run(root);
  assert.match(out, /\[issues-p1-hooks\] \(active\) — membership unstamped/);
}

// 4. An unstamped issue is loose, grouped by area, and a missing Area reads unfiled.
{
  const root = setup({
    '2026-07-06-memory-orphan-files.md': issue('**Area:** claude-stack · **Effort:** hour'),
    '2026-07-28-reborn-audit.md': issue('No field line here at all.'),
  });
  const { out } = run(root);
  assert.match(out, /Loose \(2\):/);
  assert.match(out, /claude-stack \(1\):\n\s+• \[hour\] memory-orphan-files/);
  assert.match(out, /unfiled \(1\):\n\s+• \[\?\] reborn-audit/);
}

// 5. Blocked members are flagged, and "none" counts as not blocked.
{
  const root = setup({
    '2026-07-25-sdd-review-tier.md': issue('**Area:** claude-stack · **Effort:** session · **Blocked on:** Nathan\'s call'),
    '2026-07-02-dangling-volumes.md': issue('**Area:** obelisk · **Effort:** hour · **Blocked on:** none'),
  });
  const { out } = run(root);
  assert.match(out, /• \[session\] sdd-review-tier — BLOCKED: Nathan's call/);
  assert.doesNotMatch(out, /dangling-volumes — BLOCKED/);
  assert.match(out, /· 1 blocked/);
}

// 6. A Package naming no entry is reported stale rather than silently dropped.
{
  const root = setup({
    '2026-07-03-orphaned.md': issue('**Area:** misc · **Effort:** minutes · **Package:** p6'),
  }, [P1]);
  const { out } = run(root);
  assert.match(out, /1 stale package ref \(p6\)/);
}

// 7. `packages` prints packages and their next actions, and no member lines.
{
  const root = setup({
    '2026-07-03-rtk-grep-flag-mangle.md': issue('**Area:** claude-stack · **Effort:** minutes · **Package:** p1'),
  }, [P1]);
  const { out } = run(root, ['packages']);
  assert.match(out, /\[issues-p1-hooks\]/);
  assert.match(out, /→ Do the first thing/);
  assert.doesNotMatch(out, /rtk-grep-flag-mangle/);
}

// 16. A worked-around member is flagged with its workaround, and counted.
{
  const root = setup({
    '2026-07-25-model-guard-fp.md': issue(
      '**Area:** claude-stack · **Effort:** hour · **Package:** p1\n'
      + '**Check:** dispatch general-purpose at sonnet with "delete" in the prompt\n'
      + '**Status:** worked-around (dispatch as Plan instead)',
    ),
  }, [P1]);
  const { out } = run(root);
  assert.match(out, /• \[hour\] model-guard-fp — WORKED-AROUND: dispatch as Plan instead/);
  assert.match(out, /1 worked-around/);
  assert.doesNotMatch(out, /model-guard-fp.*\(no Check\)/);
}

// 17. An issue with no Check says so on its line and in the totals.
{
  const root = setup({
    '2026-07-03-no-check-here.md': issue('**Area:** misc · **Effort:** minutes'),
  });
  const { out } = run(root);
  assert.match(out, /• \[minutes\] no-check-here \(no Check\)/);
  assert.match(out, /1 no Check/);
}

// 18. A Check present and Status absent produces no flags at all.
{
  const root = setup({
    '2026-07-03-clean-one.md': issue('**Area:** misc · **Effort:** minutes\n**Check:** run the thing'),
  });
  const { out } = run(root);
  assert.match(out, /• \[minutes\] clean-one$/m);
  assert.match(out, /0 worked-around · 0 no Check/);
}

// 8. An exact pN hands control back to the skill, as the only output line.
{
  const root = setup({}, [P1]);
  const { out } = run(root, ['p1']);
  assert.equal(out, 'GTG-DIRECTIVE: resume issues-p1-hooks — read references/resume.md and follow it.');
}

// 9. A full slug and a substring of the project name both resolve, and like case 8 the
// directive is the SOLE output — gtg's router only acts on a directive it sees first.
{
  const root = setup({}, [P1], [P3]);
  const only = 'GTG-DIRECTIVE: resume issues-p3-obelisk-housekeeping — read references/resume.md and follow it.';
  assert.equal(run(root, ['issues-p3-obelisk-housekeeping']).out, only);
  assert.equal(run(root, ['housekeeping']).out, only);
}

// 10. Ambiguous and unknown arguments name the candidates and emit NO directive.
{
  const root = setup({}, [P1], [P3]);
  const many = run(root, ['issues']);
  assert.doesNotMatch(many.out, /GTG-DIRECTIVE/);
  assert.match(many.out, /matches 2 packages/);
  assert.match(many.out, /issues-p1-hooks/);
  const none = run(root, ['p9']);
  assert.doesNotMatch(none.out, /GTG-DIRECTIVE/);
  assert.match(none.out, /No issue package matches "p9"/);
}

const LOOSE = {
  '2026-07-03-rtk-grep-flag-mangle.md': issue('**Area:** claude-stack · **Effort:** minutes'),
  '2026-07-28-reborn-audit.md': issue('No field line here at all.'),
  '2026-07-02-dangling-volumes.md': issue('**Area:** obelisk · **Effort:** hour · **Package:** p1'),
};

// 11. Bare `pack` hands back a directive to propose batches, as the FIRST line, then
// lists the loose issues under it. First-line matters: gtg acts on the directive only
// when it leads the output, otherwise it relays the text and does nothing.
{
  const root = setup(LOOSE, [P1]);
  const { out, commits } = run(root, ['pack']);
  assert.match(out, /^GTG-DIRECTIVE: propose themed batches from the loose issues below/);
  assert.match(out, /gtg issues pack <pN> --name/);
  assert.match(out, /Loose \(2\):/);
  assert.equal(commits.length, 0);
}

// 12. Every refusal reports and writes NOTHING. One case per validation rule.
{
  const root = setup(LOOSE, [P1]);
  const before = snapshot(root);
  const cases = [
    [['pack', 'p1', '--name', 'Dupe', '--next', 'x', 'rtk-grep-flag-mangle'], /p1 already exists/],
    [['pack', 'nine', '--name', 'Bad', '--next', 'x', 'rtk-grep-flag-mangle'], /must be a package number/],
    [['pack', 'p9', '--next', 'x', 'rtk-grep-flag-mangle'], /missing --name/],
    [['pack', 'p9', '--name', 'No next', 'rtk-grep-flag-mangle'], /missing --next/],
    [['pack', 'p9', '--name', 'Empty', '--next', 'x'], /name at least one issue slug/],
    [['pack', 'p9', '--name', 'Ghost', '--next', 'x', 'no-such-issue'], /"no-such-issue" matches no issue file/],
    [['pack', 'p9', '--name', 'Vague', '--next', 'x', 'a'], /matches 3 issues/],
    [['pack', 'p9', '--name', 'Taken', '--next', 'x', 'dangling-volumes'], /already belongs to p1/],
  ];
  for (const [args, expected] of cases) {
    const { out, commits, code } = run(root, args);
    assert.match(out, expected);
    assert.match(out, /refused, nothing written/);
    assert.equal(commits.length, 0, `wrote something for ${args.join(' ')}`);
    assert.equal(code, 1);
    // Per iteration, not once at the end: every fixture file must still be byte-identical
    // before the next case runs against the same root.
    assertUntouched(root, before, args.join(' '));
  }
}

// 13. Dry run stamps nothing, and shows the field line for both file shapes.
{
  const root = setup(LOOSE, [P1]);
  const before = snapshot(root);
  const { out, commits } = run(root, [
    'pack', 'p9', '--name', 'Issues P9: DNS flakiness', '--next', 'Reproduce the timeout',
    '--dry-run', 'rtk-grep-flag-mangle', 'reborn-audit',
  ]);
  assert.match(out, /DRY RUN/);
  assert.match(out, /\*\*Area:\*\* claude-stack · \*\*Effort:\*\* minutes · \*\*Package:\*\* p9/);
  assert.match(out, /reborn-audit\.md: \*\*Package:\*\* p9/);
  assert.match(out, /--slug issues-p9-dns-flakiness/);
  assert.match(out, /--parent issues/);
  assert.equal(commits.length, 0);
  assertUntouched(root, before, 'dry run');
}

// 14. The theme slug drops the "Issues P9:" prefix and survives punctuation.
{
  const root = setup(LOOSE, [P1]);
  const { out } = run(root, [
    'pack', 'p9', '--name', "Nathan's DNS + proxy mess!", '--next', 'x', '--dry-run', 'rtk-grep-flag-mangle',
  ]);
  assert.match(out, /--slug issues-p9-nathan-s-dns-proxy-mess\b/);
}

// 15. Re-running a pack whose files were stamped but whose entry never parked is
// idempotent: there is nothing left to stamp, and it is NOT refused, so the real run
// would go on to retry the park. (This case stops at --dry-run, which returns before
// the spawn, so the park itself is out of reach here.) This is the partial-failure
// recovery path, the only way a member can already carry the pN being packed — a
// resolving pN is refused outright by case 12.
{
  const root = setup({
    '2026-07-03-half-packed.md': issue('**Area:** misc · **Effort:** minutes · **Package:** p9'),
  }, [P1]);
  const before = snapshot(root);
  const { out, commits } = run(root, [
    'pack', 'p9', '--name', 'Issues P9: DNS flakiness', '--next', 'Reproduce the timeout',
    '--dry-run', 'half-packed',
  ]);
  assert.match(out, /would stamp 0 file\(s\)/);
  assert.match(out, /--slug issues-p9-dns-flakiness/);
  assert.doesNotMatch(out, /refused/);
  assert.equal(commits.length, 0);
  assertUntouched(root, before, 'idempotent re-run');
}

// 19. The flag reader refuses what it cannot read rather than guessing. Every one of
// these silently packed the WRONG batch for real before: `--name --dry-run` swallowed
// the boolean (so a dry run committed), a `--dryrun` typo ate the slug behind it, and a
// bare `--` dropped a slug from the batch with no error at all.
{
  const root = setup(LOOSE, [P1]);
  const before = snapshot(root);
  const cases = [
    [['pack', 'p9', '--name', '--dry-run', '--next', 'x', 'rtk-grep-flag-mangle'], /--name needs a value/],
    [['pack', 'p9', '--name', 'Typo', '--next', 'x', '--dryrun', 'rtk-grep-flag-mangle'], /unknown flag "--dryrun"/],
    [['pack', 'p9', '--name', 'Sep', '--next', 'x', '--', 'rtk-grep-flag-mangle'], /unknown flag "--"/],
    [['pack', 'p9', '--name', 'Trailing', '--next'], /--next needs a value/],
  ];
  for (const [args, expected] of cases) {
    const { out, commits, code } = run(root, args);
    assert.match(out, expected);
    assert.match(out, /refused, nothing written/);
    assert.equal(commits.length, 0, `wrote something for ${args.join(' ')}`);
    assert.equal(code, 1);
    assertUntouched(root, before, args.join(' '));
  }
}

// 20. A punctuation-only --name is refused. gtg.mjs's own --slug check would ACCEPT the
// `issues-p9-` this themes to, so this is the only guard on a nameless entry.
{
  const root = setup(LOOSE, [P1]);
  const before = snapshot(root);
  const { out, code } = run(root, ['pack', 'p9', '--name', '!!!', '--next', 'x', 'rtk-grep-flag-mangle']);
  assert.match(out, /has no letters or digits to build a slug from/);
  assert.match(out, /refused, nothing written/);
  assert.equal(code, 1);
  assertUntouched(root, before, 'punctuation-only --name');
}

// 21. Two shapes that used to corrupt the write: a bold label in the BODY is not a field
// line (the stamp opens a real one under the title instead of appending inside a fenced
// block), and two queries resolving to the same file count as one issue, not two.
{
  const root = setup({
    ...LOOSE,
    '2026-07-29-bold-in-body.md': '# A thing is broken\n\nNo field line here at all.\n\n```\n    **Effort:** an example inside a fence\n```\n',
  }, [P1]);
  const before = snapshot(root);
  const bold = run(root, ['pack', 'p9', '--name', 'Bold body', '--next', 'x', '--dry-run', 'bold-in-body']);
  assert.match(bold.out, /bold-in-body\.md: \*\*Package:\*\* p9$/m);
  assert.doesNotMatch(bold.out, /an example inside a fence · \*\*Package:\*\*/);

  const dupe = run(root, ['pack', 'p9', '--name', 'Dupe args', '--next', 'x', '--dry-run', 'rtk-grep', 'rtk-grep-flag-mangle']);
  assert.match(dupe.out, /would stamp 1 file\(s\)/);
  assert.match(dupe.out, /\(1 issue\)/);
  assertUntouched(root, before, 'dry runs in case 21');
}

// 22. Free-text Effort buckets on its LEADING keyword, so a parenthetical does not become
// its own bucket. Measured on the live folder, 13 of 21 files carry one, and bucketing on
// the exact string produced ~16 buckets of one.
{
  const root = setup({
    '2026-07-03-a-plain.md': issue('**Area:** misc · **Effort:** minutes · **Package:** p1'),
    '2026-07-04-b-parenthetical.md': issue('**Area:** misc · **Effort:** minutes (per occurrence, real fix is upstream) · **Package:** p1'),
    '2026-07-05-c-capitalised.md': issue('**Area:** misc · **Effort:** Hour (design, not typing) · **Package:** p1'),
  }, [P1]);
  const { out } = run(root);
  assert.match(out, /3 issues \(2× minutes, 1× hour\)/);
  // The raw value survives on the member line, so the nuance is out of the count, not lost.
  assert.match(out, /• \[minutes \(per occurrence, real fix is upstream\)\] b-parenthetical/);
}

// 23. A hyphenated range is NOT a bucket: it counts as `?` rather than being folded into
// either end, which would invent data. Its raw value still shows on the member line.
{
  const root = setup({
    '2026-07-03-a-range.md': issue('**Area:** misc · **Effort:** minutes-hours (upstream) · **Package:** p1'),
    '2026-07-04-b-plain.md': issue('**Area:** misc · **Effort:** minutes · **Package:** p1'),
  }, [P1]);
  const { out } = run(root);
  assert.match(out, /2 issues \(1× minutes, 1× \?\)/);
  assert.match(out, /• \[minutes-hours \(upstream\)\] a-range/);
}

// 24. A real pack refuses when the program that would be re-invoked to park the entry is not
// gtg.mjs — here it is this test file, which is exactly the hazard: spawning it would exit 0
// on args it ignores and pack would report a park that never happened. Refused BEFORE any
// write, so a wrong invocation leaves nothing stamped. This is the only honest assertion
// about the park path available from this file; see the warning on `run` above.
{
  const root = setup(LOOSE, [P1]);
  const before = snapshot(root);
  const { out, commits, code } = run(root, ['pack', 'p9', '--name', 'Real run', '--next', 'x', 'rtk-grep-flag-mangle']);
  assert.match(out, /not gtg\.mjs/);
  assert.match(out, /refused, nothing written/);
  assert.equal(commits.length, 0);
  assert.equal(code, 1);
  assertUntouched(root, before, 'wrong spawn target');
}

console.log('issues.mjs: all checks passed');
