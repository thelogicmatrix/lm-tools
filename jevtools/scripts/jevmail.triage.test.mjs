// jevmail.triage's offline tests, moved out of the script's --selftest branch.
import test from 'node:test';
import assert from 'node:assert';
import { NEEDS_HUMAN, planFor, suspicious } from './jevmail.triage.mjs';

test('rule priority, thresholds, failed rows and the injection shape', () => {
  // Priority: an interview invite that also needs a reply files as an interview.
  assert.strictEqual(planFor({ is_interview_invite: 0.9, needs_reply: 0.9 }).label, 'Jobs/Interview');
  // A rejection outranks the alert rule even when both fire.
  assert.strictEqual(planFor({ is_rejection: 0.95, is_job_listing_alert: 0.99 }).label, 'Jobs/Rejected');
  // Thresholds are respected, and just below one must not file.
  assert.strictEqual(planFor({ is_interview_invite: 0.69 }).label, null);
  assert.strictEqual(planFor({ is_interview_invite: 0.70 }).label, 'Jobs/Interview');
  // Alerts need a high bar because the tag fired on 87% of a real window.
  assert.strictEqual(planFor({ is_job_listing_alert: 0.79 }).label, null);
  // A failed sweep is failed, never filed and never 'skip'. Skip read as done, so the row was never
  // asked again. jevmail re-asks only the untagged rows of its own tags file.
  assert.deepStrictEqual(planFor(null),
    { label: null, act: 'failed', reason: 'sweep failed for this message, re-run jevmail --in on the tags file' });
  assert.ok(!NEEDS_HUMAN.has('failed'), 'a failed row is a re-run, not a digest entry');
  assert.strictEqual(planFor({}).act, 'leave');
  // Null tags (missing answers) must not satisfy a threshold.
  assert.strictEqual(planFor({ is_rejection: null }).label, null);
  // The digest only carries what a person must act on.
  assert.ok(NEEDS_HUMAN.has(planFor({ is_rejection: 0.9 }).act));
  assert.ok(!NEEDS_HUMAN.has(planFor({ is_job_listing_alert: 0.95 }).act));
  // Injection shape: many decisive tags on a very short body.
  assert.strictEqual(suspicious({ a: 0.95, b: 0.95, c: 0.95, d: 0.95 }, 120), true);
  assert.strictEqual(suspicious({ a: 0.95, b: 0.95, c: 0.95, d: 0.95 }, 3000), false, 'a long body is normal');
  assert.strictEqual(suspicious({ a: 0.95, b: 0.2 }, 120), false);
  assert.strictEqual(suspicious(null, 100), false);
});
