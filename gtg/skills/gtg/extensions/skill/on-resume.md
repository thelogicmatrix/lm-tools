# gtg bundled hook: on-resume — restore working state

Runs during the Resume Procedure, after reading the handoff file. If the handoff has an
`## Active skills / Task list` section:

1. **Restore the task list (concrete):** for each `[status] subject` line under "Task
   list", re-create the task with your harness task tool (e.g. TaskCreate), preserving the
   subject. Set status `pending` unless the line says `in_progress` (keep at most one
   `in_progress`). Skip if the section says "none".
2. **Note active skills (advisory):** list the skills named under "Active skills" to
   yourself as context for what was driving the work. Do NOT auto-re-invoke process skills
   — only re-enter one if the Next Action genuinely calls for it.

If the handoff has no such section, skip this hook.
