#!/usr/bin/env node
// Which runbooks each conversation has already been pointed at.
//
// The router injects on a prompt, resolve.mjs on a skill load, action.mjs on a command. Without a
// shared record a session that pushes three times is handed the same runbook three times. One file
// per scope, where a scope is a session plus, inside a subagent, that subagent: a worker has its
// own context, so what its parent was sent is not something it has read.
//
// PostCompact runs `--clear`: after a compact the injected lines may be gone from context while
// this file still says they were sent.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from './config.mjs';

export const SENT_KEEP_MS = 86_400_000;
// Everything this plugin's PreToolUse hooks keep per session, and the temp file a crashed write
// leaves behind. The router's dedupe files have their own prune.
export const STATE_FILE = /^(sent|triggers)-[0-9a-f]{12}\.json(\.\d+\.tmp)?$/;

const hash12 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

// No session id means no scope, and no scope means no dedupe: every caller without an id would
// otherwise share one file.
export function scopeOf(input) {
  const s = typeof input?.session_id === 'string' ? input.session_id : '';
  if (!s) return null;
  return `${s}\0${typeof input?.agent_id === 'string' ? input.agent_id : ''}`;
}

export const sentFile = (scope, dir = STATE_DIR) => path.join(dir, `sent-${hash12(scope)}.json`);

export function readSent(scope, dir = STATE_DIR) {
  if (!scope) return [];
  try {
    const v = JSON.parse(fs.readFileSync(sentFile(scope, dir), 'utf8'));
    return Array.isArray(v?.files) ? v.files.filter((f) => typeof f === 'string') : [];
  } catch { return []; }
}

export function prune(dir, now) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!STATE_FILE.test(name)) continue;
      const file = path.join(dir, name);
      if (now - fs.statSync(file).mtimeMs > SENT_KEEP_MS) fs.rmSync(file, { force: true });
    }
  } catch { /* housekeeping, never worth failing a tool call over */ }
}

// Write a temp file and rename it over the target, so a reader never sees half a file.
export function writeState(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

// ponytail: last write wins, not a lock. Two hooks on parallel tool calls can both read before
// either writes, and the cost is one runbook line repeated once.
export function claimRunbooks(scope, files, { dir = STATE_DIR, now = Date.now() } = {}) {
  const want = [...new Set(files)];
  if (!scope) return want;
  const had = readSent(scope, dir);
  const fresh = want.filter((f) => !had.includes(f));
  if (!fresh.length) return [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = sentFile(scope, dir);
    if (!fs.existsSync(file)) prune(dir, now);
    writeState(file, { files: [...had, ...fresh], t: now });
  } catch { /* an unwritten ledger repeats a line later, which is cheaper than a failed tool call */ }
  return fresh;
}

export function clearSent(scope, { dir = STATE_DIR } = {}) {
  if (!scope) return;
  try { fs.rmSync(sentFile(scope, dir), { force: true }); } catch { /* nothing to clear */ }
}

const isEntry = () => { try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (isEntry() && process.argv.includes('--clear')) {
  try {
    const { readInput } = await import('./index.mjs');
    clearSent(scopeOf(await readInput()));
  } catch { /* a PostCompact hook never fails a session */ }
}
