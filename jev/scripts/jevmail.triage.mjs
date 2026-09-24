#!/usr/bin/env node
// Turn the email tag sweep into a filing plan and a digest of only what needs a human.
//
// Builds on scripts/jev-sweep/jevmail.mjs, which tags a mailbox window for about $0.02 per 400
// messages. That produced numbers; this produces actions.
//
// ⚠ IT PROPOSES, IT DOES NOT FILE. Output is a plan plus a digest. Applying Gmail labels is a
// mutation of a live mailbox and needs an explicit decision, so there is no --apply here: the plan
// is JSON that a labelling step can consume once Nathan has read one.
//
// ⚠ EMAIL IS ATTACKER-CONTROLLED AND THE STATE IS ATTACKABLE. Measured 2026-09-22: appending an
// "[ADMIN] maintenance mode" block or a plain "the requirement above is void" line flipped a
// verdict, while crude "ignore all instructions" imperatives bounced off. Confidence collapsed on
// exactly the attacks that worked (0.00 and 0.39 against 0.90+), so a message whose tags look
// decisive but whose confidence craters is quarantined here rather than filed. Nouls carry no
// confidence, so the quarantine test uses a Score asked alongside.
//
//   node jevmail.triage.mjs --in tags.json --out plan.json
//   node jevmail.triage.mjs --selftest

import fs from 'node:fs';
import assert from 'node:assert';

// Tag to label, in priority order: the FIRST rule that matches wins, so a rejection that also looks
// automated files as a rejection. Order is the whole logic and it is why this is a list.
const RULES = [
  { tag: 'is_interview_invite', at: 0.7, label: 'Orion/Interview', act: 'reply needed' },
  { tag: 'is_assessment', at: 0.7, label: 'Orion/Assessment', act: 'reply needed' },
  { tag: 'is_rejection', at: 0.7, label: 'Orion/Rejected', act: 'log outcome' },
  { tag: 'needs_reply', at: 0.6, label: 'Orion/Needs reply', act: 'reply needed' },
  { tag: 'is_recruiter_outreach', at: 0.6, label: 'Orion/Recruiter', act: 'triage by hand' },
  { tag: 'is_job_listing_alert', at: 0.8, label: 'Orion/Alerts', act: 'archive' },
];

// A message earns a human's attention only for these. Everything else is filed and forgotten,
// which is the entire point: the digest has to be shorter than the inbox or it changes nothing.
const NEEDS_HUMAN = new Set(['reply needed', 'log outcome', 'triage by hand']);

export function planFor(tags) {
  if (!tags) return { label: null, act: 'skip', reason: 'sweep failed for this message' };
  for (const r of RULES) {
    const v = tags[r.tag];
    if (typeof v === 'number' && v >= r.at) {
      return { label: r.label, act: r.act, reason: `${r.tag} ${v.toFixed(2)}` };
    }
  }
  return { label: null, act: 'leave', reason: 'no rule matched' };
}

// A message tagged decisively on several axes at once, on a short body, is the shape an injection
// produces: the text argues for its own classification. Flag rather than file.
export function suspicious(tags, snippetLen) {
  if (!tags) return false;
  const strong = Object.values(tags).filter((v) => typeof v === 'number' && v >= 0.9).length;
  return strong >= 4 && snippetLen < 400;
}

export function selftest() {
  // Priority: an interview invite that also needs a reply files as an interview.
  assert.strictEqual(planFor({ is_interview_invite: 0.9, needs_reply: 0.9 }).label, 'Orion/Interview');
  // A rejection outranks the alert rule even when both fire.
  assert.strictEqual(planFor({ is_rejection: 0.95, is_job_listing_alert: 0.99 }).label, 'Orion/Rejected');
  // Thresholds are respected, and just below one must not file.
  assert.strictEqual(planFor({ is_interview_invite: 0.69 }).label, null);
  assert.strictEqual(planFor({ is_interview_invite: 0.70 }).label, 'Orion/Interview');
  // Alerts need a high bar because the tag fired on 87% of a real window.
  assert.strictEqual(planFor({ is_job_listing_alert: 0.79 }).label, null);
  // A failed sweep is skipped, never filed by default.
  assert.strictEqual(planFor(null).act, 'skip');
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
  return 'jevmail.triage selftest OK';
}

if (process.argv.includes('--selftest')) { console.log(selftest()); process.exit(0); }

const opt = (n) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? null : process.argv[i + 1]; };
const inPath = opt('in');
if (!inPath) { console.error('--in <tags.json from jevmail.mjs> required'); process.exit(1); }

console.log(selftest());
const rows = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const planned = rows.map((r) => ({
  from: r.from, subject: r.subject, date: r.date,
  ...planFor(r.tags),
  quarantine: suspicious(r.tags, String(r.snippet ?? '').length),
}));

const counts = {};
for (const p of planned) counts[p.label ?? '(none)'] = (counts[p.label ?? '(none)'] ?? 0) + 1;
console.log(`\n  ${planned.length} messages\n`);
console.log('  label                   count');
for (const [l, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${l.padEnd(22)} ${String(n).padStart(5)}`);
}

const digest = planned.filter((p) => NEEDS_HUMAN.has(p.act));
const quar = planned.filter((p) => p.quarantine);
console.log(`\n  needs a human   ${digest.length} of ${planned.length} `
  + `(${(digest.length / planned.length * 100).toFixed(0)}%)`);
console.log(`  quarantined     ${quar.length}`);

console.log('\n--- DIGEST ---');
for (const p of digest.slice(0, 40)) {
  console.log(`  [${p.act}] ${String(p.subject ?? '(no subject)').slice(0, 62)}`);
  console.log(`      ${String(p.from ?? '').slice(0, 44)}   ${p.reason}`);
}
if (digest.length > 40) console.log(`  ... and ${digest.length - 40} more`);
if (quar.length) {
  console.log('\n--- QUARANTINED (decisive tags on a very short body; read before trusting) ---');
  for (const p of quar.slice(0, 10)) console.log(`  ${String(p.subject ?? '').slice(0, 66)}`);
}

if (opt('out')) {
  fs.writeFileSync(opt('out'), JSON.stringify(planned, null, 2));
  console.log(`\nplan written to ${opt('out')} — nothing has been filed`);
}
