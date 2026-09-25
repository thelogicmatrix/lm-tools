# Runbook lifecycle

How a runbook is created, kept true, merged and retired. The header rules are in `format.md`.
How to write the purpose line is in `purpose-lines.md`. This file is the process around them.

## Steps

1. **Pick the genre by what the reader does with it.** A rule they must not break is a standard.
   Facts they look up are a reference. Steps they run are a procedure, and it needs a `## Steps`
   heading. Something wrong on purpose in one code path is a residual. Something tried and ended
   is a postmortem. The genre decides the cost. The router asks about every procedure, standard
   and reference on every prompt, so a history log typed as a standard is a question paid for on
   every prompt and never worth the answer. Residuals and postmortems are not routed at all, only
   named at session start.
2. **Write the purpose line and gate it** per `purpose-lines.md`. That means 25 words or fewer,
   one physical line, 0.85 on three or four prompts worded the way a task would arrive, and one
   unrelated prompt under 0.8. Add `--record` to the passing run so the ledger holds its prompts.
3. **Update in the same session.** A run that hits a new issue folds the fix into the runbook's
   Gotchas. Removing or renaming anything a runbook could name (a container, path, skill, tool,
   account or repo) means searching the runbooks folder for it and fixing or retiring what
   mentions it. A fact goes to the one runbook that owns its topic, never a second copy.
4. **Merge a duplicate** by copying every fact the survivor lacks into its structure. Then retire
   the other file (step 5) and repoint live references to the survivor. Check that the survivor's
   purpose covers the absorbed file's prompts.
5. **Retire, do not delete.** Put `**Status:** retired YYYY-MM-DD — why` under the Type line. The
   em dash in that line is required by the lint. The Status line keeps the router from routing it.
   Then move the file into a `retired/` subfolder, which keeps it out of the session-start index
   while leaving it one move away from revival. Leave a tombstone at the top level only when a
   future session could plausibly re-propose the idea, because every top-level tombstone is paid
   for in every session.
6. **Run the health check** after any batch of edits:
   - `node <plugin>/scripts/index.mjs --lint`. Fix every violation. The advisories are work too. A
     missing local path is fixed, or reworded as plain-text history outside backticks. A changed or
     never-checked purpose goes to the next line.
   - `node <plugin>/scripts/check.mjs --changed`. It re-scores only purposes that moved since their
     ledger entry, with the stored prompts. An unchanged purpose costs nothing, so never re-score a
     passing line and never reword one that passes.
   - `node <plugin>/scripts/router.mjs --selftest` and `node --test <plugin>/test/*.test.mjs` when
     the plugin's own code changed.

## Parking a runbook

A live process that is not in use gets `**Status:** dormant YYYY-MM-DD, why`. It never routes and
is named nowhere at session start. Delete the line to wake it. Use this instead of retiring a
process that is only asleep.

## Subfolders

The router reads subfolders of the runbooks folder, except one named `archive`. A file there with
a Type line and a Purpose line routes like any other runbook, and `check.mjs` cannot score it,
because it matches by file name. Keep Type lines out of non-runbook files in subfolders. The
session-start index and the lint read the top level only.
