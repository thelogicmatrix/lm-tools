#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const SAFE = /^[A-Za-z0-9_-]+$/;

// Thrown by the input guards, and the only thing main() converts into an exit. Anything
// else reaching main is a bug in this CLI, and a bug must crash loudly rather than
// impersonate a usage error.
export class UsageError extends Error {}

// Throws rather than exiting, matching sprintPath, trackFile, applyGate and renderBrief: a
// guard that exits cannot be tested in-process. main() maps a UsageError, and only a
// UsageError, to die(2, message), so all five guards still report identically at the CLI edge.
export function slugify(s) {
  const out = String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!out) throw new UsageError(`cannot slugify ${JSON.stringify(s)} into a usable name`);
  return out;
}

export function die(code, msg) {
  console.error(`learn: ${msg}`);
  process.exit(code);
}

// Every path segment is checked before it reaches join(). Untrusted-ish input reaching
// path.join is a traversal waiting to happen.
export function sprintPath(root, slug) {
  if (!SAFE.test(slug)) throw new UsageError(`invalid slug ${JSON.stringify(slug)}`);
  return join(root, '.learn', 'sprints', `${slug}.json`);
}

export function readSprint(root, slug) {
  const p = sprintPath(root, slug);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

// A failed write must never read as a success, so it reports what is actually on disk
// before exiting 1: the next run needs to know whether the sprint moved or not.
export function writeSprint(root, sprint) {
  const p = sprintPath(root, sprint.slug);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(sprint, null, 2)}\n`);
  } catch (e) {
    console.error(`learn: could not write ${p}: ${e.message}`);
    console.error(existsSync(p) ? `learn: on disk now:` : `learn: ${p} is absent`);
    if (existsSync(p)) console.error(readFileSync(p, 'utf8'));
    die(1, 'sprint not saved, nothing was advanced.');
  }
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

// Every flag in this CLI that takes a following value. `--verified` is the only boolean, so
// it is deliberately absent. A new valued flag must be added here as well as at its call site.
export const VALUED_FLAGS = new Set(['--track', '--sprint', '--shape', '--research-root']);

// A valued flag's value is NOT a positional. Filtering on startsWith('--') alone read
// `learn start --track code "Systems Design"` as subject "code" and slugged the sprint
// learning-code, and no downstream guard could catch it: the eaten token is by definition a
// valid track name. Shared by every verb, so a new verb's flags cannot reintroduce the bug.
export function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (VALUED_FLAGS.has(args[i])) { i += 1; continue; }
    if (args[i].startsWith('--')) continue;
    out.push(args[i]);
  }
  return out;
}

// undefined when the flag is absent. Present with no value is a usage error, not a silent
// default: reading args[i + 1] blind handed `--sprint` at the end of the line the string
// "undefined" and reported `no sprint 'undefined'`, and handed `--shape` the next flag.
export function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
  return value;
}

function help() {
  console.log(`learn — self-directed learning sprints

  learn tracks                    list available tracks
  learn start <subject> --track <name>
  learn week                      what week, what concept, what is due
  learn gate <pass|fail> [--verified]
  learn page [concept]            stamp the week-N reference page
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

// README.md promises "nothing here is validated beyond the headings being present", so
// validate exactly that and nothing more. A user track missing `Mastery gate` otherwise
// breaks section 4 of every session with no error anywhere.
export function missingHeadings(text) {
  const parsed = parseTrack(text);
  return TRACK_HEADINGS.filter((h) => !Object.hasOwn(parsed, h));
}

const bundledTracksDir = () => join(CLI_DIR, 'extensions', 'tracks');
const userTracksDir = (root) => join(root, '.learn', 'tracks');

// User first, then bundled — yours overrides mine, the same precedence gtg gives
// extension commands.
export function trackFile(root, name) {
  if (!SAFE.test(name)) throw new UsageError(`invalid track name ${JSON.stringify(name)}`);
  const user = join(userTracksDir(root), `${name}.md`);
  if (existsSync(user)) return { path: user, source: 'user' };
  const bundled = join(bundledTracksDir(), `${name}.md`);
  if (existsSync(bundled)) return { path: bundled, source: 'bundled' };
  return null;
}

const namesWithExt = (dir, ext) => {
  try { return readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length)); }
  catch { return []; }
};

export function listTracks(root) {
  const seen = new Map();
  for (const name of namesWithExt(bundledTracksDir(), '.md')) seen.set(name, 'bundled');
  for (const name of namesWithExt(userTracksDir(root), '.md')) seen.set(name, 'user');
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

export const DEFAULT_CONTENT_ROOT = 'docs/learning';

export function newSprint({ subject, track, contentRoot = DEFAULT_CONTENT_ROOT, now }) {
  const slug = `learning-${slugify(subject)}`;
  return {
    slug, subject, track, created: now,
    content: `${contentRoot}/${slug}`,
    research: null, week: 1, concept: null, gates: [], verify: [],
  };
}

// The four scoping questions from references/starting-a-sprint.md section 4, and the sprint
// goal plus milestone sequence they produce. `start` writes it so that artifact has a home on
// disk rather than existing only in the session that scoped it.
export function renderSprintDoc({ subject, track, slug }) {
  return `# ${subject} — sprint scope

*${slug} · ${track} track. Fill this in from the scoping pass before the first session.*

## Sprint goal

<One paragraph. What will be built, or written, by the end of this sprint — concrete and small enough to picture.>

## What this requires that I do not have yet

<The skill the goal needs and I do not have. This is what the weekly concepts have to deliver.>

## Smallest working version

<What I could produce in a single session, calibrated against my current level.>

## The real problem this solves

<The real problem, or "practicing" — in which case find a real problem first: the project is the motivation, not a container for it.>

## Weekly milestones

<One line per week, paced against the weekly time budget. These week numbers are the plan; \`learn week\` holds the actual count.>

- Week 1 — <milestone>
`;
}

function start(args) {
  const root = resolveRoot();
  const subject = positionals(args)[0];
  const track = flag(args, '--track');
  if (!subject || !track) die(2, 'usage: learn start <subject> --track <name>');
  const found = trackFile(root, track);
  if (!found) die(2, `no track '${track}'. Run 'learn tracks' to see what is available.`);
  const missing = missingHeadings(readFileSync(found.path, 'utf8'));
  if (missing.length) die(2, `track '${track}' (${found.path}) is missing: ${missing.join(', ')}`);

  const sprint = newSprint({ subject, track, now: new Date().toISOString() });
  if (readSprint(root, sprint.slug)) die(1, `sprint '${sprint.slug}' already exists. Run 'learn week'.`);
  mkdirSync(join(root, sprint.content), { recursive: true });
  const scope = join(root, sprint.content, 'sprint.md');
  writeFileSync(scope, renderSprintDoc(sprint));
  writeSprint(root, sprint);

  console.log(`STARTED ${sprint.slug}`);
  console.log(`  track:   ${sprint.track}`);
  console.log(`  content: ${sprint.content}/`);
  console.log(`  scope:   ${sprint.content}/sprint.md — write the goal and milestones into it`);
  // gtg owns the sprint as a resumable project, but learn never spawns it: the skill does,
  // which is gtg's own GTG-DIRECTIVE convention. See the note in this task's brief.
  console.log(`GTG-NEW ${sprint.slug} — create the gtg project for "Learning: ${subject}" with parent "learning". Skip if gtg is not installed.`);
}

export const VERIFY_FLOOR_WEEKS = 2;

// "At least once every 2 weeks." Measured from the LATEST verify recorded, meaning the
// last entry and not the largest, and a sprint that has never run one is due from week 2.
// Reading the last entry errs toward firing the nag if the log is ever out of order, which
// is the safe direction for a floor.
export function verifyDue(sprint) {
  const last = sprint.verify.at(-1) ?? 0;
  return sprint.week - last >= VERIFY_FLOOR_WEEKS;
}

export function applyGate(sprint, result, { verified = false, now } = {}) {
  if (result !== 'pass' && result !== 'fail') throw new UsageError('gate result must be pass or fail');
  sprint.gates.push({ week: sprint.week, concept: sprint.concept, result, at: now });
  if (verified) sprint.verify.push(sprint.week);
  sprint.week += 1;
  if (result === 'pass') sprint.concept = null;
  return sprint;
}

// One sprint at a time is the normal case. More than one is ambiguous, so name it
// rather than guessing: a wrong guess writes a gate result onto the wrong sprint.
export function activeSprint(root) {
  const dir = join(root, '.learn', 'sprints');
  const slugs = namesWithExt(dir, '.json');
  if (!slugs.length) die(2, "no sprint here. Start one with 'learn start <subject> --track <name>'.");
  if (slugs.length > 1) die(2, `more than one sprint (${slugs.join(', ')}). Pass --sprint <slug>.`);
  return readSprint(root, slugs[0]);
}

function pick(root, args) {
  const slug = flag(args, '--sprint');
  if (slug !== undefined) {
    const s = readSprint(root, slug);
    if (!s) die(2, `no sprint '${slug}'`);
    return s;
  }
  return activeSprint(root);
}

function week(args) {
  const s = pick(resolveRoot(), args);
  console.log(`${colour(s.subject)} — week ${s.week} (${s.track} track)`);
  // Keyed off the last gate's result, not sprint.concept: page() also sets concept, on a
  // brand-new week that has never been gated, so "concept is non-null" stopped being a safe
  // stand-in for "the last gate failed" once page() existed.
  if (s.gates.at(-1)?.result === 'fail') {
    // Same fallback as gate(): a fail on a week whose concept was never set leaves concept
    // null, and the marker line is relayed verbatim, so an unguarded interpolation ships the
    // literal string "null" to the reader.
    console.log(`REPEAT  ${s.concept ?? 'the same concept'} — the last gate failed, so a DIFFERENT worked example on the same concept.`);
  } else if (s.concept) {
    console.log(`ADVANCED  ${s.concept} — picked, not yet gated.`);
  } else {
    console.log('ADVANCED  no concept set. Pick week ' + s.week + "'s one new concept.");
  }
  if (verifyDue(s)) console.log(`VERIFY-DUE  the verify exercise floor is ${VERIFY_FLOOR_WEEKS} weeks and it is due this session.`);
  const last = s.gates.at(-1);
  if (last) console.log(`  last gate: week ${last.week} ${last.concept ?? '?'} -> ${last.result}`);
}

function gate(args) {
  const root = resolveRoot();
  const result = positionals(args).find((a) => a === 'pass' || a === 'fail');
  if (!result) die(2, 'usage: learn gate <pass|fail> [--verified] [--sprint <slug>]');
  const s = pick(root, args);
  applyGate(s, result, { verified: args.includes('--verified'), now: new Date().toISOString() });
  writeSprint(root, s);
  console.log(result === 'pass' ? `ADVANCED to week ${s.week}` : `REPEAT ${s.concept ?? 'the same concept'} at week ${s.week}`);
  if (verifyDue(s)) console.log('VERIFY-DUE  next session must include a verify exercise.');
}

// One paragraph is one line, never hard-wrapped: a single newline inside a paragraph
// renders as a visible line break in GFM/Typora.
export function renderPage({ subject, week, concept }) {
  return `# Week ${week} — ${concept}

> [!TIP]
> By the end of this session you will be able to <state the one objective here>.

*${subject} · week ${week} · one concept, practiced to fluency.*

## Worked example

<A complete, runnable, fully working example. Never pseudo-code.>

## The principle it generalises to

<What this is an instance of. This is the part that transfers.>

> [!CAUTION]
> <Every simplification, flagged. Never present a beginner approximation as complete.>

## Worksheet

<Write what you worked out here. It gets graded, not just read.>

## Sources

- <real, checkable source>
`;
}

export const BRIEF_SHAPES = ['synthesis', 'synthesis+notes', 'synthesis+notes+raw'];

export function renderBrief({ slug, root, shape, body }) {
  if (!BRIEF_SHAPES.includes(shape)) throw new UsageError(`shape must be one of ${BRIEF_SHAPES.join(', ')}`);
  return `# Corpus brief
slug:   ${slug}
root:   ${root}
shape:  ${shape}
${String(body).trim()}
`;
}

export const profilePath = (root) => join(root, '.learn', 'profile.md');

function page(args) {
  const root = resolveRoot();
  const s = pick(root, args);
  const concept = positionals(args)[0] || s.concept;
  if (!concept) die(2, 'usage: learn page <concept>');
  const file = join(root, s.content, `week-${s.week}-${slugify(concept)}.md`);
  if (existsSync(file)) die(1, `${file} already exists, refusing to overwrite it.`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderPage({ subject: s.subject, week: s.week, concept }));
  s.concept = concept;
  writeSprint(root, s);
  console.log(`PAGE ${file}`);
}

function brief(args) {
  const root = resolveRoot();
  const s = pick(root, args);
  const shape = flag(args, '--shape') ?? 'synthesis+notes';
  const researchRoot = flag(args, '--research-root') ?? 'docs/research';
  const file = join(root, s.content, 'corpus-brief.md');
  // Mirrors page(): a hand-edited angle is the whole value of this file, so a re-run must not
  // destroy it. Checked before stdin is touched, so the refusal does not eat the input.
  if (existsSync(file)) die(1, `${file} already exists, refusing to overwrite it.`);
  // readFileSync(0) on a terminal blocks with no prompt on POSIX and throws EAGAIN on Windows,
  // so the human affordance is gated on isTTY and reports the same usage error as empty stdin.
  if (process.stdin.isTTY) die(2, 'learn brief reads angle and corpus on stdin. Pipe them in.');
  const body = readFileSync(0, 'utf8');
  if (!body.trim()) die(2, 'learn brief reads angle and corpus on stdin. Pipe them in.');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderBrief({ slug: `${s.slug}-curriculum`, root: researchRoot, shape, body }));
  // The brief is the sprint's research home, so record where it went: nothing else ever wrote
  // this field, and a null there is indistinguishable from "no cross-check was ever run".
  s.research = `${s.content}/corpus-brief.md`;
  writeSprint(root, s);
  console.log(`BRIEF-WRITTEN ${file}`);
  console.log('  Hand it to logical-research. It returns the pack path — LINK to it, never copy it out.');
}

function profile() {
  const root = resolveRoot();
  const p = profilePath(root);
  if (!existsSync(p)) {
    // No verb writes this file: the CLI reads it and nothing else, so the message has to name
    // a mechanism that exists. It used to promise a review that no verb performs.
    console.log(`No profile yet at ${p}. Write one there yourself, or ask for a draft at the end of a sprint.`);
    return;
  }
  console.log(readFileSync(p, 'utf8'));
}

const builtins = { tracks, help, '--help': help, '-h': help, start, week, gate, page, brief, profile };

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd) return help();
  if (!builtins[cmd]) die(2, `unknown command '${cmd}'. Try 'learn help'.`);
  // One catch at the edge: a guard's UsageError becomes die(2, message), anything else is
  // re-thrown so a real bug crashes loudly with its stack. That is what lets the guards
  // throw instead of exiting, and so stay testable in-process.
  try {
    return await builtins[cmd](rest);
  } catch (e) {
    if (e instanceof UsageError) die(2, e.message);
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
