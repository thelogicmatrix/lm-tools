// The per-call journal. Each model call's answers are appended to disk the moment the call lands,
// so a sweep killed midway or partly failed keeps everything it paid for, and `--resume` asks only
// the rows still unanswered.
//
// The file is named by a hash of exactly what the answers depend on: every chunk's id and text,
// the model checks and the source that rides in the state. A different body, sweep or source is a
// different file, so a resume can never pair an old answer with a new question.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sweepId = (chunks, checks, source) => crypto.createHash('sha256')
  .update(JSON.stringify({ chunks: chunks.map((c) => [c.id, c.text]), checks, source: source ?? null }))
  .digest('hex').slice(0, 16);

// One JSON line per landed call: `{ answers, cost }`. Without `resume` the file starts empty. With
// it, every answer already on disk comes back in `prior`, and the caller decides which are valid.
//
// ⚠ A JOURNAL THAT CANNOT BE WRITTEN NEVER STOPS THE SWEEP. The calls are already being paid for,
// so a full disk or a read-only directory costs the ability to resume and nothing else. It says so
// once. A line cut short by a kill mid-write is skipped on read, and the calls before it still count.
export function openJournal(file, { resume = false, warn = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const prior = {};
  if (resume) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.answers && typeof row.answers === 'object') Object.assign(prior, row.answers);
    }
  }
  let broken = false;
  const write = (fn) => {
    if (broken) return;
    try { fn(); } catch (e) {
      broken = true;
      warn(`jevchecker: cannot write the journal at ${file} (${e.code ?? e.message}), so this run cannot be resumed`);
    }
  };
  write(() => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!resume) fs.writeFileSync(file, '');
  });
  return {
    file,
    prior,
    append: (answers, cost) => write(() => fs.appendFileSync(file, `${JSON.stringify({ answers, cost })}\n`)),
    remove: () => write(() => fs.rmSync(file, { force: true })),
  };
}
