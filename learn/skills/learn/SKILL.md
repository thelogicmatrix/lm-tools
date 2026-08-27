---
name: learn
description: 'Use when the user says "I want to learn X", "start a learning sprint", "what week am I on", "grade my consolidate", "learn tracks", "learn profile", or "cross-check my curriculum", when a study session is starting or under way, or when a gate result needs recording. Self-directed learning sprints over the learn CLI.'
---

# learn: self-directed learning sprints

One subject, one real project, one new concept per session, each session closing on a
pass/fail mastery gate that decides whether the next advances or repeats the same concept
with a different worked example. The CLI owns the bookkeeping (week, concept, gate history,
verify due). The teaching is yours.

`learn` below is `node "${CLAUDE_PLUGIN_ROOT}/skills/learn/learn.mjs"`. State lives under
`.learn/` in the current git repo, or `$LEARN_HUB` when set; week pages under
`docs/learning/<slug>/`. Each state-changing verb commits its own writes. Track files, when a
reference says to read a section of one: `${CLAUDE_PLUGIN_ROOT}/skills/learn/extensions/tracks/<name>.md`,
or `.learn/tracks/<name>.md` for a learner override of the same name.

| Trigger | Do this |
|---|---|
| "learn tracks" / "what tracks are there" | `learn tracks`, relay. **Stop.** |
| "I want to learn X" / "start a learning sprint" | Follow [references/starting-a-sprint.md](references/starting-a-sprint.md). |
| `learn start` printed `GTG-NEW <slug>` | A directive to you; `learn` never spawns gtg. Create that gtg project with `--parent learning` per gtg's own skill. No gtg installed: say so once, carry on. |
| "what week am I on" / "where did we get to" | `learn week`, relay. **Stop.** |
| a study session is starting, or is under way | Follow [references/running-a-session.md](references/running-a-session.md), the whole session from `learn week` to the gtg departure. |
| "grade my consolidate" / a gate result to record | Section 4 of [references/running-a-session.md](references/running-a-session.md). Never self-certified; *how* to grade is the track's `Mastery gate` section, never invented per session. |
| "cross-check my curriculum" / "is my reading list missing anything" | Follow [references/curriculum-check.md](references/curriculum-check.md). Reachable mid-sprint, not only at the start. |
| a sprint is finishing / "write up what I learned" | Follow [references/sprint-end.md](references/sprint-end.md). No verb writes the profile; you draft, the learner files it. |
| "what have I covered" / "what's in my profile" | `learn profile`, relay. **Stop.** |
| "why is it shaped this way" / "is any of this evidence-based" | Read [references/pedagogy.md](references/pedagogy.md); answer from the part the question lands in. |

**Zero-model rule.** `tracks`, `week` and `profile` are bookkeeping: shell out and relay.
Never re-derive a week number, concept, gate history or verify date from
`.learn/sprints/<slug>.json`; the CLI just computed it.

**Stop where the table says Stop.** That output is the whole response.

**Do not read a reference file unless its row fired.** They are long, and one row needs one.

Exit codes: `2` usage or environment, fix and re-run. `1` a real failure, nothing advanced,
the message says what is on disk. `0` success.
