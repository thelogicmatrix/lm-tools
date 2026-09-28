import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../hooks/projects-index-guard.mjs';

const w = (file_path) => ({ tool_name: 'Write', tool_input: { file_path } });

test('denies the generated index and the store, on either slash style', () => {
  for (const p of ['C:/Users/you/docs/projects/INDEX.md',
                   'C:\\Users\\you\\docs\\projects\\INDEX.md',
                   '/c/Users/you/docs/projects/_projects.json']) {
    const d = decide(w(p));
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.permissionDecisionReason, /projects current|projects status|generated/);
  }
});

// The store is one file per project now, so the guarded shape is a directory of records rather
// than one array file. The reason is the same as it always was: a hand-edit skips validateSlug,
// validateStatus and assertRenderable, and leaves the rendered index disagreeing with the store.
// A slug is also a FILENAME now, so a hand-edit can put a record somewhere no verb will find it.
test('denies a per-project record file under entries/', () => {
  for (const p of ['docs/projects/entries/alpha.json',
                   'C:/Users/you/docs/projects/entries/alpha.json',
                   'C:\\Users\\you\\docs\\projects\\entries\\alpha.json',
                   'docs/projects/entries/./alpha.json',
                   'docs//projects/entries/alpha.json']) {
    assert.equal(decide(w(p)).permissionDecision, 'deny', p);
  }
});

test('does not deny things that only look like a record file', () => {
  for (const p of ['docs/projects/entries.md',
                   'docs/projects/entries/alpha.md',
                   'docs/projects/archive/entries/alpha.json',
                   'C:/dev/other/mydocs/projects/entries/alpha.json']) {
    assert.equal(decide(w(p)), null, p);
  }
});

test('allows narrative pages, which are hand-written by design', () => {
  for (const p of ['C:/Users/you/docs/projects/price-alerts.md',
                   'C:/Users/you/docs/projects/CRITIQUES.md',
                   'C:/Users/you/docs/projects/archive/old.md']) {
    assert.equal(decide(w(p)), null);
  }
});

test('allows an INDEX.md belonging to some other folder', () => {
  assert.equal(decide(w('C:/dev/other/docs/INDEX.md')), null);
  assert.equal(decide(w('C:/dev/other/INDEX.md')), null);
});

test('ignores tools that are not writes, and malformed input', () => {
  assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: 'docs/projects/INDEX.md' } }), null);
  assert.equal(decide({}), null);
  assert.equal(decide({ tool_name: 'Write' }), null);
  assert.equal(decide({ tool_name: 'Write', tool_input: {} }), null);
});

// Pins the deliberate ruling on scope. The guard matches the path segment wherever it sits, so
// another repo with its own docs/projects/INDEX.md is denied too. The alternative, anchoring on
// a real home directory, cannot pass the /c/Users/... case in the first test above, and a
// false allow silently destroys the hand-written prose this hook exists to protect, while a
// false deny costs one retry. `mydocs/` is not the segment and stays allowed.
test('matches the path segment anywhere, but only on a segment boundary', () => {
  assert.equal(decide(w('C:/dev/other/docs/projects/INDEX.md')).permissionDecision, 'deny');
  assert.equal(decide(w('docs/projects/_projects.json')).permissionDecision, 'deny');
  assert.equal(decide(w('C:/dev/other/mydocs/projects/INDEX.md')), null);
});

// Separator normalisation alone left these reaching the guarded files past an anchored regex.
// The double-slash form is the reachable one: it falls out of any `${root}/` + `docs/projects/...`
// join, and skill-driven writes are this guard's main audience.
test('denies non-canonical paths that resolve to a guarded file', () => {
  for (const p of ['docs//projects/INDEX.md',
                   'docs/projects/./INDEX.md',
                   'docs/projects/sub/../INDEX.md',
                   'C:/Users/you/docs//projects/INDEX.md',
                   'C:\\Users\\you\\docs\\projects\\.\\INDEX.md',
                   'C:/Users/you/docs/projects/sub/../_projects.json',
                   '//server/share/docs/projects/INDEX.md']) {
    assert.equal(decide(w(p)).permissionDecision, 'deny', p);
  }
});

// The mirror image: normalising must not pull in a path that resolves somewhere else.
test('still allows paths that only look like the guarded ones', () => {
  for (const p of ['docs/projects/../INDEX.md',
                   'docs/projects/INDEX.md.bak',
                   'docs/projects/archive/INDEX.md',
                   'C:/dev/other/mydocs//projects/INDEX.md']) {
    assert.equal(decide(w(p)), null, p);
  }
});

// The deny string is read by a human mid-task and every verb in it must exist. `sync` is
// deliberately absent: it is read-only and is not a remedy for a denied write.
test('the reason names only verbs the CLI has, and no banned punctuation', () => {
  const reason = decide(w('docs/projects/INDEX.md')).permissionDecisionReason;
  assert.match(reason, /projects current|projects status|generated/);
  for (const verb of ['register', 'status', 'current', 'archive', 'render']) {
    assert.match(reason, new RegExp('`projects ' + verb + '\\b'));
  }
  assert.doesNotMatch(reason, /[\u2013\u2014;]/);
  assert.doesNotMatch(reason, /projects (sync|list|help)/);
  // The load-bearing sentence: without it the deny points at a CLI that exits 2 on an
  // unmigrated root and gives no next action.
  assert.match(reason, /not migrated yet/);
});
