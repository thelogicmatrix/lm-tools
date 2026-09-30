#!/usr/bin/env node
// A skill declares the topics where a host's own runbooks apply. This resolves them to paths.
//
//   node <plugin>/scripts/resolve.mjs --skill <name> [--paths | --inject] [--at <step>] [--skills-dir <dir>]
//   node <plugin>/scripts/resolve.mjs --changed
//
// A topic is a phrase in a reader's words, not a file name, because another host has other slugs.
// .runbooks/topics.json maps each topic to a runbook. A topic with no entry is scored once through
// find.mjs's judge (one paid call) and written at or above the write bar. Under the bar it prints
// `unresolved:` and the exit is 1, so a bad match is loud. An entry needs only a `slug`, so a host
// can map a topic by hand.
//
// --changed re-scores the entries whose runbook purpose moved since they were written.
//
// Exit 0 resolved or nothing to do, 1 something unresolved, 2 a usage or file error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExtensions, projectRoot, settings } from './config.mjs';
import { judge, slash } from './find.mjs';
import { purposeHash } from './ledger.mjs';
import { loadAll, readKey } from './router.mjs';
import { claimRunbooks, scopeOf } from './session.mjs';
import { parseArgs } from './lib/args.mjs';
import { fail, isMain } from './lib/exit.mjs';

export const slugOf = (file) => slash(file).replace(/\.md$/, '');
export const topicKey = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
// Every topic lands as an own key. `map['__proto__'] = v` calls the prototype setter instead, so
// saveTopics never saw the entry and the topic was judged, and paid for, on every run.
const setOwn = (map, key, value) => Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
// A value in one pair of matching quotes is taken as written. Unquoted, a value that opens a flow
// list or map, a block scalar, an anchor, an alias or a tag, or that carries an inline comment,
// means something else to a YAML reader, so it is refused (null) rather than read as text:
// `at: [landing, audit]` read as text gave the steps "[landing" and "audit]", which no --at matches.
const readValue = (s) => {
  const v = s.trim();
  const q = /^(['"])(.*)\1$/.exec(v);
  if (q) return q[2];
  return /^[[{>|&*!]/.test(v) || /[ \t]#/.test(v) ? null : v;
};

// The block is a fixed shape, so this reads that shape and nothing else: `runbooks:` at column 0
// inside the frontmatter, then `- topic: <text>` items, each with an optional `at: a, b` line. No
// YAML library, and anything outside the shape is an error rather than a guess.
export function parseRunbooksBlock(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!fm) return { topics: [], errors: [] };
  const rows = fm[1].split(/\r?\n/);
  const start = rows.findIndex((l) => /^runbooks:[ \t]*$/.test(l));
  if (start < 0) {
    return { topics: [], errors: rows.some((l) => /^runbooks:/.test(l)) ? ['runbooks: must be a list, one "- topic:" per item'] : [] };
  }
  const topics = [];
  const errors = [];
  const unsupported = (line) => `unsupported value in runbooks: "${line.trim()}", write plain text or quote it`;
  // The item an `at:` line belongs to. `entry` is null when its topic was refused, so the steps
  // under a refused topic never land on the topic before it.
  let item = null;
  for (const line of rows.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key ends the block
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const top = /^\s+-\s+topic:\s*(\S.*)$/.exec(line);
    const at = /^\s+at:\s*(.*)$/.exec(line);
    if (top) {
      const v = readValue(top[1]);
      const entry = v === null ? null : { topic: topicKey(v), at: [] };
      if (entry) topics.push(entry);
      else errors.push(unsupported(line));
      item = { entry, name: entry ? entry.topic : topicKey(top[1]), hasAt: false };
    } else if (at && item) {
      const v = readValue(at[1]);
      if (item.hasAt) errors.push(`second at: for topic "${item.name}"`);
      else if (v === null) errors.push(unsupported(line));
      else if (item.entry) item.entry.at = v.split(',').map((s) => s.trim()).filter(Boolean);
      item.hasAt = true;
    } else errors.push(`unreadable line in runbooks: "${line.trim()}"`);
  }
  if (!topics.length) errors.push('runbooks: declares no topic');
  const seen = new Set();
  for (const t of topics) {
    if (seen.has(t.topic)) errors.push(`duplicate topic "${t.topic}"`);
    seen.add(t.topic);
  }
  return { topics, errors };
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const list = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const semver = (v) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? [-1, -1, -1];
const byVersion = (a, b) => { const x = semver(a), y = semver(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
// The name arrives from a tool call. One path segment, or it is not a skill name.
const segment = (s) => typeof s === 'string' && s !== '' && !/[\\/:]/.test(s) && !/^\.+$/.test(s);

// ponytail: an unprefixed name held by two plugins resolves to the higher version number, and the
// newest cached version is taken as the installed one. Read installed_plugins.json if either is
// ever measured to pick the wrong file.
export function findSkill(name, { cwd = process.cwd(), home = os.homedir(),
  configDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), skillsDir = null } = {}) {
  if (typeof name !== 'string') return null;
  const parts = name.split(':');
  if (parts.length > 2 || !parts.every(segment)) return null;
  const plugin = parts.length === 2 ? parts[0] : null;
  const skill = parts[parts.length - 1];
  const direct = [];
  if (skillsDir) direct.push(path.join(skillsDir, skill, 'SKILL.md'));
  if (!plugin) {
    const top = projectRoot(cwd);
    direct.push(path.join(top, '.claude', 'skills', skill, 'SKILL.md'),
      path.join(top, '.agents', 'skills', skill, 'SKILL.md'),
      path.join(configDir, 'skills', skill, 'SKILL.md'));
  }
  const hit = direct.find(isFile);
  if (hit) return hit;
  const cache = path.join(configDir, 'plugins', 'cache');
  const found = [];
  for (const market of list(cache)) {
    for (const plug of list(path.join(cache, market))) {
      if (plugin && plug !== plugin) continue;
      for (const version of list(path.join(cache, market, plug))) {
        const p = path.join(cache, market, plug, version, 'skills', skill, 'SKILL.md');
        if (isFile(p)) found.push({ p, version });
      }
    }
  }
  found.sort((x, y) => byVersion(y.version, x.version));
  return found[0]?.p ?? null;
}

export const topicsFile = (root) => path.join(root, 'topics.json');

// A missing file is an empty map. A file that is there and unreadable is NOT: reading it as empty
// would re-judge every topic and write over a hand edit with one typo in it.
export function loadTopics(root) {
  if (!root) return {};
  let raw;
  try { raw = fs.readFileSync(topicsFile(root), 'utf8'); } catch { return {}; }
  let v;
  try { v = JSON.parse(raw); } catch { v = undefined; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw Object.assign(new Error(`${slash(topicsFile(root))} is not a JSON object, fix it by hand`), { code: 'BAD_TOPICS' });
  }
  return v;
}

export function saveTopics(root, map) {
  const sorted = Object.fromEntries(Object.keys(map).sort().map((k) => [k, map[k]]));
  const file = topicsFile(root);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sorted, null, 1) + '\n');
  fs.renameSync(tmp, file);
}

export async function resolveTopics(topics, { map, books, judgeFn = null, writeBar, today, onMapped = () => {} }) {
  const bySlug = new Map(books.map((b) => [slugOf(b.file), b]));
  const resolved = [];
  const unresolved = [];
  for (const t of topics) {
    // Own keys only, so a topic named `constructor` or `__proto__` is not read off Object.prototype.
    const e = Object.hasOwn(map, t.topic) ? map[t.topic] : undefined;
    const book = e && typeof e.slug === 'string' ? bySlug.get(e.slug) : undefined;
    if (book) { resolved.push({ ...t, book, p: e.score }); continue; }
    if (!judgeFn) {
      unresolved.push({ ...t, why: e ? `mapped to ${e.slug}, which is not a live runbook` : 'not mapped' });
      continue;
    }
    const j = await judgeFn(t.topic);
    const best = j.ranked[0];
    const won = j.ok && best && best.p >= writeBar ? books.find((b) => b.file === best.file) : undefined;
    if (won) {
      setOwn(map, t.topic, { slug: slugOf(won.file), score: +best.p.toFixed(2), purpose: purposeHash(won.purpose), checked: today });
      // Saved per topic, so a call that fails later in the list loses no score already paid for.
      onMapped(map);
      resolved.push({ ...t, book: won, p: best.p });
    } else if (!j.ok) unresolved.push({ ...t, why: `no score (${j.why})` });
    else if (!best) unresolved.push({ ...t, why: 'nothing scored' });
    else unresolved.push({ ...t, why: `best was ${slugOf(best.file)} at ${best.p.toFixed(2)}, under ${writeBar}` });
  }
  return { resolved, unresolved };
}

function judgeWith(cfg, books) {
  const key = readKey();
  return (topic) => judge(topic, books, key, fetch,
    { firesAt: cfg.firesAt, maxInject: cfg.maxInject, shortlist: cfg.shortlist, target: 'topic' });
}

async function changed(cfg, books) {
  const map = loadTopics(cfg.root);
  const bySlug = new Map(books.map((b) => [slugOf(b.file), b]));
  const moved = Object.keys(map).filter((k) => {
    const b = bySlug.get(map[k]?.slug);
    return b && map[k].purpose && map[k].purpose !== purposeHash(b.purpose);
  });
  console.log(`${Object.keys(map).length} topics, ${moved.length} whose runbook purpose moved`);
  const judgeFn = judgeWith(cfg, books);
  let stale = 0;
  for (const [i, topic] of moved.entries()) {
    console.log(`[${i + 1}/${moved.length}] ${topic}`);
    const trial = {};
    const r = await resolveTopics([{ topic, at: [] }], { map: trial, books, judgeFn, writeBar: cfg.writeBar,
      today: new Date().toISOString().slice(0, 10) });
    const won = Object.hasOwn(trial, topic) ? trial[topic] : undefined;
    if (r.resolved.length) { setOwn(map, topic, won); saveTopics(cfg.root, map); console.log(`  ${won.slug} at ${won.score}`); }
    // The entry stays. It is reported, and whoever reads the report decides.
    else { stale += 1; console.log(`  stale: ${r.unresolved[0].why}`); }
  }
  process.exitCode = stale ? 1 : 0;
}

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resolveCommand = (name) => `node "${slash(path.join(PLUGIN, 'scripts', 'resolve.mjs'))}" --skill ${name}`;

// One line per runbook. Two topics that land on the same runbook merge their steps.
export function skillBlock(name, resolved, unresolved, dir, command) {
  const byFile = new Map();
  for (const r of resolved) {
    const e = byFile.get(r.book.file) ?? { book: r.book, at: [] };
    for (const s of r.at) if (!e.at.includes(s)) e.at.push(s);
    byFile.set(r.book.file, e);
  }
  const out = [];
  if (byFile.size) {
    out.push(`Runbooks for the ${name} skill (read each before the step named beside it):`);
    for (const { book, at } of byFile.values()) {
      out.push(`- ${slash(path.join(dir, book.file))}${at.length ? ` (at: ${at.join(', ')})` : ''} — ${book.purpose}`);
    }
  }
  const n = unresolved.length;
  if (n) out.push(`${n} topic${n === 1 ? '' : 's'} of the ${name} skill ${n === 1 ? 'is' : 'are'} not mapped to a runbook. Map ${n === 1 ? 'it' : 'them'} once: ${command}`);
  return out.join('\n');
}

// Every skill the lint grades: the project's own, and the newest cached version of each plugin's.
// `cached` marks a plugin's skill, whose block the host did not write and cannot edit.
function skillFiles(top, configDir) {
  const out = [];
  for (const kind of ['.claude', '.agents']) {
    for (const s of list(path.join(top, kind, 'skills'))) {
      const p = path.join(top, kind, 'skills', s, 'SKILL.md');
      if (isFile(p) && !out.some((o) => o.name === s)) out.push({ name: s, file: p, cached: false });
    }
  }
  const cache = path.join(configDir, 'plugins', 'cache');
  for (const market of list(cache)) {
    for (const plug of list(path.join(cache, market))) {
      const newest = list(path.join(cache, market, plug)).sort(byVersion).pop();
      if (!newest) continue;
      for (const s of list(path.join(cache, market, plug, newest, 'skills'))) {
        const p = path.join(cache, market, plug, newest, 'skills', s, 'SKILL.md');
        if (isFile(p)) out.push({ name: `${plug}:${s}`, file: p, cached: true });
      }
    }
  }
  return out;
}

// No call is made here. The lint says what is unmapped and names the command that maps it.
// The lint fails only on what the host can fix. A plugin's malformed block or unmapped topic is
// advisory: the host cannot edit the block, and may have no runbook for the topic, so a failure
// there could only be cleared by uninstalling the plugin or mapping the topic to something
// unrelated. A dead mapping is a violation wherever the skill lives, because the map entry is the
// host's own and a renamed or retired runbook has to turn the lint red.
export function skillViolations({ top, configDir, root, books }) {
  let map;
  try { map = loadTopics(root); } catch (e) { return { violations: [e.message], advisories: [] }; }
  const live = new Set(books.map((b) => slugOf(b.file)));
  const violations = [];
  const advisories = [];
  for (const { name, file, cached } of skillFiles(top, configDir)) {
    let block;
    try { block = parseRunbooksBlock(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const soft = cached ? advisories : violations;
    for (const e of block.errors) soft.push(`skill ${name}: ${e}`);
    for (const t of block.topics) {
      // Own keys only, as in resolveTopics, so a topic named `constructor` is not read off Object.prototype.
      const e = Object.hasOwn(map, t.topic) ? map[t.topic] : undefined;
      if (!e) soft.push(`skill ${name}: topic "${t.topic}" is not mapped`);
      else if (!live.has(e.slug)) violations.push(`skill ${name}: topic "${t.topic}" is mapped to ${e.slug}, which is not a live runbook`);
    }
  }
  return { violations, advisories };
}

async function hookMain() {
  const { readInput, runNudges } = await import('./index.mjs');
  const input = await readInput();
  if (input.tool_name !== 'Skill') return;
  const name = input.tool_input?.skill;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const cfg = settings({ cwd });
  if (!cfg.dir) return;
  const file = findSkill(name, { cwd });
  if (!file) return;
  const block = parseRunbooksBlock(fs.readFileSync(file, 'utf8'));
  if (block.errors.length || !block.topics.length) return; // a malformed block is the lint's to report
  const books = loadAll(cfg.dir);
  // Map only. A paid call inside a hook would cost a second per unmapped topic on a skill load.
  const { resolved, unresolved } = await resolveTopics(block.topics, { map: loadTopics(cfg.root), books,
    judgeFn: null, writeBar: cfg.writeBar, today: '' });
  claimRunbooks(scopeOf(input), resolved.map((r) => r.book.file));
  const nudges = await runNudges(loadExtensions(cfg.root, 'skill-nudges'),
    { skill: name, topics: block.topics, resolved: resolved.map((r) => ({ topic: r.topic, at: r.at, file: r.book.file })) }, 500);
  const text = [skillBlock(name, resolved, unresolved, cfg.dir, resolveCommand(name)), ...nudges].filter(Boolean).join('\n');
  if (!text) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }) + '\n',
    () => process.exit());
}

async function main(argv) {
  const { flags } = parseArgs(argv, { boolean: ['hook', 'changed', 'inject'] });
  const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
  const cfg = settings({ cwd: process.cwd() });
  if (flags.changed === true) {
    if (!cfg.dir || !cfg.root) return;
    return changed(cfg, loadAll(cfg.dir));
  }
  const name = str(flags.skill);
  if (!name) return fail('usage: resolve.mjs --skill <name> [--paths | --inject] [--at <step>] [--skills-dir <dir>]  |  --changed');
  if (!cfg.dir) return; // no runbooks folder: silent
  const file = findSkill(name, { cwd: process.cwd(), skillsDir: str(flags['skills-dir']) });
  if (!file) return fail(`resolve: no skill named ${name}`);
  const block = parseRunbooksBlock(fs.readFileSync(file, 'utf8'));
  if (block.errors.length) return fail(block.errors.map((e) => `${name}: ${e}`).join('\n'));
  const step = str(flags.at);
  const topics = step ? block.topics.filter((t) => t.at.includes(step)) : block.topics;
  if (!topics.length) return;
  const books = loadAll(cfg.dir);
  const map = loadTopics(cfg.root);
  let mapped = 0;
  const { resolved, unresolved } = await resolveTopics(topics, { map, books, judgeFn: judgeWith(cfg, books),
    writeBar: cfg.writeBar, today: new Date().toISOString().slice(0, 10),
    onMapped: (m) => { mapped += 1; if (cfg.root) saveTopics(cfg.root, m); } });
  if (!cfg.root && mapped) {
    console.error('resolve: no .runbooks/ folder, so nothing was cached and the next run pays again');
  }
  const files = [...new Set(resolved.map((r) => r.book.file))];
  if (flags.inject === true) {
    // Trailing whitespace trimmed, so each file is followed by exactly one blank line whether or not
    // it ends in a newline.
    for (const f of files.slice(0, cfg.maxInject)) {
      console.log(`## ${slash(path.join(cfg.dir, f))}\n${fs.readFileSync(path.join(cfg.dir, f), 'utf8').trimEnd()}\n`);
    }
  } else {
    for (const f of files) console.log(slash(path.join(cfg.dir, f)));
  }
  for (const u of unresolved) console.error(`unresolved: ${u.topic} (${u.why})`);
  if (unresolved.length) process.exitCode = 1;
}

if (isMain(import.meta.url) && process.argv.includes('--hook')) {
  try { await hookMain(); } catch { /* a hook never fails a skill load */ }
} else if (isMain(import.meta.url)) {
  try { await main(process.argv.slice(2)); } catch (e) { fail(`resolve: ${e.message}`); }
}
