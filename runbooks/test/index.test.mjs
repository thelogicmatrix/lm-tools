import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, parseHeader, lintFile, retiredTail, missingPaths } from "../scripts/index.mjs";
import * as projectIndex from "../scripts/index.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = (slug, type, purpose, status = null) => ({ slug, type, purpose, status });

test("summarize returns null when there are no entries", () => {
  assert.equal(summarize([]), null);
});

// Procedures moved behind `pushed` on 2026-09-22, the same treatment standards and references got
// in an earlier commit and for the same reason: the router can route a procedure now, so paying
// 2,973 tokens to list all 43 at every SessionStart buys Claude nothing. Codex has no router and
// still gets them. The rendering assertions below are unchanged, they just moved to the caller
// that still renders.
test("summarize lists procedures with their purpose, sorted, on the pushed path", () => {
  const result = summarize([
    entry("mkv-audio-default", "procedure", "Set the default MKV audio track."),
    entry("acme-deploy", "procedure", "Ship the Acme scraper."),
  ], [], { pushed: true });
  // A wrong event name throws nowhere — the harness just ignores the output — so it is
  // asserted somewhere rather than nowhere.
  assert.equal(result.hookSpecificOutput.hookEventName, "SessionStart");
  const out = result.hookSpecificOutput.additionalContext;
  assert.match(out, /2 runbook procedures, read docs\/runbooks\/<slug>\.md before running one:/);
  assert.match(out, /- acme-deploy — Ship the Acme scraper\.\n- mkv-audio-default — Set the default MKV audio track\./);
});

test("summarize falls back to a bare slug for a procedure with no purpose line", () => {
  const out = summarize([entry("homepage", "procedure", null)], [], { pushed: true }).hookSpecificOutput.additionalContext;
  assert.match(out, /^- homepage$/m);
});

// Reversed 2026-09-22. This block was 6.9KB of every session, because SessionStart has no prompt
// and so could not tell which of 37 standards applied. The router asks that on
// UserPromptSubmit instead. What must hold here is that a pushed type is absent AND is not quietly
// swallowed into the procedure line, which is what `pulled`'s PUSHED filter exists to prevent.
test("summarize injects no per-document line at all at session start", () => {
  const out = summarize([
    entry("powershell", "standard", "Encoding and quoting rules for PowerShell."),
    entry("key-directory", "reference", "Names-only directory of every credential."),
    entry("acme-deploy", "procedure", "Ship the Acme scraper."),
  ]).hookSpecificOutput.additionalContext;
  assert.ok(!out.includes("powershell"), "a standard must not ride the session-start index");
  assert.ok(!out.includes("key-directory"), "a reference must not ride the session-start index");
  assert.ok(!out.includes("quoting rules"), "nor may its purpose");
  // The one that changed on 2026-09-22. A procedure is routable now, so it is no longer listed
  // here either, and the Claude default is down to the tails: residuals, postmortems, retired
  // tombstones and the staleness nudge. Asserted by absence of the heading AND of the row, because
  // a count line reading "0 runbook procedures" would also satisfy a heading-only check.
  assert.ok(!out.includes("acme-deploy"), "nor may a procedure");
  assert.doesNotMatch(out, /runbook procedures?, read docs\/runbooks/);
});

// Codex runs this same script and had no per-prompt router, so without the pushed block it lost
// discovery of all 37 standards and references outright. The flag brings the earlier block
// back for that caller only, and the two tests below pin both directions.
test("summarize with the pushed option emits standards and references with their purposes", () => {
  const out = summarize([
    entry("powershell", "standard", "Encoding and quoting rules for PowerShell."),
    entry("key-directory", "reference", "Names-only directory of every credential."),
    entry("acme-deploy", "procedure", "Ship the Acme scraper."),
  ], [], { pushed: true }).hookSpecificOutput.additionalContext;
  assert.match(out, /^Standards and references that apply whether or not you went looking for them:$/m);
  assert.match(out, /^- key-directory — Names-only directory of every credential\.$/m);
  assert.match(out, /^- powershell — Encoding and quoting rules for PowerShell\.$/m);
  // The block is additive. A standard still must not be counted as, or listed under, a procedure.
  assert.match(out, /1 runbook procedure, read docs\/runbooks\/<slug>\.md before running one:/);
  const procedureLines = out.split("Standards and references")[0];
  assert.ok(!procedureLines.includes("powershell"), "a standard must not leak into the procedure line");
  assert.ok(!procedureLines.includes("key-directory"), "nor may a reference");
});

test("summarize names a pushed file with no purpose line rather than dropping it", () => {
  const out = summarize([entry("orphan", "reference", null)], [], { pushed: true })
    .hookSpecificOutput.additionalContext;
  assert.match(out, /^- orphan — \(no purpose line\)$/m);
});

test("summarize names a residual and a live postmortem without their purpose", () => {
  const out = summarize([
    entry("adapter-residuals", "residual", "The deferred findings from the adapter review."),
    entry("gpu-driver-crashes", "postmortem", "Reach for this on a laptop GPU crash."),
  ]).hookSpecificOutput.additionalContext;
  assert.match(out, /^Deliberate divergences, do not re-report these as bugs: adapter-residuals\.$/m);
  assert.match(out, /^Postmortems, read before re-proposing their subject: gpu-driver-crashes\.$/m);
  // The whole point of the change: neither pays for a purpose in a session that will
  // never open it, and neither is silently swallowed into the procedure line either.
  assert.ok(!out.includes("deferred findings"), "a residual's purpose must not be injected");
  assert.ok(!out.includes("laptop GPU crash"), "a postmortem's purpose must not be injected");
  assert.ok(!out.includes("runbook procedure"), "neither belongs in the procedure line");
});

test("summarize omits a slug-only line when nothing carries that type", () => {
  const out = summarize([entry("powershell", "standard", "Quoting rules.")])
    .hookSpecificOutput.additionalContext;
  assert.ok(!out.includes("Deliberate divergences"));
  assert.ok(!out.includes("Postmortems, read"));
});

test("a retired residual goes to the retired tail, not the residual line", () => {
  const out = summarize([
    entry("old-residuals", "residual", "Was a divergence.", "retired 2026-08-25 — path deleted."),
  ]).hookSpecificOutput.additionalContext;
  assert.match(out, /Retired, do not re-propose: old-residuals/);
  assert.ok(!out.includes("Deliberate divergences"));
});

test("summarize treats an unparseable type as a procedure", () => {
  const out = summarize([entry("mystery", null, "No type line yet.")], [], { pushed: true }).hookSpecificOutput.additionalContext;
  assert.match(out, /1 runbook procedure, read docs\/runbooks\/<slug>\.md before running one:/);
  assert.match(out, /- mystery — No type line yet\./);
});

test("summarize moves a retired file into the tail and out of both groups", () => {
  const out = summarize([
    entry("acme-deploy", "procedure", "Ship the Acme scraper."),
    entry("old-promo-ops", "procedure", "Ran the daily promo nudge.", "retired 2026-07-16 — promo ended."),
    entry("powershell", "standard", "Encoding and quoting rules."),
  ], [], { pushed: true }).hookSpecificOutput.additionalContext;
  assert.match(out, /1 runbook procedure, read docs\/runbooks\/<slug>\.md before running one:/);
  // Drop the retirement filter and the procedure list gains a "- old-promo-ops — …" row, so
  // match the slug against that row specifically. Its presence in the retired tail below is
  // the whole point of the test.
  assert.doesNotMatch(out, /^- old-promo-ops/m);
  assert.match(out, /Retired, do not re-propose: old-promo-ops \(retired 2026-07-16 — promo ended\.\)/);
});

// A reference no longer renders anywhere at session start, so "it is still live" is now read off
// the retired tail: if the classifier had retired it, the tail would name it. The procedure beside
// it keeps the assertion honest, proving the output is populated rather than empty for some other
// reason.
test("summarize keeps a live file out of the tail when its Status is legacy prose", () => {
  const out = summarize([
    entry("study-notes", "reference", "How conceptual learning sessions run.", "A live stub, not a retirement."),
    entry("acme-deploy", "procedure", "Ship the Acme scraper."),
  ], [], { pushed: true }).hookSpecificOutput.additionalContext;
  assert.ok(!out.includes("Retired, do not re-propose"), "a non-retirement Status must not retire the file");
  // Read off the pushed path since 2026-09-22, and it is a stronger check than the absence it
  // replaced: the reference is not merely missing from the retired tail, it is rendered as live.
  assert.match(out, /^- study-notes — How conceptual learning sessions run\.$/m);
  assert.match(out, /- acme-deploy — Ship the Acme scraper\./);
});

// Dormant is the difference from retired: a retired file is a tombstone that SessionStart names so
// nobody re-proposes it, a dormant one is a live process parked for now. Naming it in the tail would
// read as "dead, do not re-propose", which is wrong, so it must vanish from every line.
test("summarize drops a dormant file from every line, the retired tail included", () => {
  const out = summarize([
    entry("task-board", "procedure", "Run the task board.", "dormant 2026-09-24, project paused"),
    entry("task-automation", "postmortem", "What the automation taught.", "dormant 2026-09-24, project paused"),
    entry("acme-deploy", "procedure", "Ship the Acme scraper."),
  ], [], { pushed: true }).hookSpecificOutput.additionalContext;
  assert.ok(!out.includes("task-board"), "a dormant procedure must not be listed, even on the pushed path");
  assert.ok(!out.includes("task-automation"), "nor a dormant postmortem in the slug-only line");
  assert.ok(!out.includes("Retired, do not re-propose"), "and dormant is not a tombstone");
  // Proves the output is populated for the right reason rather than empty.
  assert.match(out, /- acme-deploy — Ship the Acme scraper\./);
});

test("summarize retires a file whose Status parses as a retirement", () => {
  const out = summarize([
    entry("old-promo-ops", "procedure", "Ran the daily promo nudge.", "retired 2026-07-16 — promo ended."),
  ]).hookSpecificOutput.additionalContext;
  assert.match(out, /Retired, do not re-propose: old-promo-ops \(retired 2026-07-16 — promo ended\.\)/);
});

test("summarize appends each nudge on its own line, and omits nulls", () => {
  const one = [entry("powershell", "standard", "Rules.")];
  const lines = summarize(one, ["SWEEP DUE", null, "PARITY"]).hookSpecificOutput.additionalContext.split("\n");
  assert.deepEqual(lines.slice(-2), ["SWEEP DUE", "PARITY"]);
  assert.ok(!summarize(one, [null, null]).hookSpecificOutput.additionalContext.includes("SWEEP"));
});

test("parseHeader reads all four fields and records their order", () => {
  const h = parseHeader(
    "# Acme Deploy\n" +
      "**Type:** procedure\n" +
      "**Purpose:** Ship the Acme scraper to the server.\n" +
      "**Run:** `node scripts/deploy.mjs`\n"
  );
  assert.equal(h.type, "procedure");
  assert.equal(h.purpose, "Ship the Acme scraper to the server.");
  assert.equal(h.run, "`node scripts/deploy.mjs`");
  assert.equal(h.status, null);
  assert.deepEqual(h.order, ["Type", "Purpose", "Run"]);
});

test("parseHeader reads a retirement status", () => {
  const h = parseHeader(
    "# Old Promo Ops\n" +
      "**Type:** procedure\n" +
      "**Status:** retired 2026-07-16 — promo ended, automation torn down.\n" +
      "**Purpose:** Ran the daily promo nudge.\n"
  );
  assert.equal(h.status, "retired 2026-07-16 — promo ended, automation torn down.");
  assert.deepEqual(h.order, ["Type", "Status", "Purpose"]);
});

test("Project parses after Status and preserves comma-separated slugs", () => {
  const source = "# Work\n**Type:** reference\n**Status:** retired 2026-09-24 \u2014 done\n**Project:** acme, project-b\n**Purpose:** Old work.\n";
  const h = parseHeader(source);
  assert.equal(h.project, "acme, project-b");
  assert.deepEqual(h.order, ["Type", "Status", "Project", "Purpose"]);
  assert.deepEqual(projectIndex.projectTags(source), ["acme", "project-b"]);
  assert.deepEqual(lintFile("work", source), []);
});

test("project lint rejects missing, empty, duplicate, and unknown slugs", () => {
  const allowed = new Set(["acme", "project-b"]);
  const base = "# X\n**Type:** reference\n**Purpose:** Example.\n";
  assert.match(projectIndex.lintProject("x", base, allowed).join(" "), /missing \*\*Project:\*\*/);
  assert.match(projectIndex.lintProject("x", base.replace("**Purpose:**", "**Project:** \n**Purpose:**"), allowed).join(" "), /empty \*\*Project:\*\*/);
  assert.match(projectIndex.lintProject("x", base.replace("**Purpose:**", "**Project:** acme, acme\n**Purpose:**"), allowed).join(" "), /duplicate project/);
  assert.match(projectIndex.lintProject("x", base.replace("**Purpose:**", "**Project:** other\n**Purpose:**"), allowed).join(" "), /unknown project/);
  assert.deepEqual(projectIndex.lintProject("x", base.replace("**Purpose:**", "**Project:** acme, project-b\n**Purpose:**"), allowed), []);
});

test("--lint checks Project in retired legacy notes without applying other header rules", (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "runbooks-project-lint-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  const dir = join(root, "docs", "runbooks");
  mkdirSync(join(dir, "retired"), { recursive: true });
  mkdirSync(join(root, ".runbooks"));
  writeFileSync(join(root, ".runbooks", "config.json"), JSON.stringify({ dir, projects: ["acme"] }));
  writeFileSync(join(dir, "live.md"), "# Live\n**Type:** reference\n**Project:** acme\n**Purpose:** Live.\n");
  const old = join(dir, "retired", "old.md");
  writeFileSync(old, "---\nname: old\n---\n**Status:** retired 2026-09-24 \u2014 done\n**Project:** acme\n");
  const env = { ...process.env, HOME: root, USERPROFILE: root, LOCALAPPDATA: root, RUNBOOKS_DIR: "" };
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/index.mjs", import.meta.url)), "--lint"], { cwd: root, env, encoding: "utf8" });
  const good = run();
  assert.equal(good.status, 0, good.stdout + good.stderr);
  writeFileSync(old, "---\nname: old\n---\n**Status:** retired 2026-09-24 \u2014 done\n");
  const bad = run();
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /retired\/old: missing \*\*Project:\*\*/);
  assert.doesNotMatch(bad.stdout, /retired\/old: missing \*\*(Type|Purpose):\*\*/);
});

test("parseHeader matches a field label in any case", () => {
  // One runbook carried **STATUS:** in header position and a case-sensitive label match made
  // it invisible to both the index and the lint. A field that vanishes silently is the failure
  // this header block exists to prevent, so the label is matched case-insensitively.
  const h = parseHeader(
    "# Disk Cleanup\n" +
      "**type:** procedure\n" +
      "**STATUS:** shipped 2026-07-12.\n" +
      "**Purpose:** Reclaim space.\n"
  );
  assert.equal(h.type, "procedure");
  assert.equal(h.status, "shipped 2026-07-12.");
  assert.deepEqual(h.order, ["Type", "Status", "Purpose"]);
});

test("a case-insensitive label does not loosen the retirement VALUE format", () => {
  // Only the label is case-tolerant. "RETIRED 2026-07-16 — …" is not a retirement, so the file
  // stays live and its Status is reported as malformed.
  const text = "# Old Thing\n**Type:** procedure\n**Status:** RETIRED 2026-07-16 — done.\n**Purpose:** x.\n";
  const out = lintFile("old-thing", text);
  assert.ok(out.some((p) => p.includes("marks retirement or dormancy only")));
  assert.ok(out.some((p) => p.includes("no ## Steps")));
});

test("parseHeader returns nulls for a file with no header block", () => {
  const h = parseHeader("# Some Runbook\n\nJust prose, no fields.\n");
  assert.deepEqual(h, { type: null, status: null, project: null, purpose: null, run: null, order: [] });
});

test("parseHeader ignores a **Purpose:** that appears past the header block", () => {
  // One real runbook does carry a second **Purpose:** deep in the body.
  const head = "# Disk Cleanup\n**Type:** procedure\n**Purpose:** The real one.\n";
  const body = "x".repeat(900) + "\n**Purpose:** A later heading, not the header.\n";
  assert.equal(parseHeader(head + body).purpose, "The real one.");
});

const GOOD = "# Acme Deploy\n**Type:** procedure\n**Purpose:** Ship it.\n**Run:** `x`\n\n## Steps\n1. Go.\n";

test("lintFile passes a well-formed procedure", () => {
  assert.deepEqual(lintFile("acme-deploy", GOOD), []);
});

test("lintFile catches a missing or unknown type", () => {
  assert.deepEqual(lintFile("x", "# X\n**Purpose:** p.\n\n## Steps\n1. a\n"), ["x: missing **Type:**"]);
  assert.deepEqual(lintFile("x", "# X\n**Type:** guide\n**Purpose:** p.\n\n## Steps\n1. a\n"), [
    'x: unknown type "guide", expected one of procedure, standard, reference, postmortem, residual',
  ]);
});

test("lintFile catches a missing purpose", () => {
  assert.deepEqual(lintFile("x", "# X\n**Type:** standard\n"), ["x: missing **Purpose:**"]);
});

test("lintFile catches header fields out of canonical order", () => {
  const out = lintFile("x", "# X\n**Purpose:** p.\n**Type:** standard\n");
  assert.deepEqual(out, ["x: header fields out of order (Purpose, Type), expected Type, Status, Project, Purpose, Run, Verified"]);
});

test("lintFile catches a Status line that is not a retirement", () => {
  const out = lintFile("x", "# X\n**Type:** standard\n**Status:** active\n**Purpose:** p.\n");
  assert.deepEqual(out, ['x: **Status:** marks retirement or dormancy only, expected "retired YYYY-MM-DD — why" or "dormant", got "active"']);
});

test("lintFile accepts a dormant Status and still asks a dormant procedure for Steps", () => {
  assert.deepEqual(lintFile("x", "# X\n**Type:** reference\n**Status:** dormant 2026-09-24, parked\n**Purpose:** p.\n"), []);
  // Dormant is parked, not dead, so the process has to survive intact for the day it wakes.
  assert.deepEqual(lintFile("x", "# X\n**Type:** procedure\n**Status:** dormant\n**Purpose:** p.\n"),
    ["x: procedure with no ## Steps section"]);
});

test("lintFile accepts a proper retirement and stops asking for Steps", () => {
  const text = "# X\n**Type:** procedure\n**Status:** retired 2026-07-16 — promo ended.\n**Purpose:** p.\n";
  assert.deepEqual(lintFile("x", text), []);
});

test("lintFile catches a Run line on a non-procedure", () => {
  const out = lintFile("x", "# X\n**Type:** standard\n**Purpose:** p.\n**Run:** `x`\n");
  assert.deepEqual(out, ["x: **Run:** belongs to procedures only, this is a standard"]);
});

test("lintFile catches a live procedure with no ## Steps", () => {
  const out = lintFile("x", "# X\n**Type:** procedure\n**Purpose:** p.\n");
  assert.deepEqual(out, ["x: procedure with no ## Steps section"]);
});

test("lintFile accepts every header field present, in canonical order", () => {
  // Guards the order rule against the expected list drifting from the list parseHeader actually
  // recognises: drop a field from one side and this all-four-fields header lints as out of order.
  const text = "# X\n**Type:** procedure\n**Status:** retired 2026-07-16 — promo ended.\n**Purpose:** p.\n**Run:** `x`\n";
  assert.deepEqual(lintFile("x", text), []);
});

test("lintFile still demands Steps when the Status is not a real retirement", () => {
  // A hyphen where the em dash belongs. summarize would not call this retired, so the lint
  // must not treat it as retired either, or the missing Steps take a second round to surface.
  const out = lintFile("x", "# X\n**Type:** procedure\n**Status:** retired 2026-07-16 - promo ended.\n**Purpose:** p.\n");
  assert.deepEqual(out, [
    'x: **Status:** marks retirement or dormancy only, expected "retired YYYY-MM-DD — why" or "dormant", got "retired 2026-07-16 - promo ended."',
    "x: procedure with no ## Steps section",
  ]);
});

test("lintFile does not name a null type in the Run rule", () => {
  const out = lintFile("x", "# X\n**Purpose:** p.\n**Run:** `x`\n");
  assert.deepEqual(out, ["x: missing **Type:**"]);
});

// The parser matches a field as `(.*)$`, so only the FIRST physical line of **Purpose:** is ever
// read. 14 of 49 files wrapped their purpose, and for a pushed type that silently truncates the
// index line: a learning profile's "when it applies" clause lived on line 4 and never
// reached a session. Nothing stated Purpose had to be one physical line, so nothing caught it.
test("lintFile catches a Purpose that wraps onto a continuation line", () => {
  const text = "# X\n**Type:** standard\n**Purpose:** plan a team offsite end to end: book the venue,\nconfirm the headcount and dates.\n";
  assert.deepEqual(lintFile("x", text), [
    "x: **Purpose:** wraps onto the next line, only the first line reaches the index, keep it to one physical line",
  ]);
});

test("lintFile accepts a Purpose terminated by a blank line, a field, or a heading", () => {
  // Three legitimate successors. GOOD covers the field case; a blank line and a heading are the
  // other two ways a header block ends, and flagging either would be a false positive.
  assert.deepEqual(lintFile("x", "# X\n**Type:** standard\n**Purpose:** p.\n\nProse.\n"), []);
  assert.deepEqual(lintFile("x", "# X\n**Type:** standard\n**Purpose:** p.\n**Run:** `x`\n"), [
    "x: **Run:** belongs to procedures only, this is a standard",
  ]);
  assert.deepEqual(lintFile("x", "# X\n**Type:** standard\n**Purpose:** p.\n## Gotchas\n"), []);
});

test("lintFile accepts a Purpose that is the last line in the file", () => {
  assert.deepEqual(lintFile("x", "# X\n**Type:** standard\n**Purpose:** p."), []);
});

// The four fields are a closed set, but nothing rejected a fifth. That is the catch-all failure
// this whole header block exists to end, reappearing one level down at the field name.
test("lintFile catches an unrecognised field inside the header block", () => {
  const text = "# X\n**Type:** postmortem\n**Owner:** someone\n**Purpose:** p.\n";
  assert.deepEqual(lintFile("x", text), [
    "x: unrecognised header field **Owner:**, expected one of Type, Status, Project, Purpose, Run, Verified",
  ]);
});

test("lintFile reports every unrecognised field, not just the first", () => {
  const text = "# X\n**Type:** postmortem\n**Source:** a discord export\n**Companion file:** other.md\n**Purpose:** p.\n";
  assert.deepEqual(lintFile("x", text), [
    "x: unrecognised header field **Source:**, expected one of Type, Status, Project, Purpose, Run, Verified",
    "x: unrecognised header field **Companion file:**, expected one of Type, Status, Project, Purpose, Run, Verified",
  ]);
});

test("lintFile does not flag a bold lead-in in body prose", () => {
  // Four real runbooks open their body with a
  // bold lead-in label. A blank line ends the header block, so prose below it is prose, not a
  // smuggled fifth field. Catching these would ban an ordinary markdown idiom.
  const text = "# X\n**Type:** reference\n**Purpose:** p.\n\n**Where the code lives:** somewhere.\n";
  assert.deepEqual(lintFile("x", text), []);
});

test("lintFile does not flag a bold label under a later heading", () => {
  const text = "# X\n**Type:** reference\n**Purpose:** p.\n\n## Prerequisites\n\n**Admin API key:** in the vault.\n";
  assert.deepEqual(lintFile("x", text), []);
});

test("lintFile flags a long file as a split candidate without failing it", () => {
  const long = GOOD + "word ".repeat(2100);
  const out = lintFile("acme-deploy", long);
  assert.equal(out.length, 1);
  assert.match(out[0], /^acme-deploy: 2\d{3} words, consider splitting$/);
});

test("retiredTail renders the same string the index prints", () => {
  const retired = [
    entry("dns-proxy-trial", "postmortem", "Why the DNS proxy was reverted.", "retired 2026-08-03 — it broke the reverse proxy."),
    entry("old-promo-ops", "procedure", "Ran the promo nudge.", "retired 2026-07-16 — promo ended."),
  ];
  const tail = retiredTail(retired);
  // The lint prices the tail with this function, so it has to be the string the index
  // actually emits. An estimate that drifted would understate what pruning buys back.
  assert.ok(summarize(retired).hookSpecificOutput.additionalContext.includes(tail));
  assert.equal(
    tail,
    "Retired, do not re-propose: dns-proxy-trial (retired 2026-08-03 — it broke the reverse proxy.) | " +
      "old-promo-ops (retired 2026-07-16 — promo ended.)."
  );
});


// Added 2026-09-24. Nine runbooks carried **Verified:** and the lint rejected it as unrecognised,
// so the one freshness stamp in use was itself a violation.
test("a Verified stamp after Purpose is a recognised header field", () => {
  const text = "# X\n\n**Type:** reference\n**Purpose:** Look it up.\n**Verified:** 2026-09-24 (checked live)\n\nBody.";
  assert.deepStrictEqual(lintFile("x", text).filter((p) => /Verified|order/.test(p)), []);
});

// Pinned by value: which paths count, which are skipped as placeholders, and that ~ expands.
test("missingPaths lists named local paths that do not exist, and skips placeholders", () => {
  const exists = (p) => p === "C:/here/yes.md" || p === "/home/u/AGENTS.md";
  const text = [
    "Run `C:/here/yes.md` then `C:/gone/no.md`.",
    "Also `~/AGENTS.md` and `~/missing.txt`, and `C:/gone/no.md` again.",
    "Templates: `D:/src/<slug>`, `%TEMP%/x`, `C:/a/$VAR/b`, `D:/src/tools/…`, `C:/x/*.md`.",
    "Not a path: `git status` and `C:` alone.",
  ].join("\n");
  assert.deepStrictEqual(missingPaths(text, exists, "/home/u"), ["C:/gone/no.md", "/home/u/missing.txt"]);
});

// Added with the port. os.homedir() is backslashed on Windows, and the old hardcoded home was
// forward-slashed, so an unnormalised home changed the lint's advisory text on the same corpus.
test("missingPaths prints a ~ path with forward slashes whatever the home separator", () => {
  assert.deepStrictEqual(missingPaths("See `~/gone.md`.", () => false, "D:\\home\\u"), ["D:/home/u/gone.md"]);
});
