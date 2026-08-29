# Curriculum cross-check

A gap-check of the sprint's milestone sequence against how the subject is actually
structured in real courses and curricula: official docs' own learning paths, well-regarded
syllabi, textbook tables of contents. Optional, and reachable at any point in a sprint.

1. Run `learn brief`. It reads the **angle** and the **corpus** from stdin and writes
   `docs/learning/<slug>/corpus-brief-week-<N>.md`, then prints `BRIEF-WRITTEN <path>`. The angle
   carries every sprint-specific instruction: what the sequence already covers, what to
   check it against, what shape the flags should take. `logical-research` knows nothing
   about the caller, so anything this sprint needs goes in the angle.
2. Hand the brief to `logical-research`. It returns a pack path.
3. **Link to that pack, never copy its contents** into the sprint's own files. One fact, one
   home.
4. Fold flagged gaps into the milestone sequence **only with the learner's confirmation**.
   The seeded curriculum is a source pool and a gap check, never the sequence itself, unless
   the track's own `Sequencing` section says to go syllabus-first.

If the research path is unavailable, proceed with a disclosed "cross-check skipped,
unsourced, verify later" note rather than blocking the sprint.
