#!/usr/bin/env node
// PreToolUse on the shell tools: a command a runbook declares in **Triggers:** brings that
// runbook's path and purpose, once per conversation.
//
// INFORM, NEVER BLOCK. This prints context and nothing else: no permission decision, no rewritten
// input, exit 0 on every path. Claude Code places PreToolUse context beside the tool result, so the
// line is read with the output of the first matching command, not before it. Declare the earliest
// command in a flow for that reason.
//
// IT RUNS ON EVERY SHELL CALL, so the common path is one small file read. The trigger index is
// built on a session's first call (one git spawn, one walk of the runbooks folder) and cached
// under that session's id. A runbook that gains a trigger mid-session is seen by the next one.
// router.mjs is imported only on the build path.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { STATE_DIR, settings } from './config.mjs';
import { parseHeader, parseTriggers, readInput } from './index.mjs';
import { claimRunbooks, prune, scopeOf, writeState } from './session.mjs';

const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\r?\n|$)/g;
// A PowerShell here-string: the opener ends its line, the closer starts one.
const HERESTRING = /@(['"])[ \t]*\n[\s\S]*?\n\1@/g;
const OPERATORS = new Set(['\n', ';', '|', '&', '(', ')']);
// Commands whose quoted argument is itself a command line: `ssh host 'git push'`,
// `bash -lc "git push"`, `powershell.exe -Command "git push"`.
const WRAPPERS = new Set(['ssh', 'bash', 'sh', 'zsh', 'pwsh', 'powershell', 'wsl']);
const MAX_DEPTH = 3;

const binary = (t) => t.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();

function bare(tokens) {
  const out = tokens.filter((t) => !t.startsWith('-'));
  while (out.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0])) out.shift();
  return out;
}

// One pass, no shell. A token that held a quote is dropped from its segment: what is inside
// quotes is an argument's text, and a commit message that mentions a push is not a push. The one
// exception is a wrapper. When one of a segment's first three bare tokens is a shell or ssh, each
// of its fully quoted arguments is read as a command line of its own.
export function segments(command, depth = 0) {
  if (typeof command !== 'string') return [];
  const text = command.replace(/\r\n/g, '\n').replace(HEREDOC, '').replace(HERESTRING, '');
  const out = [];
  let seg = [];
  let inner = [];
  let tok = '';
  let qtext = '';
  let quoted = false;
  let q = null;
  const endTok = () => {
    if (!quoted) { if (tok) seg.push(tok); }
    else if (!tok && qtext.trim()) inner.push(qtext);
    tok = ''; qtext = ''; quoted = false;
  };
  const endSeg = () => {
    endTok();
    const b = bare(seg);
    if (b.length) out.push(b);
    if (depth < MAX_DEPTH && b.slice(0, 3).some((t) => WRAPPERS.has(binary(t)))) {
      for (const s of inner) out.push(...segments(s, depth + 1));
    }
    seg = []; inner = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < text.length) { i += 1; qtext += text[i]; }
      else if (c === q) q = null;
      else qtext += c;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; quoted = true; continue; }
    if (OPERATORS.has(c)) { endSeg(); continue; }
    if (c === ' ' || c === '\t') { endTok(); continue; }
    tok += c;
  }
  // An unclosed quote swallows the rest, which is what a shell would do with it.
  if (q) { tok = ''; qtext = ''; quoted = true; }
  endSeg();
  return out;
}

export function matches(words, segment) {
  if (!words.length) return false;
  const first = words[0].toLowerCase();
  for (let i = 0; i < Math.min(3, segment.length); i += 1) {
    if (binary(segment[i]) !== first) continue;
    const rest = segment.slice(i + 1, i + 1 + words.length + 1);
    let at = 0;
    for (const w of words.slice(1)) {
      const found = rest.indexOf(w, at);
      if (found < 0) { at = -1; break; }
      at = found + 1;
    }
    if (at >= 0) return true;
  }
  return false;
}

export function buildTriggers(books, dir) {
  return books.flatMap((b) => parseTriggers(b.triggers).map((words) => ({
    words, rel: b.file, path: path.join(dir, b.file).replace(/\\/g, '/'), purpose: b.purpose })));
}

export function matchCommand(command, triggers) {
  if (!triggers.length) return [];
  const segs = segments(command);
  const out = [];
  for (const t of triggers) {
    if (out.some((o) => o.rel === t.rel)) continue;
    if (segs.some((s) => matches(t.words, s))) out.push(t);
  }
  return out;
}

// Keyed on the session and the working folder together: the runbooks folder is resolved from the
// cwd, so a session that moves between repos builds once per folder instead of keeping the first.
export const triggersFile = (sessionId, cwd, dir = STATE_DIR) => path.join(dir,
  `triggers-${crypto.createHash('sha1').update(`${sessionId}\0${cwd}`).digest('hex').slice(0, 12)}.json`);

async function build(cwd) {
  const cfg = settings({ cwd });
  if (!cfg.dir) return [];
  const { RB_KEEP, loadCorpus, parse } = await import('./router.mjs');
  // loadCorpus, so a retired, dormant or archived runbook triggers exactly as often as it routes.
  const books = loadCorpus(cfg.dir, (text, file) => ({ ...parse(text, file), triggers: parseHeader(text).triggers }), RB_KEEP);
  return buildTriggers(books, cfg.dir);
}

async function loadTriggers(input) {
  const sid = typeof input.session_id === 'string' ? input.session_id : '';
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const file = sid ? triggersFile(sid, cwd) : null;
  if (file) {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(v?.triggers)) return v.triggers;
    } catch { /* absent or broken: build it */ }
  }
  const triggers = await build(cwd);
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      prune(path.dirname(file), Date.now());
      writeState(file, { triggers });
    } catch { /* an unwritten cache costs the next call a rebuild */ }
  }
  return triggers;
}

async function main() {
  const input = await readInput();
  const command = input.tool_input?.command;
  if (typeof command !== 'string' || !command.trim()) return;
  const hits = matchCommand(command, await loadTriggers(input));
  if (!hits.length) return;
  const fresh = claimRunbooks(scopeOf(input), hits.map((h) => h.rel));
  const lines = hits.filter((h) => fresh.includes(h.rel)).map((h) => `- ${h.path} — ${h.purpose}`);
  if (!lines.length) return;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
    additionalContext: `Runbooks that govern this command (read before the next one like it):\n${lines.join('\n')}` } }));
}

const isEntry = () => { try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (isEntry()) {
  try { await main(); } catch { /* a hook on every shell call never fails one */ }
}
