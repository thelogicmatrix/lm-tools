---
name: gtg
description: Activate when the user says "gtg", "gotta go", "got to go", "need to sleep", "heading out", "pin this chat", or any clear session-ending departure phrase — wraps current work and packages it for cold resume. Also activate on "gtg list", "gtg prune" / "gtg remove <project>", "gtg peek <project>" (read a handoff without consuming it), "gtg resume <project>" / "let's continue <project>", "gtg backlog" / "gtg back <n|slug>" / "gtg active <n|slug>" (backlog shelf), or "gtg backlog <idea>" (park a long-horizon idea).
---

# GTG — Pause and Resume

Graceful mid-task pause for cold resume. "gtg" is a reserved phrase — never casual; any occurrence triggers this skill immediately.

**Fast, not rushed:** the *procedure* must be quick (no extra exploration, no new work), but the *handoff content* must be accurate enough for a cold resume days later — the real stoppable point, the real next action, decisions not to re-litigate.

All bookkeeping (list/remove/back/active/undo) is zero-model: shell out to the CLI, relay its output, don't reason about the JSON. Handoffs are stored at `docs/handoffs/` under the storage root — the current git repo by default, or `$GTG_HUB` if that env var is set (see README "Advanced").

The CLI: `node "${CLAUDE_PLUGIN_ROOT}/skills/gtg/gtg.mjs"` — referred to as `gtg.mjs` below.

| Trigger | Do this |
|---|---|
| "gtg list" / "what's active" | Run `gtg.mjs list` and relay its output. Stop. |
| "gtg backlog" / "gtg back &lt;n\|slug&gt;" / "gtg active &lt;n\|slug&gt;" | Run `gtg.mjs backlog` / `back <n|slug>` / `active <n|slug>` verbatim (each commits itself). Relay output. Stop. |
| "gtg backlog &lt;idea&gt;" (an idea named, not bare) | Park a long-horizon idea — see "Backlog Park" below. |
| "gtg prune" / "gtg remove &lt;n\|slug&gt;" | Run `gtg.mjs remove <n\|slug>`. `gtg.mjs undo` reverts. Stop. |
| "gtg peek &lt;project&gt;" | Find the entry in `docs/handoffs/_active.json` (or `_backlog.json`), read its `file` verbatim, relay the content. **Do not consume** — no store mutation. |
| "gtg resume &lt;project&gt;" / "let's continue &lt;project&gt;" | Read `references/resume.md`, follow it. |
| "gtg &lt;verb&gt;" not listed above (e.g. "gtg stats", "gtg issues") | Run `gtg.mjs <verb>` and relay its output. Bundled extras ship with the plugin (`stats` — a handoff-store snapshot); a `<storage-root>/.gtg/commands/<verb>.mjs` you've added resolves here too (yours overrides a bundled one of the same name). Unknown → the CLI errors. Stop. |
| everything else (departure) | Follow the Exit Procedure below. |

## Exit Procedure (the default departure path)

### 1. Confirm only if the phrase is embedded
If the message is **only** a departure phrase ("gtg", "heading out", …), skip to step 2.
If it's embedded in a longer message ("gotta go soon, but first…"), reply one line — `"Wrapping [project] at [stoppable point] — confirm and go?"` — and wait for an affirmative. Nothing else first.

### 2. Identify the project + commit in-progress work
Name the active project from context (**never ask**). Before slugifying fresh, run `gtg.mjs list <candidate-name>` — if exactly one existing entry matches, **reuse its slug** so the handoff updates that entry in place instead of minting a duplicate. Zero or multiple matches: slugify fresh (e.g. "Payments refactor" → `payments-refactor`).
If the working tree has uncommitted changes that belong to the work: `git add <files> && git commit -m "wip: gtg checkpoint — <brief>"`. Skip if clean.

### 3. Classify the Next Action's tier
Cheapest model tier that does it reliably: `Haiku` mechanical · `Sonnet` standard build/debug (default) · `Opus`/`Fable` heavy or plan/review work. Unsure → `Sonnet`.

### 4. Write the handoff — ONE call
**First, run exit hooks (extensions may add project-specific steps).** In order:
(1) read and follow `${CLAUDE_PLUGIN_ROOT}/skills/gtg/extensions/skill/on-exit.md` (bundled, ships active);
(2) if `<storage-root>/.gtg/skill/on-exit.md` exists, read and follow it too.
Hooks run **now** — while the handoff body below is still being composed (a hook may append a section to it) and before the CLI call (a hook may `git add` files, which ride the handoff's single commit). Missing hook files are simply skipped.

The CLI owns all mechanics (timestamp, filename, header, store dedupe+append, git commit). Pass the body on stdin:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/gtg/gtg.mjs" handoff \
  --project "<Name>" --slug <slug> --phase <brainstorming|writing-plans|executing|free-form> \
  --tier <Haiku|Sonnet|Opus|Fable> --next "<one-line next action, <150 chars>" \
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

If the project has a plan/spec doc, copy the Next Action's scope **from that doc**, not from memory.

### 5. Final response, then stop
Relay the CLI's output as one line, then stop completely — no follow-up, no summary, no offer to continue:

> "Done. <project> handoff saved. Resume with: 'let's continue <project>'. Close this session."

## Backlog Park (`gtg backlog <idea>`)

Same mechanics as the Exit Procedure, three differences: no work-in-progress commit (it's an idea, not in-progress work), thin fields are fine (`--phase free-form`, `--tier` best-guess, `--next "TBD — <first step>"`), and the `backlog` subcommand routes it to the shelf:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/gtg/gtg.mjs" backlog \
  --project "<Name>" --slug <slug> --phase free-form --tier <tier> \
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
