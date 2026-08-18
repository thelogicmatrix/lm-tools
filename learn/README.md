# learn — self-directed learning sprints for Claude Code

You want to learn something. Four weeks later you have read a lot, built nothing, and cannot tell whether any of it stuck. `learn` runs the other shape: a sprint anchored to a project you actually want, one new concept per session, and a **pass/fail mastery gate** at the end of every session that decides whether the next one moves on or takes another run at the same concept.

**The differentiator is that the gate is real and it is not yours to self-certify.** A model that agrees with everything is a mirror, not a feedback loop — so the gate is graded against the track's own criterion, a failed gate repeats the concept with a *different* worked example rather than a re-read, and a verify exercise has a floor so it cannot quietly get skipped forever. A CLI holds the week number, the concept, the gate history and that floor, so none of it depends on a model remembering what happened last Tuesday.

## Install

```
/plugin marketplace add thelogicmatrix/lm-tools
/plugin install learn@lm-tools
```

Node 18+. No dependencies, no second runtime.

## Use

Say "I want to learn X" and the skill fires. Everything below is also a plain CLI you can run yourself:

```
learn tracks                           list every track, bundled and your own
learn start <subject> --track <name>   create the sprint and its content directory
learn week                             what week, what concept, what is due
learn gate <pass|fail> [--verified]    record the mastery gate and advance the week
learn page <concept>                   stamp this week's reference page from the template
learn brief                            write a corpus brief for logical-research (body on stdin)
learn profile                          read the learner profile
learn help                             print the verb list
```

`week`, `gate`, `page` and `brief` act on the one sprint in the tree. With more than one they refuse rather than guess, and take `--sprint <slug>`. `brief` also takes `--shape <synthesis|synthesis+notes|synthesis+notes+raw>` (default `synthesis+notes`) and `--research-root <dir>` (default `docs/research`).

Sprint state lives in `.learn/` inside the current git repo — `sprints/<slug>.json`, your own tracks in `tracks/`, the profile at `profile.md`. Set `LEARN_HUB` to keep one learning hub across many repos. Week pages are written under `docs/learning/<slug>/`, one per week, and `learn page` refuses to overwrite one that already exists.

Exit `2` is a usage or environment error, exit `1` is a real operation that failed with nothing advanced, exit `0` is success.

## Tracks — and writing your own

A **track** is how one *kind* of subject is studied. Two ship: `code`, for subjects that produce working code, and `concept`, for subjects that do not — marketing, strategy, theory, design, history. The skill never guesses which; it reads each track's `Pick this when` section and chooses from that.

A track is a markdown file with six `##` headings, and the skill reads it by heading rather than by name, which is what lets it follow a track it has never seen:

| Heading | What it answers |
|---|---|
| `Pick this when` | which subjects this track is for — read before choosing, never inferred from the subject name |
| `Artifact floor` | the minimum a session must *produce* to count at all |
| `Session shape` | how the working time divides — read, apply, build, consolidate |
| `Mastery gate` | what counts as demonstrating the week's concept, since the gate is never self-certified |
| `Verify exercise` | what a "spot the flaw" exercise looks like for this kind of material |
| `Sequencing` | project-first, syllabus-first, or something else |

**Your own tracks go in `.learn/tracks/<name>.md` in your repo, and a file there overrides a bundled track of the same name.** Copy `code.md` or `concept.md`, keep the six headings, change the bodies. Names are `[A-Za-z0-9_-]+`. `learn tracks` marks yours as overriding. Nothing here is validated beyond the headings being present, so a track that suits how you actually study beats the two shipped ones.

## Pairs with

[`gtg`](../gtg) — the session layer. The relationship is **soft and one-directional**: `learn start` prints a `GTG-NEW` line that asks the *skill* to create the gtg project, and `learn.mjs` itself never spawns gtg or reads its store. Each side owns a different half. `learn` holds the mechanics — week, concept, gate history, verify floor — and holds no narrative at all: no what-got-built, no where-we-stopped, no next action. That is the gtg handoff's job, and it is what makes a sprint resumable a week later. gtg ships a `gtg learn` view that lists your sprints. Without gtg installed the sprint still runs; you just lose the narrative between sessions.

[`logical-research`](../logical-research) — the optional curriculum cross-check. `learn brief` writes `docs/learning/<slug>/corpus-brief.md` and prints `BRIEF-WRITTEN <path>`; hand that to `logical-research`, which returns a pack path. **Link to the pack, never copy its contents into the sprint's own files** — one fact, one home. Anything sprint-specific goes in the brief's angle, because `logical-research` deliberately knows nothing about its caller. It is a gap-check against a plan you already made, not a replacement syllabus, and if it is unavailable the sprint proceeds with a disclosed "cross-check skipped" note rather than blocking.

## Why it is shaped this way

`skills/learn/references/pedagogy.md` gives the reasoning, in three deliberately separated parts: five cited frameworks (Knowles, Chi and Wylie, Sweller, Perkins and Salomon, Deci and Ryan), then this plugin's own **unvalidated** defaults — the session length, one concept per session, the two-week verify floor, the binary gate — and then the failure modes that feel like progress while they are happening. The research motivates the design; it does not endorse the numbers. Every number was picked because it seemed reasonable, which is exactly why the tracks are yours to override.

## Test

```
cd learn && npm test
```

MIT.
