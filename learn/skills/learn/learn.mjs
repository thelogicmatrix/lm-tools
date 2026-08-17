#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const SAFE = /^[A-Za-z0-9_-]+$/;

export function slugify(s) {
  const out = String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!out) die(2, `cannot slugify ${JSON.stringify(s)} into a usable name`);
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

const builtins = { help, '--help': help, '-h': help };

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd) return help();
  if (builtins[cmd]) return builtins[cmd](rest);
  die(2, `unknown command '${cmd}'. Try 'learn help'.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
