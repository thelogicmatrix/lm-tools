// The purpose-line ledger: which prompts each runbook's purpose was scored on, and a fingerprint
// of the purpose that was scored. check.mjs --changed re-runs only the runbooks whose purpose
// moved since their entry, reusing the stored prompts, so an unchanged line costs no Jev call.
// index.mjs --lint reads the same file to say how many have drifted. The file lives where
// settings().ledger says, so every caller passes it.
// Rule: the runbooks skill, references/purpose-lines.md.
import fs from 'node:fs';
import crypto from 'node:crypto';

// Whitespace-normalised, so a reflowed line with the same words is the same purpose.
export const purposeHash = (purpose) =>
  crypto.createHash('sha1').update(String(purpose ?? '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);

export function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// Sorted keys so a one-entry change is a one-entry diff.
export function save(ledger, file) {
  const sorted = Object.fromEntries(Object.keys(ledger).sort().map((k) => [k, ledger[k]]));
  fs.writeFileSync(file, JSON.stringify(sorted, null, 1) + '\n');
}

// corpus: [{ file, purpose }]. A runbook with no entry cannot be re-run, because there are no
// prompts to reuse, so it is reported as untested rather than guessed at.
export function triage(corpus, ledger) {
  const changed = [], untested = [], unchanged = [];
  for (const b of corpus) {
    const e = ledger[b.file];
    if (!e) untested.push(b.file);
    else if (e.purpose !== purposeHash(b.purpose)) changed.push(b.file);
    else unchanged.push(b.file);
  }
  const gone = Object.keys(ledger).filter((f) => !corpus.some((b) => b.file === f));
  return { changed, untested, unchanged, gone };
}

export function entry(purpose, prompts, nots, results) {
  const task = results.filter((r) => r.want);
  return {
    purpose: purposeHash(purpose),
    prompts,
    not: nots,
    passed: results.every((r) => r.ok),
    low: task.length ? Math.min(...task.map((r) => r.p ?? 0)) : null,
    checked: new Date().toISOString().slice(0, 10),
  };
}
