#!/usr/bin/env node
// Which runbooks apply to this task? Nathan's idea, and it is the best fit measured today.
//
// TODAY: `runbooks-index.mjs` injects 43 procedures, standards and references at session start and
// relies on the model noticing that one matches. That is a mechanical injection whose hit rate
// nobody has measured, and the cost of a miss is a runbook that existed and went unread.
//
// INSTEAD: one Noul per runbook against the task text. ~43 questions in one call, ~400ms, a
// fraction of a cent, and the answer is a ranked list rather than a wall of text competing for
// attention. It also shrinks the injection: send the matches, not the catalogue.
//
// This is the volume rule pointing the other way from usual. Forty-three is above the "just read
// them" threshold for a human, and the index is re-read on every task.
//
//   node runbook-match.mjs --task "the nightly backup pruned nothing again"
//   node runbook-match.mjs --eval      # scores itself against each runbook's own purpose line
//   node runbook-match.mjs --selftest

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { askJev } from './lib.mjs';

const ROOT = 'docs/runbooks';
const FIRES_AT = 0.5;

// A runbook declares **Type:** and **Purpose:**. The purpose line is what the index shows and what
// a match has to be judged on, so it is what goes in the question.
export function parseRunbook(text, file) {
  const type = text.match(/^\*\*Type:\*\*\s*(\w+)/m)?.[1] ?? null;
  // ⚠ The terminator is a lookahead, and `$` is deliberately absent: under /m it matches the end of
  // the FIRST line, so a purpose that wraps onto a second line was silently truncated to its first
  // clause. `(?![\s\S])` is end-of-input and does not have that behaviour.
  const purpose = text.match(/^\*\*Purpose:\*\*\s*([\s\S]*?)(?=\n\s*\n|\n\*\*|\n#|(?![\s\S]))/m)?.[1]
    ?.replace(/\s+/g, ' ').trim() ?? null;
  return { file, type, purpose };
}

export function loadRunbooks(root = ROOT) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) {
        const r = parseRunbook(fs.readFileSync(p, 'utf8'), path.relative(root, p));
        // A runbook with no purpose line cannot be matched on, and silently including it would
        // make the question "does this task match undefined".
        if (r.purpose && r.type) out.push(r);
      }
    }
  })(root);
  return out;
}

// One Noul per runbook. The id has to be a safe key and map back to a file.
const keyFor = (f) => 'rb_' + f.replace(/[^a-z0-9]+/gi, '_').toLowerCase();

export function buildQuestions(books) {
  return Object.fromEntries(books.map((b) => [keyFor(b.file), {
    type: 'noul',
    instructions: `Before starting this task, the person should read a ${b.type} whose purpose is: ${b.purpose}`,
    // ⚠ criteria, because the bare version of a question was measured at 63% against 99% coached
    // on the MLM task. The poles here separate "the task is IN this subject area" from "the task
    // merely mentions something this document also mentions", which is the whole failure mode.
    criteria: {
      true: 'The task is squarely within what that document governs, and doing the task without it '
        + 'risks getting the process or the rule wrong',
      false: 'The task is in a different area, or only shares vocabulary with that document without '
        + 'being about the same work',
    },
  }]));
}

export function selftest() {
  const md = '# Thing\n**Type:** procedure\n**Purpose:** Keep the backups actually running.\n\n## Steps\n1. x';
  const r = parseRunbook(md, 'thing.md');
  assert.strictEqual(r.type, 'procedure');
  assert.strictEqual(r.purpose, 'Keep the backups actually running.');
  // A multi-line purpose collapses to one line rather than swallowing the next section.
  const m2 = parseRunbook('**Type:** standard\n**Purpose:** Line one\ncontinues here.\n\n## Next\nbody', 'a.md');
  assert.strictEqual(m2.purpose, 'Line one continues here.');
  assert.ok(!m2.purpose.includes('Next'));
  // No purpose means unmatchable, not matched-on-undefined.
  assert.strictEqual(parseRunbook('**Type:** reference\nno purpose here', 'b.md').purpose, null);
  // Keys are safe and unique per file.
  assert.strictEqual(keyFor('job-search/index.md'), 'rb_job_search_index_md');
  assert.notStrictEqual(keyFor('a-b.md'), keyFor('a_b2.md'));
  // Every question carries criteria; that was worth 36 points on the one task where it was measured.
  const qs = buildQuestions([{ file: 'x.md', type: 'procedure', purpose: 'Do a thing.' }]);
  const q = Object.values(qs)[0];
  assert.ok(q.criteria.true && q.criteria.false);
  assert.ok(q.instructions.includes('Do a thing.'));
  assert.ok(q.instructions.includes('procedure'));
  return 'runbook-match selftest OK';
}

if (process.argv.includes('--selftest')) { console.log(selftest()); process.exit(0); }

const opt = (n) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? null : process.argv[i + 1]; };
const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }

const books = loadRunbooks();
const questions = buildQuestions(books);
console.log(selftest());
console.log(`${books.length} runbooks with a purpose line -> ${Object.keys(questions).length} questions in one call`);

async function match(task) {
  const t0 = performance.now();
  const { answers, cost } = await askJev(`A task is about to be started. The task: ${task}`, questions, key);
  const ranked = books
    .map((b) => ({ ...b, p: answers[keyFor(b.file)]?.noul ?? 0 }))
    .filter((b) => b.p >= FIRES_AT)
    .sort((x, y) => y.p - x.p);
  return { ranked, ms: performance.now() - t0, cost };
}

// Self-evaluation: each runbook's own purpose line, reworded as a task, should match that runbook.
// Not proof of real-world recall — a purpose line is the easiest possible query — but it catches a
// question set that matches nothing or matches everything, which is the failure worth finding.
if (process.argv.includes('--eval')) {
  const sample = books.filter((_, i) => i % 4 === 0).slice(0, 12);
  let top1 = 0; let inTop3 = 0; let totalHits = 0;
  for (const b of sample) {
    const { ranked } = await match(b.purpose);
    totalHits += ranked.length;
    if (ranked[0]?.file === b.file) top1++;
    if (ranked.slice(0, 3).some((r) => r.file === b.file)) inTop3++;
    console.log(`  ${ranked[0]?.file === b.file ? 'OK  ' : 'MISS'} ${b.file.slice(0, 40).padEnd(40)} `
      + `hits ${String(ranked.length).padStart(2)}  top: ${String(ranked[0]?.file ?? '-').slice(0, 34)}`);
  }
  console.log(`\n  top-1 ${top1}/${sample.length}   in top-3 ${inTop3}/${sample.length}   `
    + `mean hits per query ${(totalHits / sample.length).toFixed(1)}`);
  console.log('  (a high mean means the questions fire on everything and the ranking is doing the work)');
  process.exit(0);
}

const task = opt('task');
if (!task) { console.error('--task "..." or --eval required'); process.exit(1); }
const { ranked, ms, cost } = await match(task);
console.log(`\n  task: ${task}`);
console.log(`  ${ms.toFixed(0)}ms, $${cost.toFixed(6)}\n`);
if (!ranked.length) console.log('  no runbook applies');
for (const r of ranked.slice(0, 8)) {
  console.log(`  ${r.p.toFixed(2)}  ${r.file}`);
  console.log(`        ${r.purpose.slice(0, 100)}`);
}
