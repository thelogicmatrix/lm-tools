# Starting a sprint

From "I want to learn X" to a running sprint. Nothing here assumes who is asking or what
they have studied before.

## 1. Read the profile first

Run `learn profile`. An existing profile may already answer the level question below and
shows what has been covered; do not make the learner re-answer it. `No profile yet` means a
first-ever sprint: cold intake, and do not seed a profile now. The intake answers are the
sprint's input, not a profile. No verb writes the profile; [sprint-end.md](sprint-end.md) is
where a first one normally comes from.

## 2. Three intake questions, one at a time

1. **What do you want to learn?** If the profile has a level for this subject, skip to
   confirming it in question 2.
2. **What is your current level, in plain language?** Not a number: "never touched it",
   "can read it, can't write it", "shaky but functional". A number invites false precision.
3. **Rough weekly time budget?** e.g. "4-6 hrs/week, evenings". No calendar exists here;
   this only sizes pacing, how many weeks and how big each milestone is.

## 3. Pick the track

`learn tracks` lists bundled tracks and any learner overrides at `.learn/tracks/`. Read each
candidate's `Pick this when` section before choosing. Never guess the track from the subject
name.

## 4. Scope it: four questions

1. **What will I build, or have written, by the end?** Concrete and small enough to picture.
2. **What skill does this need that I don't have yet?**
3. **What is the smallest working version I could produce in one session?** Calibrate to
   intake question 2: "never touched it" needs a smaller version than "shaky but functional".
4. **Real problem, or practice?** If practice, find a real problem first. The project is the
   motivation, not a container for it.

Output: a one-paragraph sprint goal plus a rough weekly milestone sequence, paced to the time
budget. `learn start` scaffolds `docs/learning/<slug>/sprint.md` with a heading per question
and a milestone list; write these answers into it as soon as section 6 creates it. Nothing
else on disk records the goal.

## 5. Curriculum cross-check (optional)

Before finalizing the sequence, [curriculum-check.md](curriculum-check.md).

## 6. Start it

`learn start <subject> --track <name>`. Exit 2 if either argument is missing, the track is
not registered (`learn tracks` for the exact name), or the track file lacks one of its six
headings (the message names which). On success:

```
STARTED <slug>
  track:   <track>
  content: <content-dir>/
  scope:   <content-dir>/sprint.md — write the goal and milestones into it
GTG-NEW <slug> — create the gtg project for "Learning: <subject>" with parent "learning". Skip if gtg is not installed.
```

Fill `sprint.md` now from the answers in hand; an empty one a week later is a sprint with no
stated goal. `GTG-NEW` is a directive to you, not something `learn start` did: create that
gtg project, skipping only if gtg is not installed. If `learn start` reports the sprint
already exists, this is not a new sprint: go to `learn week` and
[running-a-session.md](running-a-session.md).
