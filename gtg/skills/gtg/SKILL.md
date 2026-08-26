---
name: gtg
description: 'Activate when the user says "gtg", "gotta go", "got to go", "need to sleep", "heading out", or any clear session-ending departure phrase — wraps current work and packages it for cold resume. Also activate on "gtg list", "gtg prune" / "gtg remove <project>", "gtg peek <project>", "gtg resume <project>" / "let''s continue <project>", "gtg backlog" / "gtg back <n|slug>" / "gtg active <n|slug>", or "gtg backlog <idea>" (park a long-horizon idea).'
---

# GTG — Pause and Resume

"gtg" is a reserved phrase, never casual. **Fast, not rushed:** the procedure is quick (no
exploration, no new work); the content is accurate enough for a cold resume days later.

`gtg.mjs` = `node "${CLAUDE_PLUGIN_ROOT}/skills/gtg/gtg.mjs"`. Storage root = the current git
repo, or `$GTG_HUB` if set.

| Input | Do |
|---|---|
| Mid-session `gtg` / any departure phrase, optionally `gtg [project]` | Exit Procedure below |
| Session-start `gtg` or `gtg <project>`, `gtg resume <x>`, "let's continue <x>" | Read `references/resume.md`, follow it |
| Any other `gtg <verb>` (list, prune, remove, peek, backlog, back, active, supersede, rename, unparent, log, report, stats, issues, learn, …) | Read `references/commands.md`, follow it |

Read a reference only when its row fires.

## Exit Procedure

1. **Confirm only if embedded.** Bare departure phrase → step 2. Embedded in a longer message →
   one line, `"Wrapping <project> at <stoppable point> — confirm and go?"`, wait for a yes.
2. **Look before writing.** Load the task list: `ToolSearch("select:TaskList")`, then
   `TaskList`. An unloaded tool is not an empty list. If `<storage-root>/.gtg/skill/on-exit.md`
   exists, read and follow it (it may add to the body or stage files).
3. **One call.** Name the project from context, never ask. Slug: slugify the name; the CLI
   swaps in an existing entry's slug when the name matches exactly one, so no lookup first.
   `gtg [project]` means that slug literally: pass it with `--exact`. `--wip` commits the
   worktree's uncommitted work; in the repo root commit the work's own files first
   (`git add <paths> && git commit <paths> -m "wip: gtg checkpoint - <brief>"`, paths on both
   ends). `--parent` = the `docs/projects/` family slug when this is a sub-project (you know
   it from context; a wrong guess mis-groups a row, a question breaks the wrap). `--eta` =
   rough time left on the Next Action. Next Action: one action, copied from the plan doc when
   one exists. Drop a section that would say "none".

```bash
gtg.mjs handoff --project "<Name>" --slug <slug> --eta "~2h" \
  --next "<one line, <150 chars>" [--parent <family>] [--worktree "<path>"] [--wip] <<'BODY'
## What Was Done This Session
- <significant actions and decisions>

## Where We Stopped
<one paragraph: last completed thing, why here>

## Next Action
<single concrete first action on resume>

## Open Questions
- <unresolved decisions>

## Key Decisions Made
- <so a fresh session doesn't re-litigate>

## Relevant Files
- <path> — <purpose>

## Active skills / Task list
- **Methodology (standing):** <the build discipline this project committed to and where its state lives, e.g. `superpowers:subagent-driven-development` executing `docs/plans/foo.md`; "none"; or "abandoned: <why>">
- **Active skills (transient):** <skills that drove this session; not binding on the next>
- **Task list:** one `[status] subject` per line, as it stands right now
BODY
```

4. **Relay the CLI's last line, then stop.** No summary, no offer, no follow-up.

## Anti-Patterns
- The step-1 confirmation is the only question a departure ever asks.
- Stop at the nearest stoppable point. Finish nothing.
