# CLI details

What the `learn` verbs do beyond their one-line help. For running a session, see [running-a-session.md](running-a-session.md).

## Choosing a sprint

`week`, `gate`, `page` and `brief` act on the one sprint in the store. With more than one they refuse rather than guess, and take `--sprint <slug>`.

## `learn brief` flags

| Flag | Values | Default |
|---|---|---|
| `--for` | `week`, `curriculum` | `week` |
| `--shape` | `synthesis`, `synthesis+notes`, `synthesis+notes+raw` | `synthesis+notes` |
| `--research-root` | a folder | `docs/research` |
| `--tier` | `scan`, `pack` | none, logical-research picks |

`--for week` writes `docs/learning/<slug>/corpus-brief-week-<N>.md`, one per week. `--for curriculum` writes `docs/learning/<slug>/corpus-brief-curriculum.md` for the cross-check.

## No overwrites

`page` and `brief` refuse to overwrite a file that already exists, so a hand-edited one is never clobbered by a re-run.

## Commits

`start`, `gate`, `page` and `brief` commit what they wrote, naming only their own paths, so a store in a checkout shared with other work is never left dirty.

The commit is skipped when the store root is not itself a git top level: an untracked `LEARN_HUB`, or one that merely sits inside somebody else's repo, because nothing there asked for the sprint.

If the commit itself fails, the write still stands on disk, nothing is left staged, and the verb exits 1 naming git's own reason. The commonest cause is a repo that gitignores `docs/`, so the week page can never be added.

## Upgrading from 0.3.x

The corpus brief is now written per week and per target, not once per sprint. The weekly pass writes `corpus-brief-week-<N>.md` and the cross-check writes `corpus-brief-curriculum.md`. An existing `corpus-brief.md` is inert, and nothing reads it. Rename it to `corpus-brief-week-1.md` to keep it in play, or delete it.
