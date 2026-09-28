# Writing your own track

A track tells the skill how one kind of subject is studied. Two ship: `code`, for subjects that produce working code, and `concept`, for subjects that do not (marketing, strategy, theory, design, history). You can add your own, or replace a shipped one.

## Where tracks are found

`learn` looks in two places, yours first:

1. `.learn/tracks/<name>.md` under the store root, which is `$LEARN_HUB` when set and otherwise the top of the current git repo
2. the bundled `skills/logical-learning/extensions/tracks/<name>.md` inside the plugin

A file of yours with the same name as a bundled track replaces it. Plugin updates never touch `.learn/`. `learn tracks` lists both kinds and labels each of yours `(yours, overrides bundled)`. The label prints for every track of yours, including one with no bundled twin.

A track name is letters, digits, `_` and `-` only. Any other name exits 2.

## The six headings

The skill reads a track by heading, never by its name, which is what lets it follow a track it has never seen. Every track has these six `##` headings, spelled exactly:

| Heading | What it answers |
|---|---|
| `Pick this when` | which subjects this track is for. The skill reads it before choosing a track and never infers the track from the subject name. |
| `Artifact floor` | the minimum a session must produce to count at all |
| `Session shape` | how the working time divides between reading, applying, building and consolidating |
| `Mastery gate` | what counts as demonstrating the week's concept, since the gate is never self-certified |
| `Verify exercise` | what a "spot the flaw" exercise looks like for this kind of material |
| `Sequencing` | project-first, syllabus-first, or something else |

The text under each heading is free-form. The two shipped tracks use one short paragraph each.

## Writing one

1. Copy `code.md` or `concept.md` from the plugin's `skills/logical-learning/extensions/tracks/` to `.learn/tracks/<name>.md`.
2. Keep the six headings and rewrite the bodies.
3. Run `learn tracks` to see it listed, then `learn start <subject> --track <name>`.

## What is checked

`learn start` checks that all six headings are present, and exits 2 naming any that are missing. Nothing else is validated, and the check runs only at `start`, so a track edited mid-sprint is not re-checked. A track that suits how you actually study beats the two shipped ones, whose numbers are guesses (Part 2 of [pedagogy.md](pedagogy.md)).
