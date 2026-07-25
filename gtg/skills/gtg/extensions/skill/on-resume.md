# gtg bundled hook: on-resume — restore working state

Runs during the Resume Procedure, after reading the handoff file. If the handoff has an
`## Active skills / Task list` section:

1. **Re-enter the methodology (binding — never ask):** whatever is listed under
   "Methodology" is a decision the project already made. Re-enter those skills and keep
   working under them, reading the plan/ledger the line points at first. **Do not ask the
   user whether it still applies** — a past yes is still yes. The only things that revoke
   it are the handoff saying it was abandoned, or the user saying so now.
2. **Restore the task list (concrete):** for each `[status] subject` line under "Task
   list", re-create the task with your harness task tool, preserving the subject. Set
   status `pending` unless the line says `in_progress` (keep at most one `in_progress`).
   Skip if the section says "none". If your harness defers its task tools, load them
   first — in Claude Code: `ToolSearch("select:TaskCreate")`.
3. **Note active skills (advisory):** the skills under "Active skills" are context for
   what drove the last session, not instructions. Don't auto-re-invoke them — only
   re-enter one if the Next Action genuinely calls for it.

Handoffs written before the "Methodology" line existed won't have one: infer the standing
discipline from "Active skills" plus the Next Action rather than asking. If the handoff
has no such section at all, skip this hook.
