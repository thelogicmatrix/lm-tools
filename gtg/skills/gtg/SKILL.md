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
| Session start | `gtg <project>` | Resume that project (= `gtg resume <project>`; brackets optional — verb-check disambiguates) |
| Mid-session | `gtg` | Depart (Exit Procedure), slug inferred from context |
| Mid-session | `gtg [project]` | Depart, but **force the handoff slug** to `project` (brackets **required**) |
| Anytime | `gtg <verb>` | Handle per the router table below — the verb (`list`, `backlog`, `back`, `active`, `prune`, `remove`, `peek`, `resume`, `undo`, `stats`, `help`) routes to its row; some are `gtg.mjs` CLI calls, others (`peek`, `resume`) are skill-handled |

Disambiguation: a bracketed token is always a project; otherwise a token matching a known
verb is a command; else (session start only) it's a project name to resume. When a
mid-session `gtg [project]` gives a slug, Exit step 2 uses it verbatim — skip the
`list <candidate>` reuse-guess.

All bookkeeping (list/remove/back/active/undo) is zero-model: shell out to the CLI, relay its output, don't reason about the JSON. Handoffs are stored at `docs/handoffs/` under the storage root — the current git repo by default, or `$GTG_HUB` if that env var is set (see README "Advanced").
When *you* (the skill) issue a mutation (`remove`/`back`/`active`), always pass the entry's **`slug`**, never a bare list number — list numbers re-sort as entries move and a stale number silently targets the wrong project. The bare-integer form exists only for a human reading `list`.

The CLI: `node "${CLAUDE_PLUGIN_ROOT}/skills/gtg/gtg.mjs"` — referred to as `gtg.mjs` below.

| Trigger | Do this |
|---|---|
| "gtg list" / "what's active" | Run `gtg.mjs list` and relay its output. Stop. |
| "gtg backlog" / "gtg back &lt;n\|slug&gt;" / "gtg active &lt;n\|slug&gt;" | Run `gtg.mjs backlog` / `back <n|slug>` / `active <n|slug>` verbatim (each commits itself). Relay output. Stop. |
| "gtg backlog &lt;idea&gt;" (an idea named, not bare) | Park a long-horizon idea — see "Backlog Park" below. |
| "gtg prune" / "gtg remove &lt;n\|slug&gt;" | The project **shipped**. Run `gtg.mjs remove <n\|slug>`. `gtg.mjs undo` reverts. Stop. |
| "gtg peek &lt;project&gt;" | Find the entry in `docs/handoffs/_active.json` (or `_backlog.json`), read its `file` verbatim, relay the content. **Do not consume** — no store mutation. |
| "gtg resume &lt;project&gt;" / "let's continue &lt;project&gt;" | The project was **picked back up**, not shipped. Read `references/resume.md`, follow it. **Never** use `remove` for this: `remove` means shipped, `resume` means picked back up, and conflating them makes throughput history meaningless. |
| "gtg report" | Run `gtg.mjs report` (writes `docs/handoffs/_report.json`, zero model tokens). Then invoke the **reporter** skill on that JSON to build a self-contained HTML report — a GitHub-style habit grid (from `habit.grid`), throughput and family rollups, per-project arcs, and the fun callouts. Playful tone. Write the HTML to the session scratchpad, not the repo. If `historyAvailable` is false or `effort.sessionsTimed` is 0, say so plainly rather than inventing figures. |
| "gtg &lt;verb&gt;" not listed above (e.g. "gtg stats", "gtg issues") | Run `gtg.mjs <verb>` and relay its output. Bundled extras ship with the plugin (`stats` — a handoff-store snapshot); a `<storage-root>/.gtg/commands/<verb>.mjs` you've added resolves here too (yours overrides a bundled one of the same name). Unknown → the CLI errors. Stop. |
| everything else (departure) | Follow the Exit Procedure below. |

**On effort:** `duration_min` only accrues from sessions run after gtg 1.4.0 went
live, so `effort` is near-empty at first and fills in over time. The report must
label it "accruing", never present a near-zero total as if the work took no time.

## Exit Procedure (the default departure path)

### 1. Confirm only if the phrase is embedded
If the message is **only** a departure phrase ("gtg", "heading out", …), skip to step 2.
If it's embedded in a longer message ("gotta go soon, but first…"), reply one line — `"Wrapping [project] at [stoppable point] — confirm and go?"` — and wait for an affirmative. Nothing else first.

### 2. Identify the project + commit in-progress work
Name the active project from context (**never ask**). Before slugifying fresh, run `gtg.mjs list <candidate-name>` — if exactly one existing entry matches, **reuse its slug** so the handoff updates that entry in place instead of minting a duplicate. Zero or multiple matches: slugify fresh (e.g. "Payments refactor" → `payments-refactor`). If the trigger was `gtg [project]`, use that slug verbatim and skip the `gtg.mjs list <candidate-name>` reuse-check.
If the working tree has uncommitted changes that belong to the work: `git add <files> && git commit <files> -m "wip: gtg checkpoint — <brief>"`. Skip if clean. **Name the files on the commit too, not just the add** — a pathspec-less `git commit` takes the whole index, so in a checkout shared by concurrent sessions another session's staged work rides along in yours. Commit only files that belong to *this* work; `gtg.mjs` commits only its own ledger (since 1.6.1 it names exact paths), so nothing sweeps the index for you.

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

Relay the `PARKED` line, then stop. Backlog items never show in `gtg.mjs list`; `gtg.mjs backlog` lists them, `gtg.mjs active <n>` reactivates.

## Anti-Patterns
- **Don't ask clarifying questions on trigger** — Exit step 1's confirmation is the only question.
- **Don't finish the whole task** — stop at the nearest stoppable point, not the next milestone.
- **Don't offer more work after the final response** — silence is correct.
