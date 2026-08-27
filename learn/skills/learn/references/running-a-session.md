# Running a session

One study session, any track. Steps in order. The CLI prints the state; you supply the
teaching.

## 1. `learn week`

Run it first, every session. It prints subject, week and track, then one of `REPEAT
<concept>` (the last gate failed: a DIFFERENT worked example on the same concept, never a
re-read), `ADVANCED <concept>` (picked, not yet gated) or `ADVANCED no concept set` (pick
this week's one new concept). `VERIFY-DUE` means section 5 is mandatory this session.

## 2. Source the concept, then `learn page`

One research pass on this week's single concept: official docs, well-regarded course or
textbook material, primary references. Checkable sources, not memory. If research is
unavailable, proceed with a disclosed "unsourced, verify later" flag rather than skipping
the page.

`learn page <concept>` stamps `docs/learning/<slug>/week-<N>-<concept>.md` (objective
callout, worked example, the principle it generalizes to, a caution callout, worksheet,
sources), sets the concept on the sprint and prints `PAGE <path>`. It never overwrites. On a
repeat week omit the argument: the concept is already set and only the week moved, so the
file is new and the different-example rule holds structurally. Fill the placeholders before
build work starts; the track's first block reads this page.

## 3. The track's `Session shape`

Read that section of the track file (the track is on `learn week`'s first line) for how
this track splits working time. Never assume a code-shaped plan on a non-code track.

## 4. Grade the gate. Never self-certified

The consolidate step is a pass/fail gate against the page's objective callout, graded the
way the track's `Mastery gate` section says, not a way invented this session. Record it:

`learn gate <pass|fail> [--verified] [--sprint <slug>]`

Pass clears the concept and advances the week. Fail keeps the concept and still advances the
week, so next session is a different worked example on the same concept. `--sprint` only
when more than one sprint's state file exists.

## 5. Verify exercise

When the concept admits a genuine spot-the-bug (a common, instructive mistake, not a
contrived one), fold one in per the track's `Verify exercise` section: a short snippet,
sometimes clean, sometimes subtly wrong, work out which and why. Never force a fake bug.
Floor: once every 2 weeks from the last one that ran; a sprint that never ran one is due at
week 2. Pass `--verified` to `learn gate` when one ran, or the floor reads as unmet. Two
weeks with no natural fit: the third includes one even if it takes contriving, or the gap is
recorded at the sprint review, never skipped silently.

## 6. End with gtg

Close every session with a gtg departure, even a rushed one. `learn`'s state holds week,
concept and gates, no narrative; the handoff is the only record of what got built and where
you stopped. Nothing here spawns it.

## 7. Sprint finished

Follow [sprint-end.md](sprint-end.md).
