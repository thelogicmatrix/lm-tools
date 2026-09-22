---
name: gtg
description: 'Use for gtg pause/resume commands and persistent task or subagent progress in an ongoing multi-step project. Bare "gtg" mid-session departs; "gtg <project>" at session start resumes. Mentioning gtg while discussing the skill itself is not a departure trigger.'
---

# GTG — Pause and Resume

"gtg" is a reserved phrase, never casual. **Fast, not rushed:** the procedure is quick (no
exploration, no new work); the content is accurate enough for a cold resume days later.

`gtg.mjs` = `node "${CLAUDE_PLUGIN_ROOT}/skills/gtg/gtg.mjs"`. Storage root = the current git
repo, or `$GTG_HUB` if set.

In Codex, resolve the CLI beside this loaded skill if `CLAUDE_PLUGIN_ROOT` is absent. Set the intended shared hub explicitly; a generated workspace is not automatically that hub.

| Input | Do |
|---|---|
| `gtg` mid-session | Exit Procedure below. Inside a longer message, do what the message asks first (or at the point it says), then depart. No question either way. |
| Session-start `gtg` or `gtg <project>` | Resume Procedure below |
| `gtg progress …` or tracking task/subagent execution | Read `references/progress.md`; use its CLI for persistent state and counts. This does not depart or consume a handoff. |
| `gtg list` / bare `gtg backlog` / `gtg back`, `active`, `complete`, `remove`, `prune`, `undo`, `log`, `stats` with their args | Zero-model: run `gtg.mjs <verb> [args]` verbatim, relay its output, stop. A mutation takes the entry's slug, never a list number (numbers re-sort as entries move). |
| Any other `gtg <verb>` (peek, report, supersede, rename, unparent, `backlog <idea>`, issues, learn, …) | Read `references/commands.md`, follow it |

## Resume Procedure

**One call:** `gtg.mjs resume <project>` (bare `gtg` → no argument). It syncs the hub from
its mirror, prints the current handoff, retains the entry, and runs the after-resume hook. A leading
`Synced <remote>/<branch>: ...` line means the sync pulled work down; it is not a warning. Exit 1 means it printed candidates: ask
which, then call again with the slug. Exit 2 with "is a command" means run that command
instead. Then, from the printed handoff: relay its first line. `## Methodology` is a decision
already made, re-enter it without asking. If current persistent progress is printed, run `progress show <slug> --json` and read `references/progress.md` before reconstructing tasks or redispatching workers; preserve its current task states instead of an older snapshot. Otherwise, `## Task list`: re-create each non-completed line
with your task tool, `pending` unless it says `in_progress`. `## Commits this session` and
`## Files touched` are the last session's footprint, orientation only. Continue from the
Next Action with no preamble. If the Next Action already looks done, say so and ask how to
proceed; the entry remains available either way. A `GTG-DIRECTIVE:` line in any CLI output is
followed, not relayed (`--keep` remains a compatibility alias; all resumes retain entries).

## Checkpoints and Exit Procedure

Write a checkpoint at a meaningful boundary or session end; a checkpoint does not complete or shelve the work. The stable slug retains one current handoff, updated in place, with prior versions in git. Use `gtg complete <slug>` only for explicit completion, or `gtg back <slug>` to shelve.

For a checkpoint during ongoing work, add `--checkpoint` to the command below and continue the task. This skips session-end ceremony. The final stop instruction applies only to an actual departure request.

**One call, run from the worktree.** Name the project from context. Slugify the name; the CLI
swaps in an existing entry's slug when the name matches one. An entry now survives every resume,
so its name outlives the session that coined it and the work drifts away from it. Before writing
the checkpoint, check the name still describes what the project is about. If it does not, run
`gtg.mjs rename <slug> <new-slug>` first and pass the new name as `--project`. Relay the rename
in one line, and relay the `projects rename` line it prints rather than assuming the portfolio
slug moved with it. `--wip` commits the worktree's
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
