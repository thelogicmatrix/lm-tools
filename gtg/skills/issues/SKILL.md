---
name: issues
description: Use when a problem surfaces while attention is somewhere else and is about to be named in chat and left there, so it gets filed in docs/issues/ instead of lost. That covers a failure noticed while working on something unrelated, a problem declared out of scope or left for later, and a loose end mentioned with no intention of acting on it ("that's a separate bug", "we should fix that later", "out of scope for now", "not this session", "noting this", "unrelated, but", "someone should look at that", a failure found while working on something else). Also use when a session spots any loose end worth filing in docs/issues/, and when closing, re-checking, or re-testing an existing issue ("is this still an issue", "that's fixed, close it", "issue list", "fix session", "prune that issue").
---

# issues: file it, or lose it

`gtg issues` reads and packages `docs/issues/`. This skill is the two things no command does:
filing and closing.

## Filing does not ask

Spot a loose end, write the file, commit it, then say one line about what you filed. Do not
ask first. Loose ends surface exactly when attention is elsewhere, and a prompt at that
moment is what makes people say "later" and lose it.

Filename: `docs/issues/YYYY-MM-DD-short-slug.md`, date = today. Fields, allowed values and
body shape: `docs/issues/README.md`. Read it rather than guessing, and invent no fields.

If `docs/issues/README.md` does not exist, copy it from
`${CLAUDE_PLUGIN_ROOT}/skills/gtg/templates/issues-README.md` before filing, and commit it
with the issue. Never overwrite an existing one. It is the folder's own conventions and the
person who wrote it outranks the template.

Home is a shared checkout, so commit with explicit literal paths on both ends of one command:

```bash
git add docs/issues/2026-08-04-my-slug.md && git commit docs/issues/2026-08-04-my-slug.md -m "issues: file my-slug"
```

### The bar for filing at all

**File it** when it is a real, bounded problem that a future session could fix in one
sitting, and it would otherwise be lost.

**Don't file:**

- what belongs in memory (a durable fact or lesson)
- what the code or git history already records
- what is already an open issue (check `gtg issues` first)
- a vague dissatisfaction with no named symptom. "We should refactor this someday" is not an
  issue.

### Every filed issue carries a `Check`

A `Check` is how a later session tells whether the problem is still real: a command to run,
or the condition that reproduces it. **A `Check` that only reproduces the original symptom is
not a `Check`**, so write it at the level of the failure class. The table below stops a narrow
`Check` from deleting a file. This stops it being written at all.

If you cannot state one, you do not understand the problem well enough to file it. Work the
Check out, or drop the issue.

## Closing: run the `Check` first

Never decide from your memory of what was wrong. Run the `Check`, then take the matching row:

| Check result | Disposition |
|---|---|
| Passes, and the `Check` tests the **class** | Close. Delete the file. Say so in session. |
| Passes, but the `Check` only pinned the original reproduction | **Not a pass.** Widen the `Check` to the class, re-run it, and take whichever row that lands on. |
| Fails, and the root cause is fixed | Close. Delete the file. |
| Fails, and only the symptom is handled | `Status: worked-around (<what the workaround is>)`, rewrite `Check` to test the **class** rather than the old symptom, and **keep the file**. The name goes in the parenthetical, because that is what `gtg issues` renders as `WORKED-AROUND: <what>`. |
| No `Check` on the file | Unverifiable. Write one before working it, or delete the issue as a guess about the past. |

**Never delete a file whose failure class is still live.** The table serves that rule without
enforcing it.

**The row for a `Check` that only pinned the original reproduction is where a narrow `Check`
bites.** The 07-25 guard Check passed, the symptom was gone, the file went, and the untouched
class fired again within the hour. A pass has to earn the word.

**The worked-around row is the rule that does the ongoing work.** A workaround that makes the tested path
pass is not a fix. A workaround is also a legitimate outcome, so record it honestly and keep
the file.

There is no closing command, deliberately. Fixing an issue means deleting its file, and that
judgment stays with you. Closing commits the way filing does, one command, explicit literal
paths on both ends. It matters more here: a session reaching for `git commit -a` after an `rm`
sweeps whatever the other sessions have staged.

```bash
git rm docs/issues/2026-08-04-my-slug.md && git commit docs/issues/2026-08-04-my-slug.md -m "issues: close my-slug"
git add docs/issues/2026-08-04-my-slug.md && git commit docs/issues/2026-08-04-my-slug.md -m "issues: my-slug worked around"
```

## Reading and working the folder

- `gtg issues`: everything, grouped by package
- `gtg issues packages`: the package shelf
- `gtg issues <pN | package slug | text>`: start working that package. Packages only, so a
  loose issue's own slug matches nothing
- `gtg issues pack`: prints the loose issues and asks you to propose batches.
  `gtg issues pack <pN> --name "<Name>" --next "<first step>" [--eta "<eta>"] [--dry-run] <slug>...`
  stamps one batch. `--dry-run` shows both writes without making either, and previews from
  anywhere because it never spawns.
