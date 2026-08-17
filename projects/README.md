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

The bundled `PreToolUse` hook denies `Write`/`Edit` on `INDEX.md` and `_projects.json` and
names the verb to use instead. It is not paranoia: the index is regenerated on every
mutating verb, so a hand-edit is not merely discouraged, it is *lost* at the next write.

## Pairs with

[`gtg`](../gtg) — the session layer below this one. A gtg wrap distils its handoff into
`projects current <slug>`; resuming flips the status back to `active`. Either works alone.

## Test

```
cd projects && npm test
```

MIT.
