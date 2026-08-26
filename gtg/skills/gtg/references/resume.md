# gtg — Resume Procedure

Triggered by `gtg resume <project>`, a natural-language "let's continue X", or a session-start
`gtg` / `gtg <project>`. Also fires implicitly: if you read an active handoff and start working
its Next Action, that consumes it, so run the consume step below regardless of how you got here.
`gtg.mjs` = `node "${CLAUDE_PLUGIN_ROOT}/skills/gtg/gtg.mjs"`. Paths are relative to the
storage root: `$GTG_HUB` if set, else the current git repo's root.

## Session start

A message that is *only* `gtg…` at session start is a resume, not a departure.

- Bare `gtg`: exactly one active project → resume it. Otherwise run `gtg.mjs list`, ask which.
- `gtg <token>` (unbracketed, not a core verb): a project before an extension verb. Gather both
  readings in one call, then count candidates:
  ```bash
  gtg.mjs list <token>
  ls "<storage-root>/.gtg/commands/<token>.mjs" 2>/dev/null
  ls "${CLAUDE_PLUGIN_ROOT}/skills/gtg/extensions/commands/<token>.mjs" 2>/dev/null
  ```
  Both command paths matter: `issues` and `learn` ship bundled, and those are the two tokens
  most likely to collide with a project name.

| Candidates | Do this |
|---|---|
| exactly 1 project, no command file | Resume it below. No prompt. |
| 0 projects, command file exists (or neither) | Run `gtg.mjs <token>` per `commands.md`; the CLI owns the unknown-command message. |
| 2+ projects, or a project **and** a same-named command | **Ask.** One numbered list, projects first with their `next` line, the command last. A number → resume; the command → `commands.md`. |

`gtg [token]` (bracketed) is always a project.

## Procedure

1. Read `docs/handoffs/_active.json`. Match `<name>` against `slug` first, then fuzzy against
   `project`. **If no match, also read `docs/handoffs/_backlog.json`** and match the same way.
   Active wins a collision (the stores partition the work, so a real collision means hand-edited
   JSON).
2. If multiple entries match ambiguously, ask: "Which project — [list matches]?"
3. Read the linked handoff file (the entry's `file`, relative to the storage root).
4. Respond: `"Found your [date] handoff for [project] — picking up from [next action]."`
5. **Consume the entry** before working, however you arrived: `gtg.mjs resume <slug>`. It
   removes the entry from whichever store holds it and commits. `resume`, never `remove`:
   `remove`/`prune` means the project **shipped**, and mixing the two makes throughput history
   meaningless. The CLI owns this mechanic; don't hand-edit the JSON.
6. **Restore working state** from the handoff's `## Active skills / Task list` section (skip
   if absent; for older handoffs infer the discipline from "Active skills" plus the Next Action):
   - **Methodology (binding, never ask):** whatever is listed is a decision the project already
     made. Re-enter those skills and keep working under them, reading the plan or ledger the
     line points at first. Only the handoff saying it was abandoned, or the user saying so
     now, revokes it.
   - **Task list (concrete):** for each `[status] subject` line, re-create the task with your
     harness task tool (Claude Code: `ToolSearch("select:TaskCreate")` first), preserving the
     subject. Status `pending` unless the line says `in_progress` (keep at most one).
   - **Active skills (advisory):** context for what drove the last session, not instructions.
     Re-enter one only if the Next Action genuinely calls for it.
   Then, if `<storage-root>/.gtg/skill/on-resume.md` exists, read and follow it too.
7. Continue from the Next Action without further preamble.

**Stale handoff:** if the Next Action already looks done (files match, work complete), say so
and ask how to proceed instead of redoing it, but still consume the entry (step 5); a pulled
handoff is never left dangling.

**Never** work a handoff's Next Action while its entry still sits in `_active.json` (or
`_backlog.json`).

## Working a package

**An issues package is the one exception to step 5: do not consume it.** `gtg issues <pN>`
says so in its own directive line.

The rest of the Procedure applies (read the handoff, restore state, continue from the Next
Action) but the entry stays where it is.

A package entry is not only a bookmark. It is the only live mapping from its `pN` to a name,
and every `docs/issues/` file in the batch carries `**Package:** pN` pointing at it. Consuming
it orphans all of them at once: they fall back to loose, `gtg issues` reports a stale package
ref, and the package stops existing for exactly as long as you are working it. A session that
ends before re-parking leaves it that way.

So a package retires by being **finished**, not by being picked up. Fix its members and delete
their files as you go; when the last one goes, its row renders `no members - unstamped, or
done` and names the `gtg remove` that closes it. That row is the retirement prompt.
