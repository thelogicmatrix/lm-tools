#!/usr/bin/env node
// Does the router actually surface this runbook? Scores one runbook's purpose line against task
// prompts through the live router path (prefilter, then one Jev call per prompt, ~$0.0004 each).
//
//   node <plugin>/scripts/check.mjs <runbook.md> "<prompt>" ... [--not "<prompt>"] [--purpose "<trial text>"] [--record]
//   node <plugin>/scripts/check.mjs --changed [--dry]
//
// Every plain prompt must score >= the write bar (settings().writeBar, firesAt + 0.05 = 0.85 by
// default), the writing margin. A prompt the prefilter cuts counts as a fail, because a cut
// runbook never reaches Jev. Every --not prompt must stay under firesAt itself (0.8). --purpose
// trials a rewrite without editing the file. Exit 1 on any failure. The rule this serves is in
// the runbooks skill, references/purpose-lines.md.
//
// --record writes the prompts and a fingerprint of the scored purpose to the ledger
// (settings().ledger). --changed re-runs, with their stored prompts, only the runbooks whose
// purpose moved since their ledger entry, and records the new result. An unchanged purpose costs
// nothing. --dry lists what would run and makes no call.
import path from 'node:path';
import { settings } from './config.mjs';
import * as J from './router.mjs';
import * as L from './ledger.mjs';

const s = settings({ cwd: process.cwd() });
const BAR = s.firesAt;
// A new purpose line must clear the bar with room to spare: identical runs wobble by about
// 0.02 to 0.04, so a line written at 0.80 fails the next time. --not prompts only need to stay
// under the bar itself.
const WRITE_BAR = s.writeBar;
const ROUTE_OPTS = { firesAt: s.firesAt, maxInject: s.maxInject, shortlist: s.shortlist };

// Called after the usage parse, so a bad command line gets the usage line wherever it runs.
const requireDir = () => { if (!s.dir) { console.error('No runbooks folder found (RUNBOOKS_DIR, .runbooks/config.json dir, docs/runbooks).'); process.exit(2); } };

async function score(target, books, key, pos, neg) {
  const results = [];
  const all = [...pos.map((q) => [q, true]), ...neg.map((q) => [q, false])];
  for (const [i, [q, want]] of all.entries()) {
    let answers;
    const spy = async (...a) => { const r = await fetch(...a); answers = (await r.clone().json()).answers; return r; };
    const narrowed = J.narrow(q, books, s.shortlist);
    const doc = narrowed.find((b) => b.file === target);
    // Already narrowed above, so route must not narrow a second time: check grades the set the hook sends.
    if (doc) await J.route(q, narrowed, key, spy, { ...ROUTE_OPTS, narrow: false });
    const p = doc ? (answers?.[J.keyFor(doc)]?.noul ?? 0) : null;
    const ok = want ? p !== null && p >= WRITE_BAR : p === null || p < BAR;
    results.push({ q, want, p, ok });
    console.log(`[${i + 1}/${all.length}] ${ok ? 'PASS' : 'FAIL'} ${p === null ? 'cut ' : p.toFixed(2)} ${want ? `want>=${WRITE_BAR}` : `want< ${BAR}`}  ${q}`);
  }
  return results;
}

const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };
const changedMode = flag('--changed'), dry = flag('--dry'), record = flag('--record');

if (changedMode) {
  requireDir();
  const books = J.loadAll(s.dir);
  const ledger = L.load(s.ledger);
  const t = L.triage(books, ledger);
  console.log(`${t.unchanged.length} unchanged (skipped), ${t.changed.length} changed, ${t.untested.length} never recorded, ${t.gone.length} gone from the corpus`);
  for (const f of t.untested) console.log(`  never recorded: ${f} (run it once by hand with --record)`);
  for (const f of t.gone) console.log(`  gone: ${f} (its ledger entry can be deleted)`);
  if (dry || !t.changed.length) { for (const f of t.changed) console.log(`  would re-run: ${f}`); process.exit(0); }
  const key = J.readKey();
  if (!key) { console.error('no jev key, cannot score'); process.exit(2); }
  let failedFiles = 0;
  for (const [i, f] of t.changed.entries()) {
    const e = ledger[f];
    console.log(`\n[${i + 1}/${t.changed.length}] ${f}`);
    const results = await score(f, books, key, e.prompts, e.not ?? []);
    const b = books.find((x) => x.file === f);
    ledger[f] = L.entry(b.purpose, e.prompts, e.not ?? [], results);
    L.save(ledger, s.ledger);
    if (!ledger[f].passed) failedFiles++;
  }
  console.log(failedFiles ? `\n${failedFiles} of ${t.changed.length} changed runbooks failed` : `\nall ${t.changed.length} changed runbooks passed`);
  process.exitCode = failedFiles ? 1 : 0;
} else {
  const target = path.basename(args.shift() ?? '');
  const pos = [], neg = [];
  let purpose = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--not') neg.push(args[++i]);
    else if (args[i] === '--purpose') purpose = args[++i];
    else pos.push(args[i]);
  }
  if (!target || !pos.length) { console.error('usage: check.mjs <runbook.md> "<prompt>" ... [--not "<prompt>"] [--purpose "<text>"] [--record]  |  --changed [--dry]'); process.exit(2); }
  requireDir();

  const key = J.readKey();
  if (!key) { console.error('no jev key, cannot score'); process.exit(2); }
  const books = J.loadAll(s.dir).map((b) => (b.file === target && purpose ? { ...b, purpose } : b));
  const doc = books.find((b) => b.file === target);
  if (!doc) { console.error(`${target} is not in the router corpus (missing, or no Type/Purpose line)`); process.exit(2); }

  const results = await score(target, books, key, pos, neg);
  const failed = results.filter((r) => !r.ok).length;
  // A trial's fingerprint is the trial text, so writing that exact text into the file later makes
  // the entry current without another run.
  if (record) { const ledger = L.load(s.ledger); ledger[target] = L.entry(doc.purpose, pos, neg, results); L.save(ledger, s.ledger); console.log('recorded'); }
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exitCode = failed ? 1 : 0;
}
// exitCode, not exit(): exiting with a fetch socket still closing trips a libuv assertion on
// Windows and the process dies with 127 instead of the real code.
