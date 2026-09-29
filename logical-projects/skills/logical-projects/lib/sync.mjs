// `projects sync`, the reality check: the three dates, the commit-date lookups, and the report.
// Split out of projects.mjs (#37), code unchanged.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { CS_START, NARRATIVE_UNWRITTEN, getCurrentState, pagePath } from './page.mjs';
import { readStore, today } from './portfolio.mjs';
import { PROJECTS_DIR, sortProjects } from './render.mjs';

// ── sync: the reality check ──────────────────────────────────────────────────────────
// Reports, never rewrites: on a contradiction between a page and reality you arbitrate.
// The three dates stay distinct here, which is the whole point of the verb. The Current state
// heading says when the STATUS was rewritten, `last verified` says when a model last checked
// the NARRATIVE, and the repo's last commit says what the code actually did. STALE compares
// the first against the third, UNVERIFIED the second against the first, and neither ever
// reads `lastTouched`, which only records that some `projects` write happened.
//
// Every flag line is `TOKEN <what>: <why>`. The token is the machine surface the skill greps,
// so it is one uppercase word from the fixed vocabulary and never prose.

// One source for the heading shape, in both the "read the date" and "count them" forms. A
// global regex is safe to reuse: String.match ignores lastIndex and returns every match.
const CS_HEADING = /^## Current state \((\d{4}-\d\d-\d\d)\)/m;
const CS_HEADING_ALL = /^## Current state \(\d{4}-\d\d-\d\d\)/gm;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Both sides are parsed with an explicit Z, so the answer is a whole number of days whatever the
// machine's zone and whatever DST does between the two dates. Measured, not assumed: 2026-03-07
// to 2026-03-09 is 2 in a UTC process and 2 in a UTC+8 one.
//
// The page dates reaching here have been through isRealDate. `commitDate` has NOT: it comes from
// git's own --date=short, which cannot emit a day that does not exist, or from the commitDateFor
// seam a test injects. A junk value from that seam yields NaN, and NaN > 0 is false, so the
// result is no STALE line rather than a wrong one.
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// `\d\d` is a digit test, not a calendar: 2026-13-45 matches both date regexes below, and
// Date.parse then returns NaN, so `behind > 0` is false and the page reports clean while being
// months out. 2026-02-30 is worse, because V8 rolls it forward to 2026-03-02 and hands back a
// plausible WRONG number of days. Round-tripping through Date is the whole check: a date that
// is not the date it claims to be comes back as a different string.
function isRealDate(d) {
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
}

export function currentStateDate(pageText) {
  return (pageText.match(CS_HEADING) || [])[1] ?? null;
}

// Read from the page header only, the text above the first `## ` heading and above the block,
// which is where register writes the stamp. Nothing written into the Current state block can be
// mistaken for it. Anchoring to a line start was not enough on its own: setCurrentState writes
// the body line-initial under CS_START, so a status line reading `*last verified <date>` sat
// exactly where the anchored read looked, and since register stamps the header `never` and no
// verb ever writes a date there, the CLI could produce its own false pass. `never` deliberately
// does not match: null here means "no verified date", which is what UNVERIFIED reports.
// Bounded to the FIRST line-initial `last verified` line in that region, not to any of them.
// Scanning the region for a line that carries a date skipped straight past the skeleton's own
// `never` and read a date out of the narrative prose below it, so a page could report clean on a
// stamp a human never moved. The first such line is the stamp, and if it says `never` the answer
// is "no verified date", which is what UNVERIFIED reports. Erring toward UNVERIFIED is the safe
// direction: it asks for a read that already happened, where the other way hides one that never did.
export function lastVerifiedDate(pageText) {
  const header = pageText.split(CS_START)[0].split(/^## /m)[0];
  const stamp = header.match(/^\*last verified [^\n]*/m);
  return ((stamp && stamp[0].match(/^\*last verified (\d{4}-\d\d-\d\d)/)) || [])[1] ?? null;
}

// `-- .` is load-bearing. Without a pathspec, `git -C <dir> log -1` walks UP to whatever repo
// contains <dir>, so a `repo` field naming a plain folder inside a bigger repo reported that
// repo's newest commit, made by any session working anywhere in it, while a genuinely dormant
// folder read as 0 days behind. With it, a folder inside a repo that has no commits of its own
// exits 0 with empty output, and a real subdirectory reports its own dates. A folder in no repo
// at all is the other shape and it does not come back empty, it makes git fail with "not a git
// repository", which the catch turns into the same null. All three mean "no commit date to
// compare against", and the absent directory is reported separately as MISSING-REPO.
const commitDateArgs = (repo) => ['-C', repo, 'log', '-1', '--format=%ad', '--date=short', '--', '.'];
export function lastCommitDate(repo) {
  try {
    return execFileSync('git', commitDateArgs(repo),
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch { return null; }
}

// The same question for every repo at once. sync used to ask it one spawn at a time, 18 rows in
// series. A failure is null, as in lastCommitDate.
export async function lastCommitDates(repos) {
  const run = promisify(execFile);
  const dates = await Promise.all(repos.map((repo) => run('git', commitDateArgs(repo))
    .then(({ stdout }) => stdout.trim() || null, () => null)));
  return new Map(repos.map((repo, i) => [repo, dates[i]]));
}

export function cmdSync(root, _args, opts = {}) {
  const date = opts.date || today();
  const commitDateFor = opts.commitDateFor || lastCommitDate;
  const store = readStore(root);
  const flags = [];
  const pagesInUse = new Set();

  for (const p of sortProjects(store.projects)) {
    if (!p.page) { flags.push(`NO-PAGE ${p.slug}: the row has nowhere to keep a status`); continue; }
    pagesInUse.add(p.page);
    // `block`, not `body`: the report's own assembled body is a separate `body` further down.
    let text, block;
    // One try per row, not one around the loop: a single unreadable page must cost its own
    // numbers and nobody else's. The read is what throws, so only the read is in here.
    try {
      // pagePath, not a bare join. sync READS every page named in the store, and `page` comes
      // out of a hand-editable record file, so `page: "../../.ssh/config"` would otherwise get
      // that file scanned and quoted back in a flag.
      const path = pagePath(root, p.page);
      if (!existsSync(path)) {
        flags.push(`NO-PAGE ${p.slug}: the row points at ${p.page}, which is not on disk`);
        continue;
      }
      text = readFileSync(path, 'utf8');
      // Throws on a marker shape `current` would also refuse to write into, so sync surfaces it
      // while it is still cheap to fix. Returns null when the page carries no block at all, which
      // is checked below, and the block's own text when there is one.
      block = getCurrentState(text);
    } catch (e) {
      // MALFORMED is "sync has no block it can use here", NO-CURRENT-STATE is "there is no block
      // at all", and the two are never collapsed. Names the file, a human has to go open it.
      // This line quotes a page name back from a pagePath refusal, so it carries hand-editable
      // text. No squash of its own: the report is squashed once where the flags are joined.
      flags.push(`MALFORMED ${p.slug}: ${p.page} cannot be read. ${
        String((e && e.message) || e).replace(/^projects: /, '')}`);
      continue;
    }

    if (text.includes(NARRATIVE_UNWRITTEN)) {
      flags.push(`NARRATIVE-UNWRITTEN ${p.slug}: ${p.page} is still the skeleton, the narrative was never written`);
    }
    // Whitespace between the heading and the marker is absorbed on the next write, but prose
    // between them is not, so the stale heading survives and a second one lands below it. Both
    // match CS_HEADING, /m takes the first, and the date reported here would never move again.
    // Counting catches any page already in that state too.
    const headings = (text.match(CS_HEADING_ALL) || []).length;
    if (headings > 1) {
      // Its own token. Not ORPHANED, which Task 7's migration gate owns, and not MALFORMED: the
      // tokens are independent and both can fire on one page.
      flags.push(`DOUBLE-HEADING ${p.slug}: ${p.page} carries ${plural(headings, 'Current state heading')
        }, so the date read here can be the stale one. Delete the heading with no block under it`);
    }
    // A heading present with nothing usable behind it is the same defect twice over: a date that
    // is not a day, and a date over no block. Either way there is a heading, so NO-CURRENT-STATE
    // would be a lie, and every number for the project is wrong until a human edits the page.
    // MALFORMED at exit 1 for both, ruled 2026-08-03.
    //
    // Deliberately asymmetric with the `last verified` case below, which stays UNVERIFIED at
    // exit 0: that token already means "we do not know when this was verified", so an unusable
    // stamp has somewhere honest to land. A heading date has no such fallback.
    //
    // csDate drops to null in both, so nothing below compares against a date it cannot trust.
    let csDate = currentStateDate(text);
    if (!csDate) {
      flags.push(`NO-CURRENT-STATE ${p.slug}: ${p.page} carries no dated Current state heading`);
    } else if (!isRealDate(csDate)) {
      flags.push(`MALFORMED ${p.slug}: ${p.page} heads its Current state block with ${csDate
        }, which is not a real date, so every date check on this project is off until it is fixed`);
      csDate = null;
    } else if (!block) {
      // `!block` covers two shapes, a heading with no markers under it and a START immediately
      // followed by an END, so the message says "no usable block" rather than "no block": on the
      // empty-block page both markers are there and "no block" would send a human looking for
      // something already in the file. Both wordings executed against both shapes.
      flags.push(`MALFORMED ${p.slug}: ${p.page} carries a Current state heading dated ${csDate
        } with no usable block under it, so there is no status to report`);
      csDate = null;
    }
    // Resolved against the store root, so `--repo ../foo` means the same thing wherever sync was
    // invoked from. The common case is an absolute path, which resolve returns as-is apart from
    // normalising the separators: `C:/dev/beacon` comes back as `C:\dev\beacon`. The flag below
    // still prints p.repo as it was written, since that is the string to fix.
    const repo = p.repo ? resolve(root, p.repo) : null;
    let commitDate = null;
    if (repo && !existsSync(repo)) {
      flags.push(`MISSING-REPO ${p.slug}: the repo path is not there: ${p.repo}`);
    } else if (repo) {
      // Only for a path that is actually there. Asking git about a directory already known to be
      // absent spawns a process to learn nothing.
      commitDate = commitDateFor(repo);
    }
    if (csDate && commitDate) {
      const behind = daysBetween(csDate, commitDate);
      if (behind > 0) {
        flags.push(`STALE ${p.slug}: the status is ${plural(behind, 'day')
          } behind the code (last commit ${commitDate})`);
      }
    }
    const lv = lastVerifiedDate(text);
    if (!lv || !isRealDate(lv)) {
      // Three shapes land here and the claim is true of all three: `last verified never`, which
      // register writes on every skeleton, no stamp at all, and a stamp that is not a real date.
      // Stale from day one on the first: the alternative is a date nobody earned, which would
      // suppress this line for a whole staleness window on the pages that most need it.
      flags.push(`UNVERIFIED ${p.slug}: ${p.page} carries no usable last verified date`);
    } else if (csDate && daysBetween(lv, csDate) > 0) {
      flags.push(`UNVERIFIED ${p.slug}: the narrative was last verified ${lv}, the status has moved on to ${csDate}`);
    }
  }

  const dir = join(root, PROJECTS_DIR);
  // A repo that has never registered anything has no folder, and readdirSync on a missing
  // directory throws an ENOENT that main would report as a bug in this file.
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    // archive/ and entries/ are not .md, so the extension test drops both.
    if (!f.endsWith('.md') || f === 'INDEX.md' || f === 'CRITIQUES.md') continue;
    if (!pagesInUse.has(f)) flags.push(`NO-ROW ${f}: a page in ${PROJECTS_DIR} with no row pointing at it`);
  }

  // One flag, one line, enforced HERE rather than at each field that interpolates. Flag lines
  // quote hand-editable text, and any line break in it plants a second grep-visible token line
  // under a header still counting one flag. The exit code rides on that: the dispatcher decides it
  // with /^MALFORMED /m. Squashing per field left every sibling open, and every field a later
  // check adds. Squashing the assembled report needs no list of what to guard, and `\s` covers
  // every character /m treats as a line start, not just \n.
  const body = flags.map((f) => f.replace(/\s+/g, ' ')).join('\n');
  return flags.length
    ? `projects sync (${date}): ${flags.length} flagged\n\n${body}\n`
    : `projects sync (${date}): nothing to flag across ${plural(store.projects.length, 'project')}\n`;
}
