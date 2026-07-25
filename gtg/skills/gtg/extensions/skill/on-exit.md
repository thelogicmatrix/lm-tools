# gtg bundled hook: on-exit — capture working state

Runs during the Exit Procedure, while the handoff body is being composed and before the
`gtg.mjs handoff` call. Append this section to the handoff body so a cold resume can
restore your working state (Claude Code specific — task list + active skills):

## Active skills / Task list
- **Methodology (standing):** the build discipline this project is *committed* to, and
  where its state lives — e.g. `superpowers:subagent-driven-development` executing
  `docs/plans/foo.md`, `parallel-sdd` Group B, `ponytail` full. This is a decision already
  made, not a preference: record it so the next session inherits it instead of re-asking.
  If one was deliberately abandoned, say so and why. If none, write "none".
- **Active skills (transient):** process/domain skills that happened to drive *this*
  session and do not bind the next one (e.g. `superpowers:brainstorming`, `due-diligence`).
  If none, write "none".
- **Task list:** the current harness task list, one line each as `[status] subject`
  (e.g. `[in_progress] Wire dispatch`, `[pending] Write README`). If empty, write "none".

**Look at the task list before writing it — don't assume it's empty.** If your harness
defers its task tools, they are invisible until loaded: in Claude Code `TaskList` is a
deferred tool, so call `ToolSearch("select:TaskList")` and then `TaskList` first. An
unloaded tool is not an empty list, and writing "none" without looking silently breaks
the restore on the other side.

List what is actually active/open right now — not what you plan to do next.
