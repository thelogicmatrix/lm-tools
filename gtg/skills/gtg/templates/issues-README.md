# Issues folder: loose-fix backlog

A gtg-style holding pen for small known problems that aren't worth their own session
when discovered, but shouldn't evaporate into chat history either. The typical
consumer is an occasional **fix session**: pick a few that share an area, knock them out in
one sitting, delete the files.

## Conventions

- One file per issue: `YYYY-MM-DD-short-slug.md` (date = when filed).
- One `·`-separated field line under the title, plus `Check` and `Status` on their own lines:

  ```markdown
  # <one-line title>

  **Area:** <area> · **Effort:** minutes · **Blocked on:** <thing>
  **Check:** `<command that answers "is this still broken?">` still fails
  **Status:** worked-around (<what the workaround is>)
  ```

  - **Area:** a short name for the part of the world this belongs to. Nothing validates it, so
    drifting off whatever set this folder already uses quietly fragments your own view of it.
    Agreeing on a small list and keeping to it is the only reason the field is worth anything.
  - **Effort:** start the value with one of `minutes`, `hour` or `session`, with any nuance in
    a parenthetical after it. For a range, write the wider end and put the range in the
    parenthetical.
  - **Blocked on:** anything that must happen first (a human decision, a restart window,
    an upstream release). Omit it, or write `none`, when nothing blocks.
  - **Check:** the command or condition that answers "is this still an issue?". **Required on
    new issues.** A filer who cannot say how to tell whether the problem is still real does
    not understand it well enough to file it. An issue with no `Check` is unverifiable.
    **A `Check` that only reproduces the original symptom is not a `Check`**, so write it at
    the level of the failure class. The disposition table below stops a narrow `Check` from
    deleting a file, and this stops it being written in the first place.
  - **Status:** `worked-around (<what>)` means the symptom is handled and the failure class is
    still live. Such a file is **never deleted**. Anything else in `Status` is free prose and
    changes nothing.

  `Check` and `Status` get their own lines because a `Check` is usually a command. They are
  **paragraph fields**: they run to the next blank line, the next field line, or a fence, so a
  long one can wrap freely and a `·` inside one is kept. The `·`-separated line is the other
  shape, and those fields stop at the separator.

  A field only counts when its **line begins with the bold label**, and never inside a fenced
  block. So an issue file can quote the field syntax verbatim, in prose or in a ```` ``` ````
  example, without the reader taking it as that file's own membership.
- Body: what's wrong, why it matters, and the known fix path or first diagnostic step.
  Link related memory files by name.
- Keep it short. A few lines is the target, because this is a pointer for a future session
  and not a spec. The exception is an issue that **is** the investigation record, where the
  diagnostic history is the value and belongs in one place. That is rare. A file that grew
  long without becoming the record of its own diagnosis is just long.
- **No secrets** in issue files. Reference the vault entry or the memory file instead.

## Reading the folder

`ls docs/issues/` lists it and `rg` over the field lines filters it. No command reads it.

There is no closing verb. Closing an issue means deleting its file, or amending it when only
the symptom was handled, per the Lifecycle below.

## Lifecycle

1. **File.** Any session that spots a loose end writes an issue file here instead of
   (or in addition to) mentioning it in chat.
2. **Fix session.** List the folder, pick a few issues that share an area, and fix them in one
   sitting.
3. **Close.** **Run the `Check` first**, then take the row it lands on:

   | Check result | Disposition |
   |---|---|
   | Passes, and the `Check` tests the **class** | Close. Delete the file. Say so in session. |
   | Passes, but the `Check` only pinned the original reproduction | **Not a pass.** Widen the `Check` to the class, re-run it, and take whichever row that lands on. |
   | Fails, and the root cause is fixed | Close. Delete the file. |
   | Fails, and only the symptom is handled | `Status: worked-around (<what the workaround is>)`, rewrite `Check` to test the **class** rather than the old symptom, and **keep the file**. The name goes in the parenthetical, so a reader sees what the workaround is without opening the history. |
   | No `Check` on the file | Unverifiable. Write one before working it, or delete the issue as a guess about the past. |

   **Never delete a file whose failure class is still live.** The table serves that rule but
   does not enforce it, so it is stated on its own.

   Both closing forms commit with explicit paths on both ends in one command, because several
   sessions can stage work in one checkout at once and a `git commit -a` after an `rm` sweeps
   theirs into yours:

   ```bash
   # the class is dead
   git rm docs/issues/<file>.md && git commit docs/issues/<file>.md -m "issues: close <slug>"

   # the class is live, so the file stays and only Status changes
   git add docs/issues/<file>.md && git commit docs/issues/<file>.md -m "issues: <slug> worked around"
   ```

   A durable lesson from the fix goes in file memory (that's memory's job, not this folder's).
   An abandoned issue gets deleted too, said out loud in the session rather than left to rot.

A dated file that survives more than a few fix sessions is a signal it's either
blocked (fine, the header should say so) or not actually worth doing (delete it).
