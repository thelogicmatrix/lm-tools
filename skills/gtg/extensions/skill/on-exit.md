# gtg bundled hook: on-exit — capture working state

Runs during the Exit Procedure, while the handoff body is being composed and before the
`gtg.mjs handoff` call. Append this section to the handoff body so a cold resume can
restore your working state (Claude Code specific — task list + active skills):

## Active skills / Task list
- **Active skills:** the process/domain skills currently driving this session, by name
  (e.g. `superpowers:writing-plans`, `due-diligence`). If none, write "none".
- **Task list:** the current harness task list, one line each as `[status] subject`
  (e.g. `[in_progress] Wire dispatch`, `[pending] Write README`). If empty, write "none".

List what is actually active/open right now — not what you plan to do next.
