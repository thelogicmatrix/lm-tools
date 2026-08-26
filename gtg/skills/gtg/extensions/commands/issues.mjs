// gtg issues - a bundled gtg extension over docs/issues/, shipped with the skill.
// Joins two sources it does not own: packages are the gtg entries in this command's own
// parent namespace, membership is the **Package:** field in each docs/issues/ file.
// Neither side has to be kept in step. Fix an issue, delete its file, and it leaves the
// package. A worked-around issue KEEPS its file on purpose, so its row stays and carries
// the Check that would prove the class is really fixed.
// Spec: docs/superpowers/specs/2026-08-04-gtg-issues-layer-design.md
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';

// THE anchor, shared by the reader and the writer so they cannot drift apart again. A bold
// label only counts as a field when it opens a line: quoted in prose, or indented inside a
// fence, it is documentation. Without this, an issue file could not describe the field syntax
// without the reader taking the example as that file's own membership - which is exactly how
// the issue about this bug tripped the reader while being written.
const isFieldLine = (l) => /^\*\*[A-Za-z ]+:\*\*/.test(l);

// ...and a fence beats the anchor. A field line shown verbatim inside ``` is an EXAMPLE, at
// column 0 like any other code, and reading it as membership is what stopped this folder
// documenting its own format. Returns a mask so both callers keep the original line numbers.
const fieldMask = (lines) => {
  let fenced = false;
  return lines.map((l) => {
    if (/^\s*(```|~~~)/.test(l)) { fenced = !fenced; return false; }
    return !fenced && isFieldLine(l);
  });
};

// Two field shapes that end differently. Area/Effort/Package/Blocked on share one
// `·`-separated line, so they stop at the separator. Check and Status own their line and wrap
// freely, so they run to the end of the paragraph: 9 of 24 files wrapped a Check and lost the
// pass condition to a newline stop, every time the load-bearing half.
const PARAGRAPH_FIELDS = new Set(['Check', 'Status']);

// Exported for the suite only: nothing in the rendered output shows a field's VALUE, just its
// presence, so a truncating reader is invisible from the CLI and has to be pinned directly.
export const field = (content, name) => {
  const tag = `**${name}:**`;
  const lines = content.split('\n');
  const mask = fieldMask(lines);
  const at = lines.findIndex((l, i) => mask[i] && l.includes(tag));
  if (at < 0) return null;
  const head = lines[at].slice(lines[at].indexOf(tag) + tag.length);
  if (!PARAGRAPH_FIELDS.has(name)) return head.split('·')[0].trim() || null;
  // A continuation stops at a blank line, the next field, or a fence, so `Check` sitting
  // directly above `Status` does not swallow it and an example block is never absorbed.
  const rest = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (!lines[i].trim() || isFieldLine(lines[i]) || /^\s*(```|~~~)/.test(lines[i])) break;
    rest.push(lines[i].trim());
  }
  return [head.trim(), ...rest].join(' ').trim() || null;
};

const readIssues = (root) => {
  const dir = join(root, 'docs/issues');
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md'); }
  catch { return []; }
  return files
    .map((f) => {
      const c = readFileSync(join(dir, f), 'utf8');
      let blocked = field(c, 'Blocked on');
      if (blocked && /^(nothing|none|n\/?a)\.?$/i.test(blocked)) blocked = null;
      const statusRaw = field(c, 'Status');
      const workedAround = /^worked-around/i.test(statusRaw ?? '');
      return {
        file: f,
        slug: f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, ''),
        area: field(c, 'Area') ?? 'unfiled',
        effort: field(c, 'Effort') ?? '?',
        pkg: (field(c, 'Package') ?? '').toLowerCase() || null,
        blocked,
        // A paragraph field now, so a `·` inside a Check is kept and a wrapped Check is read
        // whole. It stops at a blank line or the next field line, never at a separator.
        check: field(c, 'Check'),
        workedAround,
        workaround: workedAround ? (statusRaw.match(/\((.+)\)/)?.[1] ?? null) : null,
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
};

const pnNum = (pn) => (pn ? Number.parseInt(pn.slice(1), 10) : Number.MAX_SAFE_INTEGER);

// ctx.ownEntries reads BOTH stores and owns the parent-namespace filter, so the namespace
// string lives only in gtg.mjs. The shelved flag is set here because pkgHeader renders it.
const readPackages = (ownEntries) => {
  const { active, shelved } = ownEntries();
  return [
    ...active.map((e) => ({ ...e, shelved: false })),
    ...shelved.map((e) => ({ ...e, shelved: true })),
  ]
    .map((e) => ({ ...e, pn: (String(e.slug).match(/^issues-(p\d+)-/) ?? [])[1] ?? null }))
    // A pN-less entry in this namespace is tooling filed under the wrong parent, not a
    // package. `gtg-issues-layer` rendered as one for a whole session, with membership
    // unstamped. Tooling belongs to parent: gtg.
    .filter((e) => e.pn)
    .sort((a, b) => pnNum(a.pn) - pnNum(b.pn) || String(a.slug).localeCompare(b.slug));
};

const days = (iso) => {
  const d = (Date.now() - Date.parse(iso)) / 86400000;
  return Number.isFinite(d) ? Math.floor(d) : '?';
};

// Counted per bucket, never summed. The buckets are coarse on purpose and adding
// them would invent a precision the field does not carry.
const ORDER = ['minutes', 'hour', 'session'];

// Effort is free text in practice, and most live files carry a parenthetical, so bucketing on
// the exact string gave close to one bucket per file. Bucket on the LEADING keyword instead.
// No live file count here on purpose: the folder grows most weeks, so a count baked into a
// comment is stale by the next session. The lookahead deliberately excludes a range
// (`minutes-hours (upstream)` → `?`): a range is not a bucket and picking an end would invent
// data. memberLine still prints the raw value, so the nuance is kept out of the count rather
// than lost.
// Either number is accepted and canonicalised. The documented vocabulary is itself
// inconsistent - `minutes` plural, `hour` and `session` singular - which is what put `hours`
// in a live file and then counted it as unknown. A range still buckets to `?`: the lookahead
// rejects `minutes-hours` at the hyphen, because picking an end would invent data.
const bucketOf = (effort) => {
  const w = String(effort).match(/^(minutes?|hours?|sessions?)(?=$|[\s(])/i)?.[1]?.toLowerCase();
  if (!w) return '?';
  return w.startsWith('minute') ? 'minutes' : w.startsWith('hour') ? 'hour' : 'session';
};

const rollup = (members) => {
  const counts = new Map();
  for (const m of members) counts.set(bucketOf(m.effort), (counts.get(bucketOf(m.effort)) ?? 0) + 1);
  const keys = [...counts.keys()].sort((a, b) => {
    const [ia, ib] = [ORDER.indexOf(a), ORDER.indexOf(b)];
    return (ia < 0 ? ORDER.length : ia) - (ib < 0 ? ORDER.length : ib);
  });
  const parts = keys.map((k) => `${counts.get(k)}× ${k}`);
  return `${members.length} issue${members.length === 1 ? '' : 's'} (${parts.join(', ')})`;
};

const memberLine = (i) => {
  const flags = [];
  if (i.blocked) flags.push(`BLOCKED: ${i.blocked}`);
  if (i.workedAround) flags.push(`WORKED-AROUND${i.workaround ? `: ${i.workaround}` : ''}`);
  const tail = flags.length ? ` - ${flags.join(' - ')}` : '';
  return `  • [${i.effort}] ${i.slug}${tail}${i.check ? '' : ' (no Check)'}`;
};

const pkgHeader = (p, members) => {
  const state = p.shelved ? `shelved ${days(p.updated)}d` : 'active';
  // Zero members is TWO opposite states the folder can no longer tell apart: never stamped,
  // or every member fixed and deleted. The second is a finished package that should be removed,
  // and rendering it as "unstamped" read as unfinished setup, so the shelf only ever grew.
  // Both are named rather than guessing which, because after deletion the history is gone.
  const tail = members.length ? rollup(members) : `no members - unstamped, or done (\`gtg remove ${p.slug}\`)`;
  return `${p.project} [${p.slug}] (${state}) - ${tail}`;
};

// docs/issues/README.md's documented set, plus the sentinel an omitted Area reads as.
const AREAS = new Set(['obelisk', 'claude-stack', 'jobhunt', 'work', 'misc', 'unfiled']);

const RULE = '='.repeat(55);

// Shared with `pack`, which lists the same loose set before proposing batches, so this
// block lands in both callers at once. The unpackaged remainder is the one thing in this
// output that needs a decision, so it gets a named block rather than a count. `Loose (N):`
// read as one more group heading.
const printLoose = (loose) => {
  console.log(RULE);
  console.log(`UNPACKAGED (${loose.length}) - in no package, untriaged`);
  console.log(RULE);
  for (const area of [...new Set(loose.map((i) => i.area))].sort()) {
    const group = loose.filter((i) => i.area === area);
    console.log(`  ${area} (${group.length}):`);
    group.forEach((i) => console.log(`  ${memberLine(i)}`));
  }
};

const list = (issues, packages) => {
  const known = new Set(packages.map((p) => p.pn).filter(Boolean));
  for (const p of packages) {
    const members = p.pn ? issues.filter((i) => i.pkg === p.pn) : [];
    console.log(pkgHeader(p, members));
    console.log(`  → ${p.next || '?'}`);
    members.forEach((i) => console.log(memberLine(i)));
    console.log('');
  }
  const loose = issues.filter((i) => !i.pkg || !known.has(i.pkg));
  if (loose.length) { printLoose(loose); console.log(''); }
  const stale = [...new Set(issues.filter((i) => i.pkg && !known.has(i.pkg)).map((i) => i.pkg))].sort();
  const blocked = issues.filter((i) => i.blocked).length;
  const bits = [
    `${issues.length} issues`,
    `${packages.length} packages`,
    `${loose.length} loose`,
    `${blocked} blocked`,
    `${issues.filter((i) => i.workedAround).length} worked-around`,
    `${issues.filter((i) => !i.check).length} no Check`,
  ];
  if (stale.length) bits.push(`${stale.length} stale package ref (${stale.join(', ')})`);
  console.log(bits.join(' · '));
  // Warns rather than refuses. Both vocabularies degrade silently otherwise - the loose view
  // groups by Area, so a drifted value quietly fragments into its own one-file heading - but a
  // typo must never make the folder unreadable, since reading it is how you find the typo.
  const offArea = [...new Set(issues.map((i) => i.area))].filter((a) => !AREAS.has(a)).sort();
  if (offArea.length) {
    const n = (a) => issues.filter((i) => i.area === a).length;
    console.log(`! ${offArea.length} Area value${offArea.length === 1 ? '' : 's'} outside README's set: ${offArea.map((a) => `${a} (${n(a)})`).join(', ')}`);
  }
};

const listPackages = (packages) => {
  if (!packages.length) { console.log('No issue packages. `gtg issues pack` bundles loose issues into one.'); return; }
  console.log(`Issue packages (${packages.length}):`);
  for (const p of packages) {
    const state = p.shelved ? `shelved ${days(p.updated)}d` : 'active';
    console.log(`  • ${p.project} [${p.slug}] (${state})`);
    console.log(`     → ${p.next || '?'}`);
  }
};

// A pN query is exact, full stop. `p1` substring-matches `issues-p10-dns`, returns it as a
// lone match, and the router then resumes p10 when p1 was asked for. Silent and certain once
// pack reaches double digits, so pN never falls through to the substring pass. Free text still
// does, which is the useful half.
const resolve = (packages, query) => {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact = packages.filter((p) => p.pn === q || String(p.slug).toLowerCase() === q);
  if (exact.length) return exact;
  if (/^p\d+$/.test(q)) return [];
  return packages.filter((p) => `${p.slug} ${p.project}`.toLowerCase().includes(q));
};

// ponytail: a flag reader, not a parser library, but the flag set is CLOSED and a
// value that looks like another flag is refused, never guessed. An open reader let
// `--name --dry-run` swallow the boolean and commit for real, and let a `--dryrun`
// typo eat the slug after it. Upgrade path: none until a flag legitimately takes a
// value starting with `--`.
const FLAGS = new Set(['name', 'next', 'eta', 'dry-run']);
const parseFlags = (argv) => {
  const flags = {};
  const pos = [];
  const bad = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    if (!FLAGS.has(k)) { bad.push(`unknown flag "${a}" - expected --name, --next, --eta or --dry-run`); continue; }
    if (k === 'dry-run') { flags[k] = true; continue; }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) { bad.push(`${a} needs a value`); continue; }
    flags[k] = val;
    i += 1;
  }
  return { flags, pos, bad };
};

// Appends to the existing field line, or opens one under the title when the file
// has none. Returns the resulting field line too, so --dry-run can show it.
// ANCHORED: a bold label anywhere in the prose (or indented inside a fenced code
// block) is not a field line, and stamping onto it would corrupt the body.
const stamp = (content, pn) => {
  const lines = content.split('\n');
  const at = fieldMask(lines).findIndex(Boolean);
  if (at >= 0) {
    lines[at] = `${lines[at].trimEnd()} · **Package:** ${pn}`;
    return { text: lines.join('\n'), line: lines[at] };
  }
  const title = lines.findIndex((l) => l.startsWith('# '));
  const line = `**Package:** ${pn}`;
  lines.splice(title >= 0 ? title + 1 : 0, 0, '', line);
  return { text: lines.join('\n'), line };
};

const themeOf = (name) => name
  .toLowerCase()
  .replace(/^issues?\s*p\d+\s*:?\s*/, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const pack = ({ root, commit, ownParent }, argv, issues, packages) => {
  if (!argv.length) {
    const known = new Set(packages.map((p) => p.pn).filter(Boolean));
    const loose = issues.filter((i) => !i.pkg || !known.has(i.pkg));
    if (!loose.length) { console.log('No loose issues to pack.'); return; }
    // Directive FIRST: gtg's router acts on it only when it is the first output line
    // (SKILL.md), so a list printed above it would make gtg relay the text and do
    // nothing. The list still reaches the model, which ran the command.
    console.log('GTG-DIRECTIVE: propose themed batches from the loose issues below, then call');
    console.log('  gtg issues pack <pN> --name "<Name>" --next "<first concrete step>" [--eta "<eta>"] <slug>...');
    console.log('  one call per accepted batch. Confirm the batches with the user before calling.');
    console.log('');
    printLoose(loose);
    return;
  }

  const { flags, pos, bad } = parseFlags(argv);
  const errs = [...bad];
  const pn = String(pos[0] ?? '').toLowerCase();
  const name = String(flags.name ?? '').trim();
  const next = String(flags.next ?? '').trim();
  const eta = String(flags.eta ?? '').trim();
  const wanted = pos.slice(1);

  // Without it the park would write `--parent undefined` and strand the entry under a
  // namespace nothing reads - the exact silent failure the ctx collapse exists to prevent,
  // so it refuses instead of guessing its own namespace.
  if (!ownParent) errs.push('no ownParent on the extension ctx - gtg is too old, or this command was not reached through its extension dispatch');
  if (!/^p\d+$/.test(pn)) errs.push(`first argument must be a package number like p9, got "${pos[0] ?? ''}"`);
  else if (resolve(packages, pn).length) errs.push(`${pn} already exists: ${resolve(packages, pn)[0].slug}`);
  if (!name) errs.push('missing --name "<Name>"');
  if (!next) errs.push('missing --next "<first concrete step>"');
  if (!wanted.length) errs.push('name at least one issue slug');
  // The park re-invokes process.argv[1], which is gtg.mjs ONLY under a gtg dispatch. Driven
  // any other way it is some other program, which would exit 0 on args it ignored and leave
  // pack reporting a park that never happened. Checked HERE and not at the spawn so a wrong
  // invocation cannot leave stamped files behind at all. --dry-run never spawns, so it is
  // exempt and stays usable from any harness.
  if (!flags['dry-run'] && basename(process.argv[1] ?? '') !== 'gtg.mjs') {
    errs.push(`pack parks the entry by re-invoking gtg, but the running program is "${basename(process.argv[1] ?? '(none)')}", not gtg.mjs - run it as \`gtg issues pack ...\` (add --dry-run to preview from anywhere)`);
  }

  const members = [];
  for (const w of wanted) {
    const exact = issues.filter((i) => i.slug === w);
    const hits = exact.length ? exact : issues.filter((i) => i.slug.includes(w));
    if (hits.length !== 1) {
      errs.push(hits.length
        ? `"${w}" matches ${hits.length} issues: ${hits.map((h) => h.slug).join(', ')}`
        : `"${w}" matches no issue file`);
      continue;
    }
    if (hits[0].pkg && hits[0].pkg !== pn) { errs.push(`${hits[0].slug} already belongs to ${hits[0].pkg}`); continue; }
    // `rtk-grep` and `rtk-grep-flag-mangle` both resolve to one file: count it once, or
    // the parked entry lists the same issue twice and miscounts the batch.
    if (!members.some((m) => m.file === hits[0].file)) members.push(hits[0]);
  }

  const theme = themeOf(name);
  const slug = `issues-${pn}-${theme}`;
  // A punctuation-only --name themes to '' and yields the trailing-dash slug
  // `issues-p9-`, which gtg.mjs's own [A-Za-z0-9_-] check ACCEPTS. Catching it here is
  // the only thing standing between that and a nameless parked entry.
  if (name && !theme) errs.push(`--name "${name}" has no letters or digits to build a slug from`);

  if (errs.length) {
    console.error('gtg issues pack refused, nothing written:');
    errs.forEach((e) => console.error(`  - ${e}`));
    process.exitCode = 1;
    return;
  }

  const subject = `issues: pack ${pn} - ${name} (${members.length} issue${members.length === 1 ? '' : 's'})`;
  const writes = members
    .filter((m) => m.pkg !== pn) // idempotent: an already-stamped member is left alone
    .map((m) => {
      const rel = `docs/issues/${m.file}`;
      const { text, line } = stamp(readFileSync(join(root, rel), 'utf8'), pn);
      return { rel, text, line };
    });
  const body = `## The Package
${name} bundles ${members.length} issue${members.length === 1 ? '' : 's'} from docs/issues/.

## Issues
${members.map((m) => `- docs/issues/${m.file}`).join('\n')}

## Next Action
${next}
`;
  // The parent written here is gtg.mjs's own EXTENSIONS[cmd], handed over on the ctx, so the
  // writer and the reader (ownEntries) are one copy of the fact rather than two that have to
  // be kept in step. A rename of the namespace now moves both ends at once.
  const backlogArgs = [
    'backlog', '--project', name, '--slug', slug, '--next', next, '--parent', ownParent,
    ...(eta ? ['--eta', eta] : []),
  ];

  if (flags['dry-run']) {
    console.log(`DRY RUN - would stamp ${writes.length} file(s):`);
    writes.forEach((w) => console.log(`  ${w.rel}: ${w.line}`));
    console.log(`  commit: ${subject}`);
    console.log(`  then: node <gtg.mjs> ${backlogArgs.join(' ')}`);
    return;
  }

  // A throw partway through the loop used to leave the earlier stamps on disk and
  // uncommitted, and the RETRY could never pick them up: `writes` filters on `m.pkg !== pn`,
  // so an already-stamped file is excluded from the next batch and its stamp sits in a shared
  // checkout as an unattributed dirty file. Commit whatever landed before rethrowing, so the
  // tree is never left dirty on someone else's behalf and the retry only does the remainder.
  const done = [];
  try {
    writes.forEach((w) => { writeFileSync(join(root, w.rel), w.text); done.push(w.rel); });
  } catch (e) {
    if (done.length) commit(done, `${subject} [partial: ${done.length}/${writes.length}]`);
    console.error(`gtg issues pack: stamping failed after ${done.length} of ${writes.length} file(s).`);
    done.forEach((rel) => console.error(`  stamped and committed: ${rel}`));
    console.error('  Fix: re-run the same command - already-stamped files are skipped, so it resumes.');
    throw e;
  }
  if (writes.length) commit(writes.map((w) => w.rel), subject);
  // process.argv[1] is the running gtg.mjs, checked above and not assumed, so there is no path
  // to configure. execPath + argv array, never a shell string: --name is free text.
  const r = spawnSync(process.execPath, [process.argv[1], ...backlogArgs], {
    input: body,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (r.status !== 0) {
    // r.status is null when the child was signalled or the spawn itself failed, and
    // ctx commit() swallows git's exit code, so neither the reason nor the commit can
    // be asserted here. Point at the output above instead of claiming either.
    const why = r.error?.message ?? (r.status === null ? `signal ${r.signal}` : `exit ${r.status}`);
    console.error(`gtg issues pack: ${writes.length} file(s) stamped, but parking the entry failed (${why}).`);
    console.error("  Check git's own output above for whether the commit landed.");
    // Not a hand-written `gtg backlog`: its flag values need quoting the message
    // cannot show, and it reads the handoff body from stdin, so a pasted command parks
    // a body-less entry or blocks on the TTY. Re-running pack is idempotent for
    // already-stamped files and retries only the park.
    console.error('  Fix: re-run the same `gtg issues pack` command, arguments unchanged.');
    process.exitCode = 1;
  }
};

export default ({ root, args, ownEntries, commit, ownParent }) => {
  const issues = readIssues(root);
  const packages = readPackages(ownEntries);
  const [verb, ...rest] = args ?? [];
  const v = (verb ?? '').toLowerCase();

  if (v === 'packages') return listPackages(packages);
  if (v === 'pack') return pack({ root, commit, ownParent }, rest, issues, packages);
  if (v) {
    const hits = resolve(packages, v);
    // One line, nothing else: gtg's router follows a GTG-DIRECTIVE line instead of
    // relaying it, so anything printed alongside it is never seen.
    // The step 5 exception is NAMED here rather than left to the reader, because consuming
    // this entry deletes the only live mapping from its pN to a name while every member file
    // still points at it - the package dissolves for exactly as long as you are working it.
    if (hits.length === 1) {
      console.log(`GTG-DIRECTIVE: run gtg.mjs resume ${hits[0].slug} --keep and follow the SKILL.md Resume Procedure. A package is never consumed: it is the only live pN-to-name mapping its issue files point at, and it retires by being finished (see references/commands.md, "Working a package").`);
      return;
    }
    if (hits.length > 1) {
      console.log(`"${v}" matches ${hits.length} packages - name one:`);
      hits.forEach((p) => console.log(`  • ${p.project} [${p.slug}]`));
      return;
    }
    console.log(`No issue package matches "${v}". \`gtg issues packages\` lists them, \`gtg issues\` lists every issue.`);
    return;
  }
  if (!issues.length && !packages.length) { console.log('No open issues.'); return; }
  return list(issues, packages);
};
