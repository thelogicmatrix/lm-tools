# Running a session

How to run each study session once a sprint exists. Lifted from the `learning-code` runbook this skill replaces, generalized to whatever track the sprint picked.

## 1. Start with `learn week`

Every session, before anything else, run `learn week`. It prints the subject, the current week number and track, then one of:

- `REPEAT <concept> — the last gate failed, so a DIFFERENT worked example on the same concept.` — the previous session's mastery gate failed. This week does not introduce a new concept; it's another attempt at the same one, with a different worked example, never a re-read of the last one.
- `ADVANCED <concept> — picked, not yet gated.` — a concept is already set for this week (from a prior `learn page` call) and hasn't been graded yet.
- `ADVANCED no concept set. Pick week <N>'s one new concept.` — nothing is set yet; this is a fresh week and the first job is choosing its one concept.

If a verify exercise is due (see below), it also prints `VERIFY-DUE  the verify exercise floor is 2 weeks and it is due this session.` A trailing `last gate: week <N> <concept> -> <pass|fail>` line, when any gate has been recorded, shows what the previous session decided.

## 2. Source the week's one concept, then `learn page`

Do one research pass on this week's single new concept — not the whole sprint, matching the one-concept-at-a-time rule. Look for real, current, canonical sources: official docs, well-regarded course or textbook material, primary references, the same rigor as any other reliable-answers pass. If the research path is unavailable, proceed with a disclosed "unsourced, verify later" flag rather than skipping the page.

Then run `learn page <concept>`. This stamps `docs/learning/<slug>/week-<N>-<concept>.md` from a fixed template — objective callout, worked example, the principle it generalizes to, a caution callout for simplifications, a worksheet, and sources — sets the concept on the sprint, and prints `PAGE <path>`. It refuses to overwrite a file that already exists there, so running it twice for the same week is a no-op guard, not a way to regenerate. Fill in the template's placeholders with the actual worked example and sources before the session's build work starts — it's what session A's read/example step consumes.

Because the week number moves forward after every gate, pass or fail, a repeated concept always gets a fresh filename (`week-<N+1>-<concept>.md`, not the old one) — the "different worked example" rule is enforced structurally, not just by instruction.

## 3. Follow the track's own session shape

Read the track file's `Session shape` section (from `learn tracks`, or the track named in `learn week`'s first line) for how this track structures the actual working time — what a session's read/modify/build/consolidate split looks like for this kind of material. Don't assume a code-shaped session plan applies to a track that isn't code-shaped; the section is there so the skill doesn't have to guess.

## 4. Grade the mastery gate — never self-certified

Every session's consolidate step is a real pass/fail gate against the week's stated objective (the reference page's objective callout), not a ritual, and it is never self-certified — a novice grading their own understanding is an unreliable judgment. Read the track's own `Mastery gate` section for how this track expects the gate to be graded (what counts as demonstrating it).

Record the result with `learn gate <pass|fail> [--verified] [--sprint <slug>]`:

- **Pass** clears the concept and advances the week. Prints `ADVANCED to week <N>`. Next session introduces the next new concept as planned.
- **Fail** keeps the concept set and still advances the week. Prints `REPEAT <concept> at week <N>`. Next session does **not** introduce a new concept — it's a different worked example on the same one, never simply re-reading the same material.

`--sprint <slug>` is only needed when more than one sprint's state file exists at once; with a single active sprint it's picked automatically.

## 5. The verify exercise, and its floor

When the week's concept lends itself to a genuine "spot the bug" exercise — a plausible mistake in this concept that's common and instructive, not contrived — fold it in before continuing: a short snippet, sometimes clean and sometimes subtly wrong, and work out which and why. Read the track's `Verify exercise` section for what this looks like for this kind of material.

**Never force a fake bug where nothing plausible exists to find.** But there's a floor: at least once every 2 weeks, measured from the last week a verify exercise actually ran — a sprint that has never run one is due starting week 2. `learn week` and `learn gate` both surface this as `VERIFY-DUE` when it applies. When a verify exercise does run this session, pass `--verified` to `learn gate` so the floor check reads it as satisfied; without that flag, a session with a verify exercise still shows as due next check. If two consecutive weeks pass with no natural fit, the third week should include one even if it takes some contriving, or the gap should be recorded explicitly at the sprint's review rather than silently skipped forever.

## 6. End every session with a gtg departure

Close every study session with a normal gtg departure ("gtg"), even a rushed one. `learn`'s own state file (`.learn/sprints/<slug>.json`) tracks week, concept and gate history, but it holds no narrative — no "what got built", no "where we stopped mid-thought", no next-action text. The gtg handoff is the sprint's only record of that, which is what makes it resumable session to session. This is gtg's own Exit Procedure, not a `learn` verb — nothing here spawns it automatically.
