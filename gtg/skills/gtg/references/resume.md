# gtg — Resume Procedure

Triggered by `gtg resume <project>` or a natural-language "let's continue X" (also fires implicitly: if you read an active handoff and start working its Next Action, that consumes it — run the consume step below regardless of how you got here).

All paths below are relative to the storage root: `$GTG_HUB` if set, else the current git repo's root.

1. Read `docs/handoffs/_active.json`. Match `<name>` against `slug` first, then fuzzy against `project`. **If no match, also read `docs/handoffs/_backlog.json`** and match the same way. **Active wins collisions:** if the name matches in both, take the active entry. The two stores partition the work as of 1.10.4 — every writer moves a slug rather than copying it — so a real collision now means hand-edited JSON. The rule stays as the tie-break for that case.
2. If multiple entries match ambiguously, ask: "Which project — [list matches]?"
3. Read the linked handoff file (the entry's `file`, relative to the storage root).
4. Respond: `"Found your [date] handoff for [project] — picking up from [next action]."`
5. **Consume the entry** (do this before working, however you arrived): run `node "${CLAUDE_PLUGIN_ROOT}/skills/gtg/gtg.mjs" resume <slug>` — it removes the entry from the active list or the backlog (whichever holds it) and commits. Use `resume`, never `remove`: `remove`/`prune` means the project **shipped**, and mixing the two makes throughput history meaningless. The CLI owns this mechanic; don't hand-edit the JSON.
5b. **Run resume hooks.** In order: (1) read and follow `${CLAUDE_PLUGIN_ROOT}/skills/gtg/extensions/skill/on-resume.md` (bundled — restores the prior session's task list, notes active skills); (2) if `<storage-root>/.gtg/skill/on-resume.md` exists, read and follow it too. Missing hook files are simply skipped.
6. Continue from the Next Action without further preamble.

**Stale handoff:** if the Next Action already looks done (files match, work complete), say so and ask how to proceed instead of redoing it — but still consume the entry (step 5); a pulled handoff is never left dangling.

**Never** work a handoff's Next Action while its entry still sits in `_active.json` (or `_backlog.json`).

## Working a package

**An issues package is the one exception to step 5: do not consume it.** `gtg issues <pN>` says so in its own directive line.

The rest of the Procedure applies — read the handoff, run the hooks, continue from the Next Action — but the entry stays where it is.

A package entry is not only a bookmark. It is the only live mapping from its `pN` to a name, and every `docs/issues/` file in the batch carries `**Package:** pN` pointing at it. Consuming it orphans all of them at once: they fall back to loose, `gtg issues` reports a stale package ref, and the package stops existing for exactly as long as you are working it. A session that ends before re-parking leaves it that way.

So a package retires by being **finished**, not by being picked up. Fix its members and delete their files as you go; when the last one goes, its row renders `no members - unstamped, or done` and names the `gtg remove` that closes it. That row is the retirement prompt — nothing else is needed.

The rule step 5 protects still holds for ordinary handoffs, where the entry really is a bookmark you are holding and would otherwise dangle.
