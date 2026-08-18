---
name: learn
description: 'Use when the user says "I want to learn X", "start a learning sprint", "what week am I on", "grade my consolidate", "learn tracks", or is otherwise running a self-directed learning sprint: one subject, one project they actually want, one new concept per session, and a graded mastery gate that decides whether the next session advances or repeats. Owns `.learn/` (sprint state, your own tracks, the learner profile) and the week pages under `docs/learning/`. Also engages when a study session starts, when a gate result needs recording, when a verify exercise is due, or when a sprint needs a curriculum cross-check.'
---

# learn: self-directed learning sprints

A sprint is one subject, one real project, and one new concept per session, each session closing on a pass/fail mastery gate that decides whether the next one advances to a new concept or repeats the same one with a different worked example. The CLI owns the bookkeeping — which week, which concept, what the last gate said, when a verify exercise is due. The teaching is yours.

`learn` below is `node "${CLAUDE_PLUGIN_ROOT}/skills/learn/learn.mjs"`. It stores state under `.learn/` in the current git repo, or under `$LEARN_HUB` when that is set, and writes week pages under `docs/learning/<slug>/`. Each state-changing verb commits its own writes, so you never need to commit after one; it stays silent when the store root is not a git toplevel.

| Trigger | Do this |
|---|---|
| "learn tracks" / "what tracks are there" | Run `learn tracks`, relay its output. **Stop.** |
| "I want to learn X" / "start a learning sprint" | Read [references/starting-a-sprint.md](references/starting-a-sprint.md) and follow it. |
| `learn start` printed a `GTG-NEW <slug>` line | A directive to you, not something the CLI did — `learn` never spawns gtg. Create the gtg project that line names, with `--parent learning`, per gtg's own skill. If gtg is not installed, say so once and carry on: the sprint works without it. |
| "what week am I on" / "where did we get to" | Run `learn week`, relay its output. **Stop.** |
| a study session is starting, or is under way | Read [references/running-a-session.md](references/running-a-session.md) and follow it. It covers the whole session: `learn week`, sourcing the week's one concept, `learn page`, the track's own session shape, the gate, and the verify exercise. |
| a sprint is finishing / "write up what I learned" | Section 7 of [references/running-a-session.md](references/running-a-session.md). No verb writes the learner profile, so draft the update and hand it over; it lands at `.learn/profile.md` only when the learner writes it or asks you to. |
| "grade my consolidate" / a gate result to record | Section 4 of [references/running-a-session.md](references/running-a-session.md). The gate is never self-certified, and *how* to grade it is the track's own `Mastery gate` section rather than something to invent per session. |
| "cross-check my curriculum" / "is my reading list missing anything" | Section 5 of [references/starting-a-sprint.md](references/starting-a-sprint.md). It is reachable mid-sprint, not only at the start: `learn brief` writes the brief, `logical-research` returns a pack path, and you link to that pack rather than copying it out. |
| "what have I covered" / "what's in my profile" | Run `learn profile`, relay its output. **Stop.** |
| "why is it shaped this way" / "is any of this evidence-based" | Read [references/pedagogy.md](references/pedagogy.md). It separates the cited research from this plugin's own unvalidated defaults, so answer from the part the question actually lands in. |

**Zero-model rule.** `tracks`, `week` and `profile` are pure bookkeeping: shell out and relay what they print. Never re-derive a week number, a concept, a gate history or a verify due date by reading `.learn/sprints/<slug>.json` — the CLI just computed all of it, and a second answer is a wrong answer waiting to happen.

**Stop where the table says Stop.** That row's output is the whole response — no restating what it meant, no offer to do the next thing.

**Do not read a reference file unless its trigger fired.** There are three, they are long, and reading them all up front is an expensive way to answer "what tracks are there".

Exit codes: `2` is a usage or environment error, so fix the command or the setup and re-run. `1` is a real operation that failed, in which case nothing advanced and the message says what is on disk. `0` is success.
