# Starting a sprint

How to take a learner from "I want to learn X" to a running sprint — nothing here assumes who is asking or what they've studied before.

## 1. Read the profile first

Before asking anything, run `learn profile`. If a profile already exists it may answer the level question below from a past sprint, and shows what's already been covered — don't make the learner re-answer something the profile already knows. If it prints "No profile yet", this is a first-ever sprint: proceed with cold intake, and don't try to seed a profile now — the intake answers below are the sprint's input, not a profile.

No `learn` verb writes the profile; the CLI only reads it, and a profile appears only when a human writes `.learn/profile.md`, or asks for a draft to be written there. Section 7 of [running-a-session.md](running-a-session.md) covers proposing that draft at the end of a sprint, which is where a first profile normally comes from.

## 2. Ask three intake questions, one at a time

1. **What do you want to learn?** If the profile already has a level for this subject, skip straight to confirming it in question 2 rather than asking cold.
2. **What's your current level with this, in plain language?** Not a number — "never touched it", "can read it, can't write it", "shaky but functional". A number invites false precision neither of you can act on.
3. **What's your rough weekly time budget?** e.g. "4-6 hrs/week, evenings". There's no calendar anywhere in this system, so no day or time slots are needed — this only sizes the sprint's pacing, how many weeks and how big each milestone is.

## 3. Pick the track

Run `learn tracks` to list what's available — bundled tracks and, if the learner has any at `.learn/tracks/`, their own overrides of the same name. For each candidate, read its `Pick this when` section before choosing; that's what tells you whether this subject fits a code-shaped track, a concept-shaped one, or whatever else is registered. Don't guess the track from the subject name alone — read the section.

## 4. Scope it — four questions

Answer these before touching `learn start`:

1. **What will I build, or have written, by the end of this sprint?** Concrete and small enough to picture — "a script that reads a CSV and outputs a summary", or "a one-page explanation of X I could hand to someone else", depending on what the track produces.
2. **What skill does this require that I don't have yet?**
3. **What's the smallest working version of this I could produce in one session?** Calibrate against question 2 of the intake: "never touched it" needs a smaller smallest-version than "shaky but functional".
4. **Do I have a real problem this solves, or am I practicing?** If practicing, find a real problem first — the project is the motivation, not a container for it.

The output is a one-paragraph sprint goal plus a rough sequence of weekly milestones, paced against the time budget from question 3 of the intake. That output has a file: `learn start` scaffolds `docs/learning/<slug>/sprint.md` with a heading per question above plus a milestone list, so write these four answers and the milestone sequence into it as soon as section 6 has created it. It is the one artifact of this scoping pass, and nothing else on disk records the goal.

## 5. Curriculum cross-check

Before finalizing the milestone sequence, optionally hand it to `logical-research` via `learn brief`, to check how this subject is actually structured in real courses and curricula — official docs' own learning paths, well-regarded syllabi, textbook tables of contents — and flag anything the self-scoped sequence is likely missing.

`learn brief` reads the angle and the corpus (what to research, and how) from stdin and writes `docs/learning/<slug>/corpus-brief.md`, then prints `BRIEF-WRITTEN <path>`. The `angle` is where every sprint-specific instruction goes: what the milestone sequence already covers, what to check it against, what shape the flags should take. Two rules govern this handoff, verbatim from `logical-research` itself:

> The output path is the return value. Finish by printing `<root>/<slug>/`. The caller links to that folder, it does not copy the contents out — one fact, one home.

> Know nothing about the caller. No branch in this skill reads "a learning sprint asked" or "a review asked". If a caller needs something shaped differently, that belongs in its `angle`.

So: link to the pack `logical-research` returns, never copy its contents into the sprint's own files, and put anything this sprint needs that a generic research pass wouldn't know to do into the `angle` — `logical-research` has no idea it's being called from a learning sprint.

**This is a gap-check against a plan already made, not a replacement syllabus.** The seeded curriculum is a source pool and a check for gaps — it never becomes the sequence itself unless the track's own `Sequencing` section says to go syllabus-first. Confirm any additions with the learner before folding them into the milestone sequence; never silently rewrite it. If the research path is unavailable, proceed with a disclosed "cross-check skipped — unsourced, verify later" note rather than blocking the sprint.

## 6. Start it

Run `learn start <subject> --track <name>`. This fails with a usage error if either argument is missing, if a track by that name isn't registered — run `learn tracks` again if unsure of the exact name — or if that track file is missing one of the six headings, in which case the message names which ones. On success it prints:

```
STARTED <slug>
  track:   <track>
  content: <content-dir>/
  scope:   <content-dir>/sprint.md — write the goal and milestones into it
GTG-NEW <slug> — create the gtg project for "Learning: <subject>" with parent "learning". Skip if gtg is not installed.
```

It has created the content directory and `sprint.md` inside it, a template with a heading per section 4 question and a milestone list. Fill it in now, from the answers already in hand — an empty `sprint.md` a week later is a sprint with no stated goal. From here on, [running-a-session.md](running-a-session.md) covers every subsequent session.

`GTG-NEW` is a directive to the skill, not something `learn start` does itself — `learn.mjs` never spawns gtg. Act on it: create the gtg project named in the line, skipping it only if gtg isn't installed.

If `learn start` instead reports that the sprint already exists, this isn't a new sprint — stop and go to `learn week` instead, per running-a-session.md.
