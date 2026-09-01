# projects — the portfolio layer for Claude Code

You have more going on than fits in one head: eight repos, three of them paused, one you
have not opened in five weeks. `projects` gives that a single readable home — a generated
`INDEX.md` of everything active, and one narrative page per project you actually write
prose into.

**The differentiator is the drift check.** Most portfolio/status skills are pure prose:
"read this file, update that table." Tables maintained by a model rot, quietly, because
nothing ever compares them to the world. Here a CLI owns every mechanical field, the index
is *rendered* from a JSON store on every mutation, a write-guard hook denies hand-edits to
both, and `projects sync` compares each row against reality — a page still holding its
skeleton, a status older than the repo's last commit, a checkout that no longer exists —
and reports without rewriting anything.

The narrative stays yours. The bookkeeping is never yours again.

## Install

```
/plugin marketplace add thelogicmatrix/lm-tools
/plugin install projects@lm-tools
```

Node 18+. No dependencies, no second runtime.

## Use

Say "projects", "project status" or "portfolio" and the skill fires. Everything below is
also a plain CLI you can run yourself:

```
projects                     list every project grouped by theme, with its page's opening line
projects <theme>             list one theme: work | job-search | tooling | homelab | worldbuilding | personal
projects register <slug> --theme T [--name N --status S --where W --repo R]
projects current <slug>      replace that page's Current state from stdin
projects status <slug> <s>   active | paused | ops | done
projects sync                check every row against reality
projects log [slug]          what happened, read from git
projects rename <old> <new>  change a slug, moving its page with it
projects archive <slug>      move the page to archive/ and drop the row
projects render              re-render INDEX.md from the store
```

Storage lives in `docs/projects/` inside the current git repo. Set `PROJECTS_ROOT` to keep
one portfolio for many repos.

Statuses are deliberately four: `active`, `paused`, `ops` (running, not being worked on),
`done`. Anything finer becomes a taxonomy you maintain instead of work you do.

Themes are deliberately six: `work`, `job-search`, `tooling`, `homelab`, `worldbuilding`,
`personal`. Every row has one, `register` refuses without it, and the only thing a theme
decides is which section of the index and of the list a project appears under.

## Why `sync` reports and never fixes

Every flag is `TOKEN <slug>: <why>` — `NARRATIVE-UNWRITTEN`, `UNVERIFIED`, `NO-PAGE`,
`NO-ROW`, `STALE`, `MISSING-REPO`, `MALFORMED`. A contradiction between a page and reality
is a judgement call: the page may be aspirational, or the repo may be a stale branch. A
tool that guessed would silently overwrite the one thing here a human wrote.

`repo` is what buys `STALE` and `MISSING-REPO`. Leave it blank on docs-only projects —
pointing one at a repo that commits many times a day for unrelated reasons makes `STALE`
noise wearing the costume of a signal.

## The write-guard

The bundled `PreToolUse` hook denies `Write`/`Edit` on `INDEX.md`, on the per-project record
files under `docs/projects/entries/`, and on the packed `docs/projects/_projects.json` they
replaced, and names the verb to use instead. It is not paranoia: the index is regenerated on
every mutating verb, so a hand-edit is not merely discouraged, it is *lost* at the next write.

## The store is one file per project

`docs/projects/entries/<slug>.json` holds one project each. A packed array made every write
rewrite the whole file, so two machines editing unrelated projects still collided on the same
bytes, and a JSON array conflict has no semantic merge. One file per project makes unrelated
edits disjoint, and a same-project fork conflicts on one small file, which is correct.

`docs/projects/_projects.json` is the packed array it replaced. It is still READ when the
directory is absent, so the first run on an unsharded tree migrates itself (backing the packed
file up to `_projects.json.pre-shard` first) and a rollback to an older plugin still finds its
data. Deleting it is a later, separate step.

`INDEX.md` is still rendered and committed, because it is what makes the list readable on
Forgejo and what `gtg`'s `inferParent` reads to resolve project families. It rewrites wholesale
on every operation, so it stays a conflict point: **on a conflict take either side and run any
`projects` command**, which regenerates it from the store. A rendered file has no meaningful
merge, so the conflict is noise and regeneration is the fix.

Pin the record files as-is in `.gitattributes` alongside the index:

```
docs/projects/INDEX.md -merge
docs/projects/entries/*.json -text
```

The `-text` line is correctness, not tidiness. A write is skipped when the file's bytes
already equal the record's serialisation, so under a `text=auto` rule every record reads as
changed after a fresh clone on Windows and every command rewrites the whole store.

## Pairs with

[`gtg`](../gtg) — the session layer below this one. A gtg wrap distils its handoff into
`projects current <slug>`; resuming flips the status back to `active`. Either works alone.

## Test

```
cd projects && npm test
```

MIT.
