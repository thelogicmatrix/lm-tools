#!/usr/bin/env node
// Which runbooks cover this phrase? The core the skill resolver sits on, and a command a session
// can run by hand.
//
//   node <plugin>/scripts/find.mjs "<phrase>" [--judge] [--json]
//
// DEFAULT: local and free. BM25 over filename and purpose (prefilter.mjs), best first, then every
// standard. No key, no network. The router needs a model to judge its shortlist because a hook has
// no reader. Here the caller is a model and judges the list itself.
//
// Every standard rides along for the reason router.mjs's narrow() gives: a word matcher cannot
// find a rule that shares no vocabulary with the task, and a standard is a rule you must not break.
//
// --judge: the paid score through route(), about $0.0004. For callers with no reader to judge a
// shortlist: resolve.mjs mapping a skill's topics, and the lint.
import path from 'node:path';
import { isMain } from './lib/exit.mjs';
import { settings } from './config.mjs';
import { buildIndex, rank } from './prefilter.mjs';
import { loadAll, readKey, route } from './router.mjs';

export const FIND_N = 8;

export const slash = (p) => String(p).replace(/\\/g, '/');

export function find(phrase, books, n = FIND_N) {
  if (!String(phrase ?? '').trim() || !books.length) return [];
  // Unlike the router's shortlist this drops a zero score: padding exists to fill a judge's
  // window, and a reader gains nothing from a document that shares no word with the phrase.
  const top = rank(phrase, buildIndex(books)).filter((x) => x.s > 0).slice(0, n).map((x) => x.b);
  const seen = new Set(top.map((b) => b.file));
  return [...top, ...books.filter((b) => b.type === 'standard' && !seen.has(b.file))];
}

export const lines = (books, dir) => books.map((b) => `${slash(path.join(dir, b.file))}\t${b.purpose}`);

export async function judge(phrase, books, key, fetchImpl = fetch, opts = {}) {
  const { target = null, ...routeOpts } = opts;
  const r = await route(phrase, books, key, fetchImpl, { ...routeOpts, spend: { activity: 'topic_resolve', target } });
  return r.mode === 'matched'
    ? { ok: true, ranked: r.ranked ?? [] }
    : { ok: false, why: r.why ?? r.mode, ranked: [] };
}

async function main(argv) {
  const phrase = argv.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!phrase) { console.error('usage: find.mjs "<phrase>" [--judge] [--json]'); process.exitCode = 2; return; }
  const cfg = settings({ cwd: process.cwd() });
  if (!cfg.dir) return; // no runbooks folder: silent, like every other entry point
  const books = loadAll(cfg.dir);
  let found;
  if (argv.includes('--judge')) {
    const j = await judge(phrase, books, readKey(), fetch,
      { firesAt: cfg.firesAt, maxInject: cfg.maxInject, shortlist: cfg.shortlist });
    if (!j.ok) { console.error(`find: no score (${j.why})`); process.exitCode = 1; return; }
    found = j.ranked.filter((r) => r.p >= cfg.firesAt)
      .map((r) => ({ ...books.find((b) => b.file === r.file), p: r.p }));
  } else {
    found = find(phrase, books);
  }
  if (!found.length) { process.exitCode = 1; return; }
  if (argv.includes('--json')) {
    console.log(JSON.stringify(found.map((b) => ({ path: slash(path.join(cfg.dir, b.file)), type: b.type,
      purpose: b.purpose, ...(b.p === undefined ? {} : { p: b.p }) }))));
  } else {
    for (const l of lines(found, cfg.dir)) console.log(l);
  }
}

if (isMain(import.meta.url)) await main(process.argv.slice(2));
