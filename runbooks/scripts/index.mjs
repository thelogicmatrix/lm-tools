#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, loadExtensions, settings } from "./config.mjs";

// The plugin root, so the lint's advisory names a command that runs from any cwd. The advisory
// quotes it with forward slashes, so it pastes into bash and PowerShell alike on Windows.
const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const TYPES = new Set(["procedure", "standard", "reference", "postmortem", "residual"]);
// A procedure is PULLED: you already know you are about to deploy the app, so the slug routes
// you. Standards and references are PUSHED: nothing about the task says "read powershell.md
// first", so something has to surface them or they never fire.
//
// Until 2026-09-22 that something was this hook, listing every pushed purpose at SessionStart —
// 5.9KB paid whether or not one applied. SessionStart has no prompt, so it could not tell. The
// prompt is what decides relevance, so router.mjs now does the pushed half on
// UserPromptSubmit and injects only what matches. PUSHED still splits the two groups here: it
// keeps standards and references OUT of the procedure line, and the lint still grades their
// purpose, which is now the router's question text rather than an every-session tax.
export const PUSHED = new Set(["standard", "reference"]);
// The third case, added 2026-08-25 after the pushed block reached 5.9KB in every session: a
// file whose own trigger is something the session cannot miss. A residual names one code path
// and says what is wrong in it on purpose, so it is reached by editing that path. A live
// postmortem's value is "do not re-propose this", which a slug already carries. Both were
// paying a 200-character purpose in every session that would never open them, so they get the
// retired tail's treatment instead: named, unexplained, one line.
export const SLUG_ONLY = new Map([
  ["residual", "Deliberate divergences, do not re-report these as bugs"],
  ["postmortem", "Postmortems, read before re-proposing their subject"],
]);
// A **Status:** field only retires a file when it parses as a retirement. Several files carry
// legacy prose status lines that predate this header block, and presence-alone would announce
// a live runbook as "do not re-propose" at every session start.
export const RETIRED_RE = /^retired \d{4}-\d{2}-\d{2} — \S/;
// Dormant is parked, not dead: it never routes (router.mjs) and it is named nowhere here, since
// the retired tail would tell a session "do not re-propose" a process that is only asleep.
export const DORMANT_RE = /^dormant\b/;
// Verified joined 2026-09-24: a dated "checked against reality" stamp that nine runbooks already
// carried, which this list rejected as unrecognised. It is the only freshness signal left, since the
// 2026-09 sweeps put a September commit date on every file.
const FIELDS = ["Type", "Status", "Project", "Purpose", "Run", "Verified"];
// Only the first 800 bytes count as the header. One real runbook carries a second **Purpose:**
// far down the body, and a whole-file regex would read that one instead.
const HEAD_BYTES = 800;

export function parseHeader(head) {
  const text = (head ?? "").slice(0, HEAD_BYTES);
  const found = FIELDS.map((name) => {
    // Case-insensitive on the LABEL only. One runbook carried an uppercase **STATUS:** in
    // header position and a case-sensitive match made it invisible to both the index and the
    // lint — a silently vanished field is the exact failure this header block exists to prevent.
    // RETIRED_RE stays case-sensitive: the retirement VALUE format is still exact.
    const m = new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*(.*)$`, "mi").exec(text);
    return m ? { name, value: m[1].trim(), at: m.index } : null;
  }).filter(Boolean);
  const value = (name) => found.find((f) => f.name === name)?.value || null;
  return {
    type: value("Type"),
    status: value("Status"),
    project: value("Project"),
    purpose: value("Purpose"),
    run: value("Run"),
    order: [...found].sort((a, b) => a.at - b.at).map((f) => f.name),
  };
}

export const projectTags = (text) => (parseHeader(text).project ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function lintProject(slug, text, allowed) {
  const value = parseHeader(text).project;
  if (value === null) return [new RegExp("^\\*\\*Project:\\*\\*", "mi").test(text.slice(0, HEAD_BYTES))
    ? `${slug}: empty **Project:** tag` : `${slug}: missing **Project:**`];
  const tags = value.split(",").map((s) => s.trim());
  const out = [];
  if (tags.some((s) => !s)) out.push(`${slug}: empty **Project:** tag`);
  for (const tag of tags.filter(Boolean)) {
    if (tags.filter((s) => s === tag).length > 1 && !out.includes(`${slug}: duplicate project "${tag}"`)) out.push(`${slug}: duplicate project "${tag}"`);
    if (!allowed.has(tag)) out.push(`${slug}: unknown project "${tag}"`);
  }
  return out;
}

const SPLIT_AT_WORDS = 2000;
const PURPOSE_MAX_WORDS = 25;
// A header field line. `[^*]` keeps this from spanning two bold spans, so prose like
// "**one** and **two:**" is not read as a field.
const FIELD_LINE = /^\*\*([^*]+):\*\*/;
const isField = (name) => FIELDS.some((f) => f.toLowerCase() === name.trim().toLowerCase());
// What may legally follow **Purpose:**. Anything else is a continuation line.
const endsHeaderLine = (line) =>
  line === undefined || line.trim() === "" || FIELD_LINE.test(line) || /^#{1,6}\s/.test(line);

// Runs against the WHOLE file, unlike the hook path, because two of its checks (## Steps,
// word count) live outside the header block.
export function lintFile(slug, text) {
  const h = parseHeader(text);
  const out = [];
  if (!h.type) out.push(`${slug}: missing **Type:**`);
  else if (!TYPES.has(h.type)) {
    out.push(`${slug}: unknown type "${h.type}", expected one of ${[...TYPES].join(", ")}`);
  }
  if (!h.purpose) out.push(`${slug}: missing **Purpose:**`);
  // Graded against FIELDS, the same list parseHeader recognises. A second copy of the canonical
  // order would silently drop any field added to one list and not the other, and every file
  // carrying that field would report "out of order" forever.
  const expected = FIELDS.filter((f) => h.order.includes(f));
  if (h.order.join() !== expected.join()) {
    out.push(`${slug}: header fields out of order (${h.order.join(", ")}), expected ${FIELDS.join(", ")}`);
  }
  if (h.status && !RETIRED_RE.test(h.status) && !DORMANT_RE.test(h.status)) {
    out.push(`${slug}: **Status:** marks retirement or dormancy only, expected "retired YYYY-MM-DD — why" or "dormant", got "${h.status}"`);
  }
  // Guarded on a known type: with no **Type:** the message would name the type as "null", and
  // the missing-Type violation already fired above.
  if (h.run && h.type && h.type !== "procedure") {
    out.push(`${slug}: **Run:** belongs to procedures only, this is a ${h.type}`);
  }
  // A retired procedure is a tombstone, not a process, so its Steps are not required. Keyed on
  // RETIRED_RE, not on the presence of a Status line, so this agrees with summarize: a malformed
  // retirement is not a retirement, and its missing Steps surface in the same round.
  if (h.type === "procedure" && !RETIRED_RE.test(h.status ?? "") && !/^## Steps\s*$/m.test(text)) {
    out.push(`${slug}: procedure with no ## Steps section`);
  }
  const lines = text.split("\n");
  // parseHeader matches a field as `(.*)$`, so only the FIRST physical line of a **Purpose:**
  // is ever read. A wrapped purpose therefore truncates in the index with no symptom: 14 of 49
  // files wrapped, and one pushed reference lost its "when it applies" clause to line 4, so no
  // session ever saw the half that decides whether to open the file.
  // Guarded on h.purpose so a body-only **Purpose:** past HEAD_BYTES is not graded as a header.
  const purposeAt = lines.findIndex((l) => /^\*\*Purpose:\*\*/i.test(l));
  if (h.purpose && purposeAt >= 0 && !endsHeaderLine(lines[purposeAt + 1])) {
    out.push(`${slug}: **Purpose:** wraps onto the next line, only the first line reaches the index, keep it to one physical line`);
  }
  // The four fields are a closed set and nothing rejected a fifth, which is the catch-all this
  // header block exists to end reappearing at the field name. Scope is the CONTIGUOUS run of
  // field lines holding the header: a blank line ends it, so the bold lead-in that opens the
  // body of four real runbooks stays prose. A window measured in bytes instead would grade
  // those by how long the lines above them ran.
  const headLineCount = text.slice(0, HEAD_BYTES).split("\n").length;
  const anchor = lines.findIndex((l, i) => {
    const m = i < headLineCount && FIELD_LINE.exec(l);
    return m && isField(m[1]);
  });
  if (anchor >= 0) {
    let first = anchor;
    let last = anchor;
    while (first > 0 && FIELD_LINE.test(lines[first - 1])) first--;
    while (last + 1 < lines.length && FIELD_LINE.test(lines[last + 1])) last++;
    for (const line of lines.slice(first, last + 1)) {
      const name = FIELD_LINE.exec(line)[1];
      if (!isField(name)) {
        out.push(`${slug}: unrecognised header field **${name}:**, expected one of ${FIELDS.join(", ")}`);
      }
    }
  }
  // A pushed purpose is no longer injected every session, but it is now the text router.mjs
  // asks Jev to judge, one question per runbook in a single call. A rambling purpose makes a worse
  // question, and it is still what gets injected on a match or a fallback. 25 words is where the ten
  // longest sat after the 2026-08-27 trim, which took ~90 words off the index.
  const pwords = (h.purpose ?? "").split(/\s+/).filter(Boolean).length;
  if (PUSHED.has(h.type) && pwords > PURPOSE_MAX_WORDS) {
    out.push(`${slug}: pushed purpose is ${pwords} words, keep it to ${PURPOSE_MAX_WORDS} (it is the router's question text)`);
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > SPLIT_AT_WORDS) out.push(`${slug}: ${words} words, consider splitting`);
  return out;
}

// Local paths a runbook names in backticks that no longer exist on this machine. Advisory, like
// split candidates: a line that names a path as history ("the old worktree at ...") is a
// legitimate miss, so this lists and never fails. On 2026-09-24 it found 20 of 133 missing across
// 15 runbooks, including one sending readers to a deleted worktree. Placeholders and
// templated paths (`<slug>`, `$VAR`, `%TEMP%`, an ellipsis) are skipped because they never exist.
export function missingPaths(text, exists = existsSync, home = homedir()) {
  const out = [];
  // homedir() is backslashed on Windows. Forward slashes keep the report in the runbooks' own form.
  const base = home.replace(/\\/g, "/");
  for (const m of text.matchAll(/`((?:[A-Za-z]:[\\/]|~\/)[^`\s]+)`/g)) {
    const p = m[1].replace(/^~\//, () => base + "/").replace(/[.,:;)]+$/, "");
    if (/[<>*?"|$%{}[\]…]/.test(p)) continue;
    if (!exists(p)) out.push(p);
  }
  return [...new Set(out)];
}

// Shared by the index and the lint so the lint prices the real string, not an estimate of it.
export function retiredTail(retired) {
  return `Retired, do not re-propose: ` + retired.map((e) => `${e.slug} (${e.status})`).join(" | ") + `.`;
}

// Runbooks are only consulted when the session knows they exist. The CLAUDE.md pointer names
// the directory but not its contents, so nothing surfaces a runbook unprompted. This injects
// the index at SessionStart.
// Procedures and the pushed types both carry their purpose. Procedures are PULLED, so the slug
// was meant to be enough — but a slug only routes when the task names the same noun. The
// 2026-08-17 deploy task missed a container-networking runbook because the task named the
// app rather than the mechanism, and the slug names the mechanism, not the goal. The purpose line is the only
// place the goal words live, so it rides the index too; a procedure with no purpose line
// still injects as a bare slug. Residuals, postmortems and retired
// files keep a compact tail: a retired DNS-proxy runbook's entire value is stopping a future
// session re-proposing it, so dropping it from the index recreates the problem a graveyard exists
// to solve, but a slug carries that on its own.
// `pushed` is opt-in for a harness with no per-prompt router. Where router.mjs does the pushed
// half per prompt the default stays off, and `--pushed` hands a router-less caller the full
// block. Added as a trailing option so the two-argument callers get exactly what they got before.
// `nudges` is the list runNudges returns, one line each, appended after the tails.
export function summarize(entries, nudges = [], { pushed: withPushed = false } = {}) {
  entries = entries.filter((e) => !DORMANT_RE.test(e.status ?? ""));
  const byslug = (a, b) => a.slug.localeCompare(b.slug);
  const isRetired = (e) => RETIRED_RE.test(e.status ?? "");
  const live = entries.filter((e) => !isRetired(e)).sort(byslug);
  const retired = entries.filter(isRetired).sort(byslug);
  if (live.length === 0 && retired.length === 0) return null;
  // An untyped file still lands here rather than vanishing: an unknown type is a lint
  // violation, not a reason to drop a runbook out of the index entirely.
  // Procedures joined standards and references behind `pushed` on 2026-09-22, for the same reason
  // and by the same gate. They stayed unconditional until then because the router could not
  // see a procedure at all: it kept standards and references only, so gating this block
  // then would have deleted procedure discovery outright. The router now keeps procedures, and the
  // deploy case this block's comment cites went 0 of 7 to 6 of 7, that case included.
  const pulled = withPushed
    ? live.filter((e) => !PUSHED.has(e.type) && !SLUG_ONLY.has(e.type))
    : [];
  const lines = [];
  if (pulled.length) {
    lines.push(
      `${pulled.length} runbook procedure${pulled.length === 1 ? "" : "s"}, ` +
        `read docs/runbooks/<slug>.md before running one:\n` +
        pulled.map((e) => (e.purpose ? `- ${e.slug} — ${e.purpose}` : `- ${e.slug}`)).join("\n")
    );
  }
  // Standards and references are listed only on request. They used to be unconditional, at 6.9KB in
  // every session: SessionStart has no prompt, so it could not tell which of the 37 applied and paid
  // for all of them. router.mjs asks that question on UserPromptSubmit, where a prompt
  // exists, and injects a mean of 3.8. Without a router the 6.9KB still beats losing
  // discovery of all 37. Either way they are filtered out of `pulled` above so they never leak into
  // the procedure line.
  const pushed = withPushed ? live.filter((e) => PUSHED.has(e.type)) : [];
  if (pushed.length) {
    lines.push(
      "Standards and references that apply whether or not you went looking for them:\n" +
        pushed.map((e) => `- ${e.slug} — ${e.purpose ?? "(no purpose line)"}`).join("\n")
    );
  }
  for (const [type, lead] of SLUG_ONLY) {
    const group = live.filter((e) => e.type === type);
    if (group.length) lines.push(`${lead}: ${group.map((e) => e.slug).join(", ")}.`);
  }
  if (retired.length) lines.push(retiredTail(retired));
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: [...lines, ...[nudges].flat().filter(Boolean)].join("\n"),
    },
  };
}

// .runbooks/nudges/*.mjs, all started at once under one shared deadline. A throw, a non-string
// or a nudge still pending at the deadline drops that nudge only. `exts` may be the pending
// loadExtensions() promise, and then the deadline covers the imports too. An import still
// pending at the deadline drops every nudge, since loadExtensions imports them in turn.
// ponytail: all-or-nothing on a slow import, per-file import races if one slow file ever costs
// the others their line. The 1.2 s default keeps the hook under 2 s wall: node spawn and teardown cost about 400 ms on the measuring laptop, and a
// nudge waiting on an unreachable server measured 1.84 to 2.10 s at a 1.5 s deadline.
export async function runNudges(exts, ctx, deadlineMs = 1200) {
  let timer;
  const deadline = new Promise((r) => (timer = setTimeout(r, deadlineMs, null)));
  const loaded = (await Promise.race([exts, deadline])) ?? [];
  const results = await Promise.all(
    loaded.map(({ fn }) => Promise.race([Promise.resolve().then(() => fn(ctx)).catch(() => null), deadline]))
  );
  clearTimeout(timer);
  return results.filter((s) => typeof s === "string" && s);
}

// .runbooks/lint/*.mjs, run per file. A rule that throws or returns something other than an
// array adds nothing, so one broken rule never hides the core violations.
export function runLintExtensions(exts, file) {
  return exts.flatMap(({ fn }) => {
    try {
      const r = fn(file);
      return Array.isArray(r) ? r.filter((s) => typeof s === "string") : [];
    } catch {
      return [];
    }
  });
}

// One definition of what counts as a runbook, shared by the hook and the lint. Two copies could
// drift in either direction, and the lint's whole value is grading the corpus the index consumes.
// Throws if the directory is unreadable; each caller decides what that means.
function runbookFiles(dir) {
  // README is format doctrine, not a process.
  return { dir, files: readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort() };
}

// The lint shares the hook's parser deliberately. A separate script would carry its own copy
// of these rules and drift from the ones the index actually applies.
async function runLint() {
  const { root, dir: found, ledger } = settings();
  if (!found) {
    console.error("No runbooks folder found (RUNBOOKS_DIR, .runbooks/config.json dir, docs/runbooks).");
    process.exitCode = 1;
    return;
  }
  const { dir, files } = runbookFiles(found);
  const projects = loadConfig(root).projects;
  const allowed = Array.isArray(projects) ? new Set(projects) : null;
  const rules = await loadExtensions(root, "lint");
  const problems = files.flatMap((f) => {
    const slug = f.slice(0, -3);
    const text = readFileSync(join(dir, f), "utf8");
    return [...lintFile(slug, text), ...(allowed ? lintProject(slug, text, allowed) : []), ...runLintExtensions(rules, { slug, text, header: parseHeader(text) })];
  });
  if (allowed && existsSync(join(dir, "retired"))) {
    for (const f of runbookFiles(join(dir, "retired")).files) {
      problems.push(...lintProject(`retired/${f.slice(0, -3)}`, readFileSync(join(dir, "retired", f), "utf8"), allowed));
    }
  }
  const splits = problems.filter((p) => p.endsWith("consider splitting"));
  const violations = problems.filter((p) => !p.endsWith("consider splitting"));
  for (const p of violations) console.log(p);
  // Split candidates are advisory: the deferred Approach C needs evidence, not a failing gate.
  if (splits.length) console.log(`\n${splits.length} split candidates (advisory, not violations):`);
  for (const p of splits) console.log(`  ${p}`);
  console.log(`\n${files.length} runbooks, ${violations.length} violations.`);
  // Retirement is permanent by design, so nothing ever falls out of the tail on its own, and no
  // per-file rule can tell a tombstone that still earns its place (a retired DNS proxy: nothing
  // stops a future session re-proposing it) from one that has outlived its subject. An age rule would
  // fire on the good ones forever, which is how a check gets ignored. What can be stated without
  // guessing is the price, so the lint prints that and leaves the judgement where it belongs.
  const retired = files
    .map((f) => ({ slug: f.slice(0, -3), ...parseHeader(readFileSync(join(dir, f), "utf8").slice(0, HEAD_BYTES)) }))
    .filter((e) => RETIRED_RE.test(e.status ?? ""));
  if (retired.length) {
    console.log(
      `${retired.length} retired, ${retiredTail(retired).length} chars of every session index. ` +
        `Keep the ones a future session could re-propose, delete the rest (git keeps them).`
    );
  }
  // Both below are advisory: they name work, they never fail the lint.
  const live = files
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8") }))
    .map((e) => ({ ...e, h: parseHeader(e.text) }))
    .filter((e) => !RETIRED_RE.test(e.h.status ?? "") && !DORMANT_RE.test(e.h.status ?? ""));
  const dead = live.flatMap((e) => missingPaths(e.text).map((p) => `${e.file.slice(0, -3)}: ${p}`));
  if (dead.length) {
    console.log(`\n${dead.length} local paths named in live runbooks are missing (advisory, fix them or mark them as history):`);
    for (const d of dead) console.log(`  ${d}`);
  }
  // The router ledger remembers which purpose text was last scored. A purpose that moved since
  // then has not been tested, and --changed re-runs only those.
  const L = await import("./ledger.mjs");
  const routable = live.filter((e) => ["standard", "reference", "procedure"].includes(e.h.type) && e.h.purpose);
  const t = L.triage(
    routable.map((e) => ({ file: e.file, purpose: e.h.purpose })),
    L.load(ledger)
  );
  if (t.changed.length || t.untested.length) {
    console.log(
      `\n${t.changed.length} purposes changed since their router check, ${t.untested.length} never checked ` +
        `(advisory): node "${join(PLUGIN, "scripts", "check.mjs").replace(/\\/g, "/")}" --changed`
    );
    for (const f of t.changed) console.log(`  changed: ${f}`);
    for (const f of t.untested) console.log(`  never checked: ${f}`);
  }
  process.exitCode = violations.length ? 1 : 0;
}

// A SessionStart hook gets a JSON payload on stdin. A TTY, an empty pipe or bad JSON reads as {}.
// A sync read of fd 0 waits for EOF, so a pipe left open with nothing written hung the hook. The
// read now has a deadline, and a caller that misses it resolves from the process cwd instead.
// ponytail: 500 ms is headroom, not a measurement. A harness writes and closes at once, so only a
// caller that never closes stdin ever waits it out.
async function readInput(ms = 500) {
  if (process.stdin.isTTY) return {};
  let raw = "";
  await new Promise((done) => {
    const timer = setTimeout(done, ms);
    const finish = () => (clearTimeout(timer), done());
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
  process.stdin.destroy();
  try {
    return JSON.parse(raw || "{}") ?? {};
  } catch {
    return {};
  }
}

async function main() {
  if (process.argv.includes("--lint")) return runLint();
  const input = await readInput();
  const { root, dir } = settings({ cwd: typeof input.cwd === "string" ? input.cwd : undefined });
  if (!dir) return; // no runbooks folder: silent, installing the plugin costs nothing
  let files;
  try {
    ({ files } = runbookFiles(dir));
  } catch {
    return; // missing/unreadable — fail silent, never block a session start
  }
  const entries = files
    .map((f) => {
      const slug = f.slice(0, -3);
      try {
        // The read is whole-file; it is the PARSE that is capped at HEAD_BYTES. That cap is
        // correctness, not speed: one real runbook carries a second **Purpose:** far down the
        // body, and an uncapped parse would read that one as the header's. A bounded
        // open/read was considered and skipped — 49 small markdown files is not the thing
        // to optimise, so if you are here for session-start latency, look elsewhere.
        return { slug, ...parseHeader(readFileSync(join(dir, f), "utf8").slice(0, HEAD_BYTES)) };
      } catch {
        // One unreadable file must not cost the other 48 their index line.
        return { slug, type: null, status: null, purpose: null, run: null, order: [] };
      }
    });
  // The imports start here, after the reads, and runNudges holds them to its deadline. They used to
  // start first on the theory that they overlapped the reads, but the reads are sync and block the
  // loop, so nothing overlapped, and a slow import waited outside the deadline entirely.
  const nudges = await runNudges(loadExtensions(root, "nudges"), { root, dir, entries });
  const out = summarize(entries, nudges, { pushed: process.argv.includes("--pushed") });
  // Exit explicitly once the output is flushed. A nudge dropped at the deadline can still hold
  // the process open: a half-open TCP connect measured keeping it alive to about 10.8 s.
  process.stdout.write(out ? JSON.stringify(out) + "\n" : "", () => process.exit());
}

// argv[1] is undefined under `node -e`, and pathToFileURL throws on undefined rather than
// returning nothing, which made this module unimportable from an inline script.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
