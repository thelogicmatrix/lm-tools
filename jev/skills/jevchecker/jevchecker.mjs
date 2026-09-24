#!/usr/bin/env node
// jevchecker: sweep a large body for a nuanced criterion, cheaply.
//
// It produces a SIGNAL, NOT A VERDICT. A hit means "worth looking at", never "this is wrong".
// That is why it exits 0 whenever the sweep ran, whatever it found: a non-zero exit would make
// candidates look like errors and invite wiring this into a gate, which is the one thing it must
// not become. Callers wanting a gate read the JSON and decide, having seen the values. A sweep that
// chunked nothing, or in which the model answered nothing at all, did not run, so those exit 1.
//
//   jevchecker.mjs <body> --sweep <sweep.json> [--source <file>] [--json <out>] [--text]
//   jevchecker.mjs --selftest
import fs from 'node:fs';
import path from 'node:path';
import { runSweep, modelChecks, BUDGET } from './lib/engine.mjs';
import { readKey } from '../../scripts/lib.mjs';

const opt = (n) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? null : process.argv[i + 1]; };

if (process.argv.includes('--selftest')) {
  const { selftest } = await import('./jevchecker.test.mjs');
  console.log(await selftest());
  // Safe here and nowhere else in this file: the self-check runs an injected fake and opens no
  // socket, so there is nothing still closing for libuv to abort on.
  process.exit(0);
}

// The body is the first argument that is neither a flag nor a flag's value, so `--sweep s.json body`
// finds `body` rather than reading a file called `--sweep`.
const VALUED = ['--sweep', '--source', '--json'];
const bodyPath = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && !VALUED.includes(all[i - 1]));
const sweepPath = opt('sweep');
// Exit 1 is for the sweep NOT RUNNING. It is never used for what a sweep found.
const usage = 'usage: jevchecker.mjs <body> --sweep <sweep.json> [--source <file>] [--json <out>] [--text]';
if (!bodyPath || !sweepPath) { console.error(usage); process.exit(1); }
// `--json` with no value would be silently ignored and the copy never written. And `--json` naming
// the body or the source overwrites the input with the output.
const jsonOut = opt('json');
if (process.argv.includes('--json') && (!jsonOut || jsonOut.startsWith('--'))) { console.error(usage); process.exit(1); }
// Compared case-insensitively on Windows, where `Body.txt` and `body.TXT` are the same file.
const same = (a, b) => (process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
if (jsonOut && [bodyPath, sweepPath, opt('source')].some((p) => p && same(p, jsonOut))) {
  console.error(`--json ${jsonOut} is also an input, and writing the results there would overwrite it`);
  process.exit(1);
}

// One plain line and exit 1, rather than a Node stack. The exit code is the same either way, so
// this is only about what the person running it reads: an ENOENT above eight frames of internal
// paths says what the line below says, and buries it.
//
// \u26A0 THE ENCODING IS READ OFF THE BOM, NOT ASSUMED. Windows PowerShell writes UTF-16LE with `>` and
// by default with `Out-File`, and UTF-8 with a BOM when asked. Read as UTF-8, a UTF-16 file is
// interleaved NULs that no pattern matches, so a sweep over it comes back clean. UTF-16LE is
// decoded, UTF-16BE refuses, and a NUL left after decoding means a binary or unmarked UTF-16 file.
const read = (file, what) => {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) {
    console.error(`cannot read the ${what} at ${file} (${e.code ?? e.message})`);
    process.exit(1);
  }
  let text;
  if (buf[0] === 0xFF && buf[1] === 0xFE) text = buf.subarray(2).toString('utf16le');
  else if (buf[0] === 0xFE && buf[1] === 0xFF) { console.error(`the ${what} at ${file} is UTF-16BE, save it as UTF-8`); process.exit(1); }
  else text = buf.toString('utf8').replace(/^\uFEFF/, '');
  if (text.includes('\0')) { console.error(`the ${what} at ${file} contains NUL characters (binary, or UTF-16 without a BOM), save it as UTF-8`); process.exit(1); }
  return text;
};
const parse = (text, file, what) => {
  try { return JSON.parse(text); } catch (e) {
    console.error(`the ${what} at ${file} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
};

const sweep = parse(read(sweepPath, 'sweep file'), sweepPath, 'sweep file');
// After the sweep is read, because a regex-only sweep makes no call and needs no key.
const key = modelChecks(sweep).length ? readKey() : null;
if (modelChecks(sweep).length && !key) { console.error('no OPENROUTER_API_KEY in the environment and none in ~/.jev.env'); process.exit(1); }
const raw = read(bodyPath, 'body');
// A SNIFF, WITH AN OVERRIDE. A jsonpath sweep needs a parsed body and a lines or paragraphs sweep
// needs the raw text, and the file extension does not reliably say which. Sniffing the first
// non-space character gets it right for every JSON document and wrong for a markdown file that
// opens on a link, `[see the spec](...)`, which then exits 1 with a JSON parse error over a body
// that was never JSON. `--text` is the way out. Falling back to raw text on a parse failure would
// be worse: a genuinely malformed JSON body would then be swept as a wall of text and report
// candidates, which is this tool's own failure class.
const body = !process.argv.includes('--text') && /^\s*[{[]/.test(raw) ? parse(raw, bodyPath, 'body') : raw;
// A source the sweep never sends would be read and dropped, while a question about "the source"
// runs against a prompt that has none. Refused, the mirror of the include_source-with-no-source rule.
if (opt('source') && !sweep?.state?.include_source) {
  console.error(`--source was given but this sweep does not set state.include_source, so the source would never reach the model`);
  process.exit(1);
}
const source = opt('source') ? read(opt('source'), 'source') : null;

// The pre-flight rejections land here, and they are the same class as the read errors above: the
// sweep file or the command line is wrong, nothing has been spent, and the person is at a shell.
// Eight frames of internal paths over a line saying `--source` is missing buries the one thing they
// need. Exit 1 is honest here because the sweep did NOT run, which is the only thing exit 1 means.
// `process.exit` is safe in this branch for the reason it is safe in read(): every fault that
// reaches it is found before a socket is opened, and the line has already been written to stderr.
let r;
try {
  r = await runSweep(body, sweep, source, key, {
    onDone: (d, t) => process.stderr.write(`  [${d}/${t}] calls\n`),
  });
} catch (e) {
  console.error(`the sweep did not run: ${e.message}`);
  process.exit(1);
}

console.log(`\n${sweep.name}: ${r.chunks} chunks, ${r.calls} calls, $${r.cost.toFixed(6)}`);
// The source rides in every call, so a big one leaves little room to pack and is re-sent each time.
// Warned after packing, when the call count shows it happened, rather than only at the budget.
if (source && r.calls > 1 && source.length > BUDGET / 2) {
  console.log(`  warning: the ${source.length}-character source was sent with each of the ${r.calls} calls, and it is over half the ${BUDGET}-character budget`);
}
// ⚠ A PARTIAL DROP PRINTS LIKE A WHOLE SWEEP. The chunker discards blanks and `[object Object]`
// on purpose, but NOTHING SWEPT only fires at zero, so a chunk spec that picks up half a body is
// invisible in every other line of this output. Most drops are legitimate (empty description
// fields) and the count is the only way to tell the legitimate ones from a spec landing a segment
// short. Printed only when non-zero, because a permanent `0 dropped` is noise nobody reads.
if (r.dropped) console.log(`  ${r.dropped} dropped before the sweep as blank or unrenderable (legitimate for empty fields; a large number means the chunk spec is off)`);
// ⚠ NOTHING SWEPT IS NOT A CLEAN SWEEP. A mistyped JSONPath matches no text, and "0 candidates to
// read" over zero chunks reads as a verdict on a body nothing ever looked at. Same class as an
// unanswered question being printed as clean.
if (r.chunks === 0) console.log('\nNOTHING SWEPT (not a clean result): the chunk spec matched no text in this body, so nothing was ever looked at. Check the chunk spec against the body.');
else console.log(`\n${r.hits.length} candidate${r.hits.length === 1 ? '' : 's'} to read:`);
for (const h of r.hits) {
  console.log(`  ${h.checkId.padEnd(14)} ${h.value === null ? 'regex' : h.value.toFixed(2)}  ${h.path}`);
  console.log(`      ${h.text.slice(0, 140)}`);
}
if (r.torn.length) {
  // Separate on purpose. "The model was torn" is different information from "this is fine", and a
  // cluster here means the check is badly worded rather than the body being wrong.
  console.log(`\n${r.torn.length} torn (the check may be the problem, not the text):`);
  for (const t of r.torn) console.log(`  ${t.checkId.padEnd(14)} ${t.value.toFixed(2)}  ${t.path}`);
}
if (r.unanswered.length) {
  console.log(`\n${r.unanswered.length} UNANSWERED (treated as candidates, not as clean):`);
  for (const u of r.unanswered) console.log(`  ${u.checkId.padEnd(14)} ${u.path}${u.error ? `  (${u.error})` : ''}`);
}
// ⚠ EVERY QUESTION UNANSWERED IS A SWEEP THAT DID NOT RUN. A bad key or an outage fails every call,
// and the lines above then read "0 candidates to read" over a body nothing judged. Said in a banner
// and exit 1, the same class as NOTHING SWEPT. Some unanswered is still exit 0: the rest ran.
const nothingAnswered = r.asked > 0 && r.unanswered.length === r.asked;
if (nothingAnswered) console.log(`\nNOTHING ANSWERED (not a clean result): all ${r.asked} model questions failed, so no chunk was judged. The reason is on each row above.`);
// Wrapped, and NOT exit 1, unlike the read() helper above. This runs after the sweep has been paid
// for and after every result has already printed, so the only thing an unwritable path loses is the
// copy. Throwing here would exit 1 with a stack over a run that succeeded, which is exactly the
// "exits 0 whenever the sweep ran" promise at the top of this file.
if (jsonOut) {
  try {
    fs.writeFileSync(jsonOut, JSON.stringify(r, null, 2));
    console.log(`\nwritten to ${jsonOut}`);
  } catch (e) {
    console.error(`\ncannot write the JSON output to ${jsonOut} (${e.code ?? e.message}). The results above are complete, only the file was lost.`);
  }
}
// ⚠ NOT process.exit(). The HTTP socket is still closing and Windows libuv aborts on that with
// exit 127, after the output has already printed. Measured in scripts/jev-sweep/jevclick.mjs.
// Exit 1 on either banner: NOTHING SWEPT and NOTHING ANSWERED are both a sweep that did not run.
process.exitCode = nothingAnswered || r.chunks === 0 ? 1 : 0;
