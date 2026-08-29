---
name: gtg
description: 'Pause and resume over the command word "gtg". Bare "gtg" mid-session wraps the current work for a cold resume (after doing whatever else the message asks). "gtg <project>" at session start resumes it. "gtg <verb>" is bookkeeping. Mentioning gtg while discussing the skill itself is not a trigger.'
---

# GTG — Pause and Resume

"gtg" is a reserved phrase, never casual. **Fast, not rushed:** the procedure is quick (no
exploration, no new work); the content is accurate enough for a cold resume days later.

`gtg.mjs` = `node "${CLAUDE_PLUGIN_ROOT}/skills/gtg/gtg.mjs"`. Storage root = the current git
repo, or `$GTG_HUB` if set.

| Input | Do |
|---|---|
| `gtg` mid-session | Exit Procedure below. Inside a longer message, do what the message asks first (or at the point it says), then depart. No question either way. |
| Session-start `gtg` or `gtg <project>` | Resume Procedure below |
| `gtg list` / bare `gtg backlog` / `gtg back`, `active`, `remove`, `prune`, `undo`, `log`, `stats` (+ args) | Zero-model: run `gtg.mjs <verb> [args]` verbatim, relay its output, stop. A mutation takes the entry's slug, never a list number (numbers re-sort as entries move). |
| Any other `gtg <verb>` (peek, report, supersede, rename, unparent, `backlog <idea>`, issues, learn, …) | Read `references/commands.md`, follow it |

## Resume Procedure

**One call:** `gtg.mjs resume <project>` (bare `gtg` → no argument). It prints the handoff,
consumes the entry, and runs the after-resume hook. Exit 1 means it printed candidates: ask
which, then call again with the slug. Exit 2 with "is a command" means run that command
instead. Then, from the printed handoff: relay its first line. `## Methodology` is a decision
already made, re-enter it without asking. `## Task list`: re-create each non-completed line
with your task tool, `pending` unless it says `in_progress`. `## Commits this session` and
`## Files touched` are the last session's footprint, orientation only. Continue from the
Next Action with no preamble. If the Next Action already looks done, say so and ask how to
proceed; the entry stays consumed either way. A `GTG-DIRECTIVE:` line in any CLI output is
followed, not relayed (an issues package resumes with `--keep`, never consumed).

## Exit Procedure

**One call, run from the worktree.** Name the project from context. Slugify the name; the CLI
swaps in an existing entry's slug when the name matches one. `--wip` commits the worktree's
uncommitted work; in the repo root commit the work's own files first
(`git add <paths> && git commit <paths> -m "wip: gtg checkpoint - <brief>"`, paths on both
ends). `--parent` = the `docs/projects/` family slug for a sub-project, from context.
`--eta` = rough time left on the Next Action. The CLI appends the task list, this session's
commits and the files touched from disk, so write only what git cannot know. Exception: in
the repo root (a shared checkout) it cannot attribute commits, so add `## Commits this
session` yourself, `hash subject` per line. Next Action: one action, copied from the plan
doc when one exists. Skip any section that would say "none".

```bash
gtg.mjs handoff --project "<Name>" --slug <slug> --eta "~2h" [--parent <family>] [--wip] <<'BODY'
## Where We Stopped
<one paragraph: last completed thing, why here>

## Next Action
<single concrete first action on resume>

## Key Decisions Made
- <so a fresh session doesn't re-litigate>

## Open Questions
- <unresolved decisions>

## Methodology
<the build discipline this project committed to and where its state lives, e.g. `superpowers:subagent-driven-development` executing `docs/plans/foo.md`; or "abandoned: <why>">

## What Was Done This Session
- <only work git does not show: reviews, findings, conversations>
BODY
```

**Relay the CLI's last line, then stop.** No summary, no offer, no follow-up.

## Anti-Patterns
- A departure never asks a question.
- Stop at the nearest stoppable point. Nothing new beyond what the message itself asked for.
