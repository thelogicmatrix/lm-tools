#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const SAFE = /^[A-Za-z0-9_-]+$/;

// Throws rather than exiting, matching sprintPath and trackFile. main() turns any thrown
// Error into die(2, message), so all three input guards behave identically at the CLI edge
// and all three stay testable in-process.
export function slugify(s) {
  const out = String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!out) throw new Error(`cannot slugify ${JSON.stringify(s)} into a usable name`);
  return out;
}

export function die(code, msg) {
  console.error(`learn: ${msg}`);
  process.exit(code);
}

// Every path segment is checked before it reaches join(). Untrusted-ish input reaching
// path.join is a traversal waiting to happen.
export function sprintPath(root, slug) {
  if (!SAFE.test(slug)) throw new Error(`invalid slug ${JSON.stringify(slug)}`);
  return join(root, '.learn', 'sprints', `${slug}.json`);
}

export function readSprint(root, slug) {
  const p = sprintPath(root, slug);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function writeSprint(root, sprint) {
  const p = sprintPath(root, sprint.slug);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(sprint, null, 2)}\n`);
}

export function resolveRoot() {
  if (process.env.LEARN_HUB) return process.env.LEARN_HUB;
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return die(2, 'no LEARN_HUB set and not inside a git repo. Set LEARN_HUB or run from a repo.');
  }
}

export const colour = (s) =>
  process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[36m${s}\u001b[0m` : s;

function help() {
  console.log(`learn — self-directed learning sprints

  learn tracks                    list available tracks
  learn start <subject> --track <name>
  learn week                      what week, what concept, what is due
  learn gate <pass|fail> [--verified]
  learn page <concept>            stamp the week-N reference page
  learn brief                     write a logical-research corpus brief (body on stdin)
  learn profile                   read the learner profile`);
}

export const TRACK_HEADINGS = [
  'Pick this when', 'Artifact floor', 'Session shape',
  'Mastery gate', 'Verify exercise', 'Sequencing',
];

// Fixed headings, so the skill can follow a track without knowing which one it is.
export function parseTrack(text) {
  const out = {};
  let current = null;
  for (const line of String(text).split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) { current = m[1]; out[current] = []; continue; }
    if (current) out[current].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').trim()]));
}

const bundledTracksDir = () => join(CLI_DIR, 'extensions', 'tracks');
const userTracksDir = (root) => join(root, '.learn', 'tracks');

// User first, then bundled — yours overrides mine, the same precedence gtg gives
// extension commands.
export function trackFile(root, name) {
  if (!SAFE.test(name)) throw new Error(`invalid track name ${JSON.stringify(name)}`);
  const user = join(userTracksDir(root), `${name}.md`);
  if (existsSync(user)) return { path: user, source: 'user' };
  const bundled = join(bundledTracksDir(), `${name}.md`);
  if (existsSync(bundled)) return { path: bundled, source: 'bundled' };
  return null;
}

const mdNames = (dir) => {
  try { return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)); }
  catch { return []; }
};

export function listTracks(root) {
  const seen = new Map();
  for (const name of mdNames(bundledTracksDir())) seen.set(name, 'bundled');
  for (const name of mdNames(userTracksDir(root))) seen.set(name, 'user');
  return [...seen].map(([name, source]) => ({ name, source }));
}

function tracks() {
  const root = resolveRoot();
  const found = listTracks(root);
  if (!found.length) return console.log('No tracks found. Bundled tracks should ship at extensions/tracks/.');
  console.log(`Tracks (${found.length}):`);
  for (const t of found.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${colour(t.name)}${t.source === 'user' ? '  (yours, overrides bundled)' : ''}`);
  }
}

const builtins = { tracks, help, '--help': help, '-h': help };

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd) return help();
  if (!builtins[cmd]) die(2, `unknown command '${cmd}'. Try 'learn help'.`);
  // One catch at the edge. Every input guard throws; this is the only place that exits,
  // so a guard is never the reason a function cannot be tested in-process.
  try {
    return await builtins[cmd](rest);
  } catch (e) {
    die(2, e.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
