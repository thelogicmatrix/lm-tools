---
name: gtg
description: Activate when the user says "gtg", "gotta go", "got to go", "need to sleep", "heading out", "pin this chat", or any clear session-ending departure phrase — wraps current work and packages it for cold resume. Also activate on "gtg list", "gtg prune" / "gtg remove <project>", "gtg peek <project>" (read a handoff without consuming it), "gtg resume <project>" / "let's continue <project>", "gtg backlog" / "gtg back <n|slug>" / "gtg active <n|slug>" (backlog shelf), or "gtg backlog <idea>" (park a long-horizon idea).
---

# GTG — Pause and Resume

Graceful mid-task pause for cold resume. "gtg" is a reserved phrase — never casual; any occurrence triggers this skill immediately.

**Fast, not rushed:** the *procedure* must be quick (no extra exploration, no new work), but the *handoff content* must be accurate enough for a cold resume days later — the real stoppable point, the real next action, decisions not to re-litigate.

## Trigger Semantics — what `gtg` means by context

Brackets `[]` are the explicit project override, required only where a bare token would
otherwise read as a verb.

| Context | Input | Meaning |
|---|---|---|
| Session start (message is *only* `gtg…`) | `gtg` | Resume mode: if exactly one active project, resume it; else run `list` and ask which |
| Session start | `gtg <project>` | Resume that project (= `gtg resume <project>`; brackets optional — the store check below disambiguates) |
| Mid-session | `gtg` | Depart (Exit Procedure), slug inferred from context |
| Mid-session | `gtg [project]` | Depart, but **force the handoff slug** to `project` (brackets **required**) |
| Anytime | `gtg <core verb>` | Handle per the router table below — a **core verb** (`list`, `backlog`, `back`, `active`, `prune`, `remove`, `supersede`, `peek`, `resume`, `rename`, `unparent`, `log`, `report`, `stats`, `undo`, `help`) always routes to its command, never to a project; some are `gtg.mjs` CLI calls, others (`peek`, `resume`) are skill-handled |

Disambiguation, in this order:

1. A bracketed token is always a project.
2. A **core verb** (the list in the row above) is always that command — a project sharing
   the name never shadows it, so `gtg report` reports even with a "Report & Stats" project.
3. **At session start, any other bare token is a project before it is an extension verb** —
   gather both readings in one call, then see "Session-start collisions" below:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/gtg/gtg.mjs" list <token>
   ls "<storage-root>/.gtg/commands/<token>.mjs" 2>/dev/null
   ls "${CLAUDE_PLUGIN_ROOT}/skills/gtg/extensions/commands/<token>.mjs" 2>/dev/null
   ```
   **Both command paths, and the bundled one is not optional.** `issues` and `learn` ship in
   the plugin now rather than sitting in anyone's `.gtg/commands/`, so probing only the user
   path finds nothing for exactly the two tokens most likely to collide with a project name,
   and the collision below is never offered.
4. Any other token (mid-session, or carrying further args like `gtg issues p1`) goes
   straight to the CLI as an extension verb.

Step 3 exists because extension verbs and project names share one namespace, and a project
named after its own tooling (`issues`, `projects`) is exactly the one you resume most — at
session start the extension's listing is never what you meant. Mid-session the verb wins, so
the command stays one keystroke away. When a mid-session `gtg [project]` gives a slug, Exit
step 2 uses it verbatim — skip the `list <candidate>` reuse-guess.

### Session-start collisions — offer the candidates, don't guess

Count the candidates step 3 found: each matching active project, plus the `<token>` command
if either `.mjs` exists, bundled or your own.

| Candidates | Do this |
|---|---|
| exactly 1 project, no command file | Resume it (Resume Procedure). No prompt. |
| 0 projects, command file exists | Run `gtg.mjs <token>` per the router table. No prompt. |
| 0 projects, no command file | Run `gtg.mjs <token>` anyway and relay its error — the CLI owns the unknown-command message. |
| anything else (2+ projects, or a project **and** a same-named command) | **Ask.** One numbered list, projects first with their `next` line, the command last, then wait. |

The prompt is the whole feature — a same-named project and command are both real work, and
picking for the user is what made the command unreachable one way and the project unreachable
the other. Keep it to one screen:

```
'issues' is ambiguous:
  1. Issues P3: Obelisk housekeeping — Fingerprint which container orphans an anonymous volume
  2. Issues P4: Obelisk audit remediation — Decide the data/media anonymous SMB read question
  3. run the `issues` command (the issues-layer listing)
Which?
```

Answer resolves it: a project number → Resume Procedure; the command → router table.

All bookkeeping (list/remove/back/active/undo) is zero-model: shell out to the CLI, relay its output, don't reason about the JSON. Handoffs are stored at `docs/handoffs/` under the storage root — the current git repo by default, or `$GTG_HUB` if that env var is set (see README "Advanced").
When *you* (the skill) issue a mutation (`remove`/`back`/`active`), always pass the entry's **`slug`**, never a bare list number — list numbers re-sort as entries move and a stale number silently targets the wrong project. The bare-integer form exists only for a human reading `list`.

The CLI: `node "${CLAUDE_PLUGIN_ROOT}/skills/gtg/gtg.mjs"` — referred to as `gtg.mjs` below.

| Trigger | Do this |
|---|---|
| "gtg list" / "what's active" | Run `gtg.mjs list` and relay its output. Stop. |
| "gtg backlog" / "gtg back &lt;n\|slug&gt;" / "gtg active &lt;n\|slug&gt;" | Run `gtg.mjs backlog` / `back <n|slug>` / `active <n|slug>` verbatim (each commits itself). Relay output. Stop. |
| "gtg backlog &lt;idea&gt;" (an idea named, not bare) | Park a long-horizon idea — see "Backlog Park" below. |
| "gtg prune" / "gtg remove &lt;n\|slug&gt;" | The project **shipped**. Run `gtg.mjs remove <n\|slug>`. `gtg.mjs undo` reverts your own last change. Stop. |
| "gtg supersede &lt;n\|slug&gt;" / "this rolled up into X" / "I filed that one in error" | The entry was **neither shipped nor abandoned**. Run `gtg.mjs supersede <n\|slug> [--into <n\|slug>]`. Reach for it whenever consolidating several entries into one parent, or clearing an entry that should never have existed: `remove` would write a phantom ship and `back` reads as shelved-for-later, and both corrupt throughput. Pass `--into` whenever another entry absorbed it. Stop. |
| "gtg peek &lt;project&gt;" | Find the entry in `docs/handoffs/_active.json` (or `_backlog.json`), read its `file` verbatim, relay the content. **Do not consume** — no store mutation. |
| "gtg resume &lt;project&gt;" / "let's continue &lt;project&gt;" | The project was **picked back up**, not shipped. Read `references/resume.md`, follow it. **Never** use `remove` for this: `remove` means shipped, `resume` means picked back up, and conflating them makes throughput history meaningless. |
| "gtg rename &lt;n\|slug&gt; &lt;new&gt;" | Run `gtg.mjs rename <n\|slug> <new-slug>`. It re-points any sub-project whose `parent` named the old slug, and leaves past handoff filenames alone because those record what the project was called then. The **portfolio** slug is separate: relay the `projects rename` line it prints rather than assuming both moved. Stop. |
| a `projects rename` printed a `NOTE:` about dangling parents | Run the `gtg rename <old> <new>` it names. Given a slug no entry here carries, `rename` repairs the stale `parent` reference instead of renaming an entry, which is exactly this case. Stop. |
| an entry's `parent` names a family that does not exist, or names itself | Run `gtg.mjs unparent <n\|slug>`. The two fixes for a stale family reference are **not** interchangeable: `rename` re-**points** a parent (every child carrying it, at once), `unparent` **removes** one (a single entry). Re-pointing a dangling parent at the entry's own slug only turns it into a self-parent, which is the same defect wearing a different mask — so reach for `unparent` whenever the right answer is "no family". Stop. |
| "gtg log" / "when did I last touch &lt;project&gt;" | Run `gtg.mjs log [n\|slug]` and relay it. Read from git, so there is no ledger to keep in step. Stop. |
| "gtg report" | Run `gtg.mjs report` (writes `docs/handoffs/_report.json`, zero model tokens). Then invoke the **reporter** skill on that JSON to build a self-contained HTML report — a GitHub-style habit grid (from `habit.grid`), throughput and family rollups, per-project arcs, and the fun callouts. Playful tone. Write the HTML to the session scratchpad, not the repo. If `historyAvailable` is false or `effort.sessionsTimed` is 0, say so plainly rather than inventing figures. |
| "gtg &lt;verb&gt;" not listed above (e.g. "gtg stats", "gtg issues", "gtg learn") | Run `gtg.mjs <verb>` and relay its output. Four bundled extras ship with the plugin, in two kinds. **Extensions** own entries in the handoff store and render their own separated list: `issues` (the issues-layer listing) and `learn` (learning sprints). **Mods** own no entries and only add a view over the whole store: `stats` (a handoff-store snapshot) and `report`. A `<storage-root>/.gtg/commands/<verb>.mjs` you've added resolves here too, and yours overrides a bundled one of the same name. Unknown → the CLI errors. Stop. |
| everything else (departure) | Follow the Exit Procedure below. |

**On extension entries:** an extension's own entries are excluded from the bare `gtg.mjs list`
and `gtg.mjs backlog`, and from their counts, so the same work is not listed twice. That is
decluttering, not hiding: `gtg.mjs list <name-or-slug>` is you naming what you want, so it
searches every entry and will surface an issue package or a learning sprint, including a
shelved one, which is why the Exit Procedure's reuse probe below still works on them. A
queried extension entry prints with its slug in place of a row number, because row numbers
index the bare listing and that is the order `back <n>` and `remove <n>` resolve against. Pass
the slug for these, never a number.

**On effort:** `duration_min` only accrues from sessions run after gtg 1.4.0 went
live, so `effort` is near-empty at first and fills in over time. The report must
label it "accruing", never present a near-zero total as if the work took no time.

## Exit Procedure (the default departure path)

### 1. Confirm only if the phrase is embedded
If the message is **only** a departure phrase ("gtg", "heading out", …), skip to step 2.
If it's embedded in a longer message ("gotta go soon, but first…"), reply one line — `"Wrapping [project] at [stoppable point] — confirm and go?"` — and wait for an affirmative. Nothing else first.

### 2. Identify the project + commit in-progress work
Name the active project from context (**never ask**). Before slugifying fresh, run `gtg.mjs list <candidate-name>` — if exactly one existing entry matches, **reuse its slug** so the handoff updates that entry in place instead of minting a duplicate. Zero or multiple matches: slugify fresh (e.g. "Payments refactor" → `payments-refactor`). If the trigger was `gtg [project]`, use that slug verbatim and skip the `gtg.mjs list <candidate-name>` reuse-check.
If the working tree has uncommitted changes that belong to the work: `git add <files> && git commit <files> -m "wip: gtg checkpoint - <brief>"`. Skip if clean. **Name the files on the commit too, not just the add** — a pathspec-less `git commit` takes the whole index, so in a checkout shared by concurrent sessions another session's staged work rides along in yours. Commit only files that belong to *this* work; `gtg.mjs` commits only its own ledger (since 1.6.1 it names exact paths), so nothing sweeps the index for you.

### 3. Estimate the Next Action's ETA
Rough **duration remaining** to finish this project's Next Action, from your read of the
work: `~30m` · `~2h` · `~3 sessions`. This is a free-time-prioritization seed, not a
contract — a rough guess is fine, and it's optional (omit `--eta` if you truly can't tell).

### 4. Write the handoff — ONE call
**First, run exit hooks (extensions may add project-specific steps).** In order:
(1) read and follow `${CLAUDE_PLUGIN_ROOT}/skills/gtg/extensions/skill/on-exit.md` (bundled, ships active);
(2) if `<storage-root>/.gtg/skill/on-exit.md` exists, read and follow it too.
Hooks run **now** — while the handoff body below is still being composed (a hook may append a section to it) and before the CLI call (a hook may `git add` files, which ride the handoff's single commit). Missing hook files are simply skipped.

The CLI owns all mechanics (timestamp, filename, header, store dedupe+append, git commit). Pass the body on stdin:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/gtg/gtg.mjs" handoff \
  --project "<Name>" --slug <slug> \
  --eta "<duration remaining, e.g. ~2h>" --next "<one-line next action, <150 chars>" \
  [--parent "<docs/projects page slug, if this is a sub-project>"] \
  [--worktree "<path or 'repo root'>"] <<'BODY'
## What Was Done This Session
- <significant actions / decisions>

## Where We Stopped
<one paragraph: last completed thing, why here>

## Next Action
<single concrete first action on resume — one action, not a list>

## Open Questions
- <unresolved decisions, if any>

## Key Decisions Made
- <decisions that shaped the work, so a fresh session doesn't re-litigate>

## Relevant Files
- <path> — <one-line purpose>
BODY
```

**`--parent` — pass it whenever this is a sub-project.** Much of the work is one
effort within a larger one (an Widget page, a atlas setting, a gtg command). The
parent is the `docs/projects/` page slug the family shares — `widget`, `atlas`,
`gtg`. You already know it from session context, so pass it; the CLI's fallback
only catches the cases where the slug happens to start with the family name, and
would miss e.g. `sub-project` belonging to `atlas`. **Never ask the user
which family a project belongs to** — a wrong parent only mis-groups a list row,
whereas a question breaks the one-shot wrap. Omit the flag if genuinely standalone.

If the project has a plan/spec doc, copy the Next Action's scope **from that doc**, not from memory.

### 5. Final response, then stop
Relay the CLI's output as one line, then stop completely — no follow-up, no summary, no offer to continue:

> "Done. <project> handoff saved. Resume with: 'let's continue <project>'. Close this session."

## Backlog Park (`gtg backlog <idea>`)

Same mechanics as the Exit Procedure, three differences: no work-in-progress commit (it's an idea, not in-progress work), thin fields are fine (omit `--eta`, `--next "TBD — <first step>"`), and the `backlog` subcommand routes it to the shelf:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/gtg/gtg.mjs" backlog \
  --project "<Name>" --slug <slug> \
  --next "<first concrete step, or 'TBD — <thought>'>" <<'BODY'
## The Idea
<a few sentences: what it is, why it's worth remembering, any seed thoughts>

## Next Action
<the first concrete step when it's picked up, or 'TBD'>
BODY
```

Relay the `PARKED` line, then stop. A backlog item never shows in a bare `gtg.mjs list`. `gtg.mjs backlog` lists them and `gtg.mjs active <n>` reactivates. The one exception is a *queried* `gtg.mjs list <name-or-slug>`, which also reaches a shelved **extension** entry and prints it on its own `shelved:` line, so the reuse probe can still find a parked issue package. A shelved normal project stays invisible to a query.

## Anti-Patterns
- **Don't ask clarifying questions on trigger** — Exit step 1's confirmation is the only question.
- **Don't finish the whole task** — stop at the nearest stoppable point, not the next milestone.
- **Don't offer more work after the final response** — silence is correct.
