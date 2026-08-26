// Self-check for gtg/skills/gtg/extensions/commands/issues.mjs.
// Run: node gtg/test/issues.test.mjs
// ponytail: no framework, no fixtures dir. A temp root plus a stubbed ctx is the
// whole harness. Reach for node:test only if this grows past a dozen cases.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import issues, { field } from '../skills/gtg/extensions/commands/issues.mjs';

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
// A `pack` that reaches the park spawns `process.argv[1]`, which is THIS FILE unless you
// change it, so it would re-run the suite and spawn again, forever. `process.argv[1]` is
// writable, so cases 29 and 30 point it at a stub named gtg.mjs, which both satisfies the
// guard and makes the stub the spawn target. That removes the fork hazard by construction
// rather than by refusal. Every OTHER pack case here refuses or passes --dry-run, so it
// never reaches the spawn at all.
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
      // Throws on purpose, same as writeStore. The command must reach entries ONLY through
      // ownEntries, so the parent-namespace string stays in gtg.mjs. A working readStore here
      // would let a future edit quietly reintroduce a hand-rolled store read plus parent
      // filter, and the suite would pass.
      // SCOPE, measured rather than assumed: this enforces "not through ctx.readStore". It does
      // NOT enforce "only through ownEntries". The same regression hand-rolled at the FS level,
      // JSON.parse(readFileSync(...)) bypassing ctx entirely, is NOT caught, and readIssues
      // already readFileSyncs under root so that route is available to a future edit.
      // RE-AUDITING A FAIL-PRE-FIX MEASUREMENT: this stub makes that impossible as written.
      // A pre-ownEntries issues.mjs calls readPackages(readStore) and dies here immediately, so
      // every assertion reports the same meaningless failure instead of the specific ones a fix
      // addressed. To reproduce any commit message's "N assertions failed before" figure,
      // temporarily restore a working readStore (JSON.parse(readFileSync(join(root, rel)))) for
      // the duration of that audit only. The measurements in the history were taken that way.
      // The note lives here rather than in a commit message because commits are immutable and
      // the run ledger is git-ignored, so neither survives to the next auditor.
      readStore: () => { throw new Error('read entries through ownEntries, not readStore'); },
      // Mirrors gtg.mjs handing over EXTENSIONS['issues']. The command no longer carries the
      // namespace literal at all, so the writer half (pack's --parent) reads it from here and
      // the park test below pins what actually reaches the child argv.
      ownParent: 'issues',
      // Mirrors gtg.mjs: both stores, already filtered to this command's own parent
      // namespace, so the command never sees the namespace string itself.
      ownEntries: () => {
        const grab = (rel, key) => {
          try {
            const store = JSON.parse(readFileSync(join(root, rel), 'utf8'));
            const all = Array.isArray(store?.[key]) ? store[key].filter(Boolean) : [];
            return all.filter((e) => e.parent === 'issues');
          } catch { return []; }
        };
        return {
          active: grab('docs/handoffs/_active.json', 'handoffs'),
          shelved: grab('docs/handoffs/_backlog.json', 'backlog'),
        };
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
// runs BEFORE it, so a write-then-fail passes that check. Byte-compare every issue
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
  assert.match(out, /\[issues-p1-hooks\] \(active\) - no members - unstamped, or done \(`gtg remove issues-p1-hooks`\)/);
}

// 4. An unstamped issue is loose, grouped by area, and a missing Area reads unfiled.
{
  const root = setup({
    '2026-07-06-memory-orphan-files.md': issue('**Area:** claude-stack · **Effort:** hour'),
    '2026-07-28-reborn-audit.md': issue('No field line here at all.'),
  });
  const { out } = run(root);
  assert.match(out, /UNPACKAGED \(2\) - in no package, untriaged/);
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
  assert.match(out, /• \[session\] sdd-review-tier - BLOCKED: Nathan's call/);
  assert.doesNotMatch(out, /dangling-volumes - BLOCKED/);
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

// The numbers below are the order cases were ADDED, and the file is ordered by topic, so the
// two do not line up and nothing is missing at this jump: 16 to 18 are render cases and sit
// with the other render cases above, and 8 to 15 follow further down.

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
  assert.match(out, /• \[hour\] model-guard-fp - WORKED-AROUND: dispatch as Plan instead/);
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

// 28. A bare `worked-around` Status with no parenthetical renders the flag with no value. The
// parse is `statusRaw.match(/\((.+)\)/)?.[1] ?? null` and the render is a ternary on it, so
// this is the untested half of the branch case 16 covers from the other side. Anchored at
// end-of-line on purpose: that is what separates it from case 16's `WORKED-AROUND: <value>`.
{
  const root = setup({
    '2026-07-25-bare-workaround.md': issue(
      '**Area:** misc · **Effort:** minutes\n'
      + '**Check:** run the thing\n'
      + '**Status:** worked-around',
    ),
  });
  const { out } = run(root);
  assert.match(out, /• \[minutes\] bare-workaround - WORKED-AROUND$/m,
    'a bare worked-around did not render as a bare flag');
  assert.doesNotMatch(out, /WORKED-AROUND:/, 'a bare worked-around printed a trailing colon');
  assert.match(out, /1 worked-around/, 'a bare worked-around was not counted');
}

// 8. An exact pN hands control back to the skill, as the only output line.
{
  const root = setup({}, [P1]);
  const { out } = run(root, ['p1']);
  assert.equal(out, 'GTG-DIRECTIVE: run gtg.mjs resume issues-p1-hooks --keep and follow SKILL.md's Resume Procedure. A package is never consumed: it is the only live pN-to-name mapping its issue files point at, and it retires by being finished (see references/commands.md, "Working a package").');
}

// 9. A full slug and a substring of the project name both resolve, and like case 8 the
// directive is the SOLE output. gtg's router only acts on a directive it sees first.
{
  const root = setup({}, [P1], [P3]);
  const only = 'GTG-DIRECTIVE: run gtg.mjs resume issues-p3-obelisk-housekeeping --keep and follow SKILL.md's Resume Procedure. A package is never consumed: it is the only live pN-to-name mapping its issue files point at, and it retires by being finished (see references/commands.md, "Working a package").';
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
  assert.match(out, /UNPACKAGED \(2\) - in no package, untriaged/);
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
// recovery path, the only way a member can already carry the pN being packed, and a
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
// its own bucket. Measured on the live folder when this was written, most files carried one
// and bucketing on the exact string produced close to one bucket per file. No file count
// recorded here on purpose: the folder grows most weeks, so the count would be stale.
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
// gtg.mjs. Here it is this test file, which is exactly the hazard: spawning it would exit 0
// on args it ignores and pack would report a park that never happened. Refused BEFORE any
// write, so a wrong invocation leaves nothing stamped, and that is this case's whole purpose.
// The park itself is covered by cases 29 and 30, which satisfy the guard by pointing
// `process.argv[1]` at a stub named gtg.mjs. See the note on `run` above.
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

// 29. The park path end to end: stamp, then the commit call, then the real spawn. The run that
// wrote this file believed the chain untestable from here because the spawn target would be the
// suite itself. It is not: `process.argv[1]` is writable, so pointing it at a stub named gtg.mjs
// satisfies the guard case 24 covers AND makes the stub the spawn target, which removes the fork
// hazard by construction rather than by refusal. What this does NOT cover: `commit` is the
// recorder from `run`, so this drives the CALL, never a real git commit.
{
  const root = setup({ '2026-08-04-scratch.md': issue('**Area:** misc · **Effort:** minutes') }, [P1]);
  const stub = join(root, 'gtg.mjs');
  // ESM, not `require`: the guard forces the name gtg.mjs, and a .mjs file is always a module.
  writeFileSync(stub, [
    "import { writeFileSync } from 'node:fs';",
    "let body = '';",
    "process.stdin.on('data', (d) => { body += d; });",
    "process.stdin.on('end', () => {",
    "  writeFileSync(process.argv[1] + '.park.json', JSON.stringify({ argv: process.argv.slice(2), body }));",
    '});',
  ].join('\n'));
  const savedArgv1 = process.argv[1];
  process.argv[1] = stub;
  try {
    const { out, commits, code } = run(root, [
      'pack', 'p9', '--name', 'Issues P9: DNS flakiness', '--next', 'Reproduce the timeout', 'scratch',
    ]);
    // Assert the child SUCCEEDED before reading its record. A stub that throws also fails the
    // spawn, and it would otherwise surface as a missing record file, which reads like a
    // product defect rather than a broken fixture.
    assert.doesNotMatch(out, /parking the entry failed/, 'the park failed, or the stub itself threw');
    assert.equal(code, 0, 'a successful park still set a failure exit code');
    const parked = JSON.parse(readFileSync(`${stub}.park.json`, 'utf8'));
    assert.deepEqual(parked.argv, [
      'backlog', '--project', 'Issues P9: DNS flakiness', '--slug', 'issues-p9-dns-flakiness',
      '--next', 'Reproduce the timeout', '--parent', 'issues',
    ], 'the child was not asked to park this entry');
    assert.match(parked.body, /## The Package/, 'no handoff body reached the child on stdin');
    assert.match(parked.body, /- docs\/issues\/2026-08-04-scratch\.md/, 'the body lists no members');
    assert.match(readFileSync(join(root, 'docs/issues/2026-08-04-scratch.md'), 'utf8'),
      /\*\*Package:\*\* p9/, 'the member was never stamped');
    assert.deepEqual(commits, [{
      paths: ['docs/issues/2026-08-04-scratch.md'],
      msg: 'issues: pack p9 - Issues P9: DNS flakiness (1 issue)',
    }], 'the stamp was not handed to commit');
  } finally {
    process.argv[1] = savedArgv1;
  }
}

// 30. The spawn-failure branch names the exit code and does not claim success. Measured, not
// assumed: the parent writes the handoff body to a child that has already exited, and that does
// NOT come back as a spawn error, so `why` really is the exit code and not an EPIPE message.
{
  const root = setup({ '2026-08-04-scratch.md': issue('**Area:** misc · **Effort:** minutes') }, [P1]);
  const stub = join(root, 'gtg.mjs');
  writeFileSync(stub, 'process.exit(3);');
  const savedArgv1 = process.argv[1];
  process.argv[1] = stub;
  try {
    const { out, code } = run(root, ['pack', 'p9', '--name', 'X', '--next', 'Y', 'scratch']);
    assert.match(out, /1 file\(s\) stamped, but parking the entry failed \(exit 3\)/,
      'the park failure did not report the exit code and the files already stamped');
    assert.match(out, /re-run the same `gtg issues pack` command/, 'no recovery instruction');
    assert.equal(code, 1, 'a failed park reported success');
  } finally {
    process.argv[1] = savedArgv1;
  }
}

// 25. A pN query is EXACT. `p1` against a store holding only p10 used to substring-match
// `issues-p10-dns`, return it as a lone match, and make the router resume the wrong package.
// Free text still substring-matches, which is the useful half.
{
  const P10 = pkg({ project: 'Issues P10: dns', slug: 'issues-p10-dns' });
  const only10 = setup({}, [P10]);
  const wrong = run(only10, ['p1']);
  assert.doesNotMatch(wrong.out, /GTG-DIRECTIVE/,
    'p1 substring-matched p10 and would resume the wrong package');
  assert.match(wrong.out, /No issue package matches "p1"/);
  // An exact pN still reaches its own package.
  assert.equal(run(only10, ['p10']).out,
    'GTG-DIRECTIVE: run gtg.mjs resume issues-p10-dns --keep and follow SKILL.md's Resume Procedure. A package is never consumed: it is the only live pN-to-name mapping its issue files point at, and it retires by being finished (see references/commands.md, "Working a package").',
    'an exact pN query stopped matching its own package');
  // Free text keeps substring matching.
  assert.equal(run(only10, ['dns']).out,
    'GTG-DIRECTIVE: run gtg.mjs resume issues-p10-dns --keep and follow SKILL.md's Resume Procedure. A package is never consumed: it is the only live pN-to-name mapping its issue files point at, and it retires by being finished (see references/commands.md, "Working a package").',
    'substring matching on free text was wrongly removed');
  // p1 resolves to p1 when p1 exists, with p10 sitting alongside it.
  const both = setup({}, [P1, P10]);
  assert.equal(run(both, ['p1']).out,
    'GTG-DIRECTIVE: run gtg.mjs resume issues-p1-hooks --keep and follow SKILL.md's Resume Procedure. A package is never consumed: it is the only live pN-to-name mapping its issue files point at, and it retires by being finished (see references/commands.md, "Working a package").');
  // A whitespace-only query is empty, not match-everything.
  const blank = run(both, ['   ']);
  assert.doesNotMatch(blank.out, /GTG-DIRECTIVE/);
  assert.match(blank.out, /No issue package matches/);

  // The WRITER half of the same finding. `pack`'s duplicate check calls this same resolve, so
  // `pack p1` used to be refused with `p1 already exists: issues-p10-dns`. Asserted here and
  // not left to the shared call site, because case 12 only asserts the POSITIVE refusal (p1
  // while p1 really exists). Inline that check as its own pn scan and the reader cases above
  // keep passing while the writer half regresses unseen. This pack refuses on the spawn target
  // (case 24), which is fine: the point is that `already exists` is NOT among the reasons.
  const packRoot = setup(LOOSE, [P10]);
  const before = snapshot(packRoot);
  const refused = run(packRoot, ['pack', 'p1', '--name', 'X', '--next', 'Y', 'rtk-grep-flag-mangle']);
  assert.ok(!/already exists/.test(refused.out), 'pack p1 was refused because p10 exists');
  assertUntouched(packRoot, before, 'pack p1 against a p10 store');
}

// 26. An entry in this namespace whose slug carries no pN is not a package. `gtg-issues-layer`
// was gtg tooling filed under parent: issues, and it rendered as a package with membership
// unstamped for a whole session.
{
  const root = setup({}, [P1, pkg({ project: 'gtg issues layer', slug: 'gtg-issues-layer' })]);
  const { out } = run(root);
  assert.match(out, /\[issues-p1-hooks\]/);
  assert.doesNotMatch(out, /gtg-issues-layer/,
    'a pN-less entry in the issues namespace rendered as a package');
  assert.match(out, /0 issues · 1 packages/);
}

// 27. The unpackaged remainder is a named class, not one more group heading, and packages
// still lead the output.
{
  const root = setup(LOOSE, [P1]);
  const { out } = run(root);
  assert.match(out, /^={10,}$/m, 'no rule line above the unpackaged block');
  assert.match(out, /UNPACKAGED \(\d+\) - in no package, untriaged/,
    'the unpackaged heading does not say what unpackaged means');
  assert.ok(!/^Loose \(/m.test(out), 'the old Loose heading survived');
  assert.ok(out.indexOf('issues-p1-hooks') < out.indexOf('UNPACKAGED'),
    'packages no longer lead the output');
}

// 31. field() reads the two field SHAPES correctly, which no rendered output can show: the
// view prints presence, never a value, so a truncating or over-reaching reader is invisible
// from the CLI. Inline fields stop at the separator; Check and Status run to the end of their
// paragraph; and neither shape may pick up a label from a fence or from prose.
{
  const doc = [
    '# t',
    '',
    '**Area:** misc · **Effort:** hours (nuance) · **Package:** p1',
    '**Check:** run the thing',
    'and the wrapped half · with a separator in it',
    '**Status:** worked-around (a name)',
    '',
    'Prose mentioning **Package:** p98 mid-sentence.',
    '',
    '```markdown',
    '**Package:** p99 · **Area:** obelisk',
    '```',
  ].join('\n');

  assert.equal(field(doc, 'Area'), 'misc', 'an inline field ran past its separator');
  assert.equal(field(doc, 'Effort'), 'hours (nuance)', 'an inline field lost its parenthetical');
  assert.equal(field(doc, 'Package'), 'p1',
    'Package did not come from the real field line - a fenced or prose label won');
  assert.equal(field(doc, 'Check'), 'run the thing and the wrapped half · with a separator in it',
    'Check was truncated at the newline, or stopped at the separator, or swallowed Status');
  assert.equal(field(doc, 'Status'), 'worked-around (a name)', 'Status was not read whole');
  assert.equal(field(doc, 'Blocked on'), null, 'an absent field did not read as absent');
}

// 32. Effort accepts either number and canonicalises, because the documented vocabulary is
// itself inconsistent. A genuine range still refuses to guess an end.
{
  const bucket = (e) => {
    const root = setup({ '2026-01-01-e.md': `# e\n\n**Area:** misc · **Effort:** ${e} · **Package:** p1\n` }, [P1]);
    return run(root).out;
  };
  assert.match(bucket('hours'), /1× hour\b/, '`hours` still buckets to ? instead of hour');
  assert.match(bucket('minute'), /1× minutes\b/, '`minute` did not canonicalise to minutes');
  assert.match(bucket('sessions'), /1× session\b/, '`sessions` did not canonicalise to session');
  assert.match(bucket('minutes-hours (upstream)'), /1× \?/, 'a range invented an end');
}

console.log('issues.mjs: all checks passed');
