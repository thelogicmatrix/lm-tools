# gtg — Resume Procedure

Triggered by `gtg resume <project>` or a natural-language "let's continue X" (also fires implicitly: if you read an active handoff and start working its Next Action, that consumes it — run the consume step below regardless of how you got here).

All paths below are relative to the storage root: `$GTG_HUB` if set, else the current git repo's root.

1. Read `docs/handoffs/_active.json`. Match `<name>` against `slug` first, then fuzzy against `project`. **If no match, also read `docs/handoffs/_backlog.json`** and match the same way. **Active wins collisions:** if the name matches in both, take the active entry.
2. If multiple entries match ambiguously, ask: "Which project — [list matches]?"
3. Read the linked handoff file (the entry's `file`, relative to the storage root).
4. Respond: `"Found your [date] handoff for [project] — picking up from [next action]."`
5. **Consume the entry** (do this before working, however you arrived): run `node "${CLAUDE_PLUGIN_ROOT}/skills/gtg/gtg.mjs" resume <slug>` — it removes the entry from the active list or the backlog (whichever holds it) and commits. Use `resume`, never `remove`: `remove`/`prune` means the project **shipped**, and mixing the two makes throughput history meaningless. The CLI owns this mechanic; don't hand-edit the JSON.
5b. **Run resume hooks.** In order: (1) read and follow `${CLAUDE_PLUGIN_ROOT}/skills/gtg/extensions/skill/on-resume.md` (bundled — restores the prior session's task list, notes active skills); (2) if `<storage-root>/.gtg/skill/on-resume.md` exists, read and follow it too. Missing hook files are simply skipped.
6. Continue from the Next Action without further preamble.

**Stale handoff:** if the Next Action already looks done (files match, work complete), say so and ask how to proceed instead of redoing it — but still consume the entry (step 5); a pulled handoff is never left dangling.

**Never** work a handoff's Next Action while its entry still sits in `_active.json` (or `_backlog.json`).
