#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const SAFE = /^[A-Za-z0-9_-]+$/;

// Thrown by the input guards, and the only thing main() converts into an exit. Anything
// else reaching main is a bug in this CLI, and a bug must crash loudly rather than
// impersonate a usage error.
export class UsageError extends Error {}

// Throws rather than exiting, matching sprintPath, trackFile, applyGate, renderBrief and flag:
// a guard that exits cannot be tested in-process. main() maps a UsageError, and only a
// UsageError, to die(2, message), so all six guards still report identically at the CLI edge.
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
export function sprintRel(slug) {
  if (!SAFE.test(slug)) throw new UsageError(`invalid slug ${JSON.stringify(slug)}`);
  return `.learn/sprints/${slug}.json`;
}

// Absolute form for reading and writing; sprintRel is the same path in the form git wants it.
// Both go through the one guard, so a new caller cannot reach join() without it.
export const sprintPath = (root, slug) => join(root, sprintRel(slug));

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

// The gate is toplevel EQUALITY, not "is this inside a repo". LEARN_HUB may point at an
// untracked directory, with nothing to commit to, or at one that merely sits inside somebody
// else's repo - a temp dir under a home checkout is the everyday case - and committing there
// writes sprint state into a repo that never asked for it.
export function isRepoRoot(root) {
  try {
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    // resolve() normalises separators but not the drive letter, and a Windows path is
    // case-insensitive - so a lowercase LEARN_HUB at the true toplevel compared unequal to
    // git's own capitalisation and silently never committed anything.
    const same = process.platform === 'win32'
      ? (a, b) => a.toLowerCase() === b.toLowerCase()
      : (a, b) => a === b;
    return Boolean(top) && same(resolve(top), resolve(root));
  } catch {
    return false;
  }
}

// Every state-changing verb commits its OWN files and nothing else. The store lives in a
// checkout shared by concurrent sessions, where a file left dirty blocks everyone else's
// merges and a pathspec-less `git commit` takes the WHOLE index - so whatever another session
// staged rides along in ours. Explicit paths on BOTH add and commit is what gtg.mjs settled on
// after exactly that happened (2026-07-27); this mirrors it rather than inventing a second
// convention. `--` keeps a path starting with a dash from being read as a flag.
export function commit(root, rels, message) {
  if (!isRepoRoot(root)) return;
  const opts = { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    execFileSync('git', ['add', '--', ...rels], opts);
    execFileSync('git', ['commit', '-q', '-m', message, '--', ...rels], opts);
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    if (/nothing to commit|no changes added/i.test(out)) return; // same content already committed
    // `git add` is NOT atomic: given [tracked, ignored] it stages the tracked path and STILL
    // exits 1, so without this the sprint file was left STAGED - an ownerless index entry that
    // blocks every other session's merges, the same 2026-07-27 failure named above. A repo that
    // gitignores its docs tree is ordinary, so the failure path has to leave the tree no worse
    // than never having tried: written, uncommitted, unstaged.
    try { execFileSync('git', ['reset', '-q', '--', ...rels], opts); } catch { /* nothing staged */ }
    // A write that landed but did not commit is a partial success, so say so on stderr AND in
    // the exit code: a batch caller reads $?, not our warnings.
    // Skip git's warning and hint lines: `LF will be replaced by CRLF` precedes the real error
    // on a default Windows checkout, and naming it sends the reader after a line-ending problem
    // they do not have.
    const why = `${e.stderr || e.message || ''}`.split('\n').map((l) => l.trim())
      .find((l) => l && !/^(warning|hint):/i.test(l)) || 'no reason on stderr';
    console.error(`learn: git commit failed, changes are on disk but uncommitted - ${why}`);
    process.exitCode = 1;
  }
}

export const colour = (s) =>
  process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[36m${s}\u001b[0m` : s;

// Every flag in this CLI that takes a following value. `--verified` is the only boolean, so
// it is deliberately absent. A new valued flag must be added here as well as at its call site.
export const VALUED_FLAGS = new Set(['--track', '--sprint', '--shape', '--research-root', '--tier']);

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
  learn brief [--tier scan|pack]  write this week's corpus brief for logical-research (body on stdin)
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
  // ponytail: no existsSync guard here, unlike page()/brief(). The check above already exits 1
  // whenever sprint.json exists, so this is reachable only when the content dir outlives its
  // JSON (a failed writeSprint, or a hand-deleted sprint file) - narrow enough to accept, but
  // a hand-filled sprint.md does lose silently to a fresh template in that case. Add an
  // existsSync guard here, mirroring page(), if that turns out to bite.
  writeFileSync(scope, renderSprintDoc(sprint));
  writeSprint(root, sprint);
  commit(root, [sprintRel(sprint.slug), `${sprint.content}/sprint.md`],
    `learn start: ${sprint.slug} (${sprint.track} track)`);

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
  // applyGate has already advanced the counter, so the week that was GATED is one behind.
  commit(root, [sprintRel(s.slug)], `learn gate: ${s.slug} week ${s.week - 1} ${result}`);
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

// logical-research reads the depth it should work at off this line. Two values, no more: a
// wider set here would name tiers the callee does not implement.
export const BRIEF_TIERS = ['scan', 'pack'];

export function renderBrief({ slug, root, shape, tier, body }) {
  if (!BRIEF_SHAPES.includes(shape)) throw new UsageError(`shape must be one of ${BRIEF_SHAPES.join(', ')}`);
  if (tier !== undefined && !BRIEF_TIERS.includes(tier)) throw new UsageError(`tier must be one of ${BRIEF_TIERS.join(', ')}`);
  // tier is optional in the logical-research brief contract: absent, the callee picks.
  const tierLine = tier === undefined ? [] : [`tier:   ${tier}`];
  // Joined on an explicit newline instead of written as one template literal: this file is
  // checked out with CRLF on some machines, and the brief is another tool's line-by-line input.
  return [
    '# Corpus brief',
    `slug:   ${slug}`,
    `root:   ${root}`,
    `shape:  ${shape}`,
    ...tierLine,
    String(body).trim(),
    '',
  ].join('\n');
}

export const profilePath = (root) => join(root, '.learn', 'profile.md');

function page(args) {
  const root = resolveRoot();
  const s = pick(root, args);
  const concept = positionals(args)[0] || s.concept;
  if (!concept) die(2, 'usage: learn page <concept>');
  // Relative first: that is the form git needs, and join() gives the absolute one for free.
  const rel = `${s.content}/week-${s.week}-${slugify(concept)}.md`;
  const file = join(root, rel);
  if (existsSync(file)) die(1, `${file} already exists, refusing to overwrite it.`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderPage({ subject: s.subject, week: s.week, concept }));
  s.concept = concept;
  writeSprint(root, s);
  commit(root, [sprintRel(s.slug), rel], `learn page: ${s.slug} week ${s.week} ${concept}`);
  console.log(`PAGE ${file}`);
}

function brief(args) {
  const root = resolveRoot();
  const s = pick(root, args);
  const shape = flag(args, '--shape') ?? 'synthesis+notes';
  const tier = flag(args, '--tier');
  const researchRoot = flag(args, '--research-root') ?? 'docs/research';
  // One brief per week, not per sprint: the session research pass writes one every week and
  // the curriculum cross-check lands in whichever week it runs. The no-overwrite rule below
  // still protects a hand-edited angle within the week.
  const rel = `${s.content}/corpus-brief-week-${s.week}.md`;
  const file = join(root, rel);
  // Mirrors page(): a hand-edited angle is the whole value of this file, so a re-run must not
  // destroy it. Checked before stdin is touched, so the refusal does not eat the input.
  if (existsSync(file)) die(1, `${file} already exists, refusing to overwrite it.`);
  // readFileSync(0) on a terminal blocks with no prompt on POSIX and throws EAGAIN on Windows,
  // so the human affordance is gated on isTTY and reports the same usage error as empty stdin.
  if (process.stdin.isTTY) die(2, 'learn brief reads angle and corpus on stdin. Pipe them in.');
  const body = readFileSync(0, 'utf8');
  if (!body.trim()) die(2, 'learn brief reads angle and corpus on stdin. Pipe them in.');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderBrief({ slug: `${s.slug}-week-${s.week}`, root: researchRoot, shape, tier, body }));
  // The brief is the sprint's research home, so record where it went: nothing else ever wrote
  // this field, and a null there is indistinguishable from "no cross-check was ever run".
  s.research = rel;
  writeSprint(root, s);
  commit(root, [sprintRel(s.slug), rel], `learn brief: ${s.slug}`);
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

// Compare the FILENAME, not the path. Comparing import.meta.url against
// pathToFileURL(argv[1]) looks stricter but breaks the moment the two disagree on path form,
// and an installed plugin is exactly where they disagree: the work account reaches its plugin
// cache through a junction, so node resolved this module to its real path while argv[1] kept
// the junction path it was handed. main() then never ran and every verb exited 0 with no
// output — a silent no-op, worse than a crash. projects.mjs already used the filename form.
if (process.argv[1] && basename(process.argv[1]) === 'learn.mjs') {
  await main(process.argv.slice(2));
}
