# Page shape, `current`, and `repo`

Read on `register` or `set`. Nothing here is needed to list, log or change a status.

## The skeleton `register` writes

`register` writes this for a new project, and adopts an existing page rather than
overwriting it. The `*last verified ...*` stamp and the `## Current state` heading must
each start at the beginning of their line:

```markdown
# <Name>
*last verified never · docs: none*

<!-- projects:narrative-unwritten -->

## Current state (YYYY-MM-DD)
<!-- projects:current-state:start -->
Registered YYYY-MM-DD. No status written yet.
<!-- projects:current-state:end -->

## Future Directions

## Docs map
```

Replace the `narrative-unwritten` marker with the narrative. `sync` flags the page while
that marker is still there.

The header does not carry the status. `status` writes the store and never the page, so a
status on the page would be the registration status forever. The list row and `INDEX.md`
are where the status is read.

## What `current` does to the page

`current` reads the body from stdin and replaces everything between the start and end
markers, absorbing the `## Current state` heading above them, which is why status can
never accumulate into a log again. A page with no markers at all gets the block inserted
above `## Future Directions` when that heading is preceded by a newline, and appended at
the end of the page otherwise. On a page whose markers it cannot bound it throws and writes
nothing, deliberately, rather than cutting into the narrative. Fix that page by hand.

## The `last verified` stamp

Read from the page header only (the text above the first `## ` heading and above the start
marker), and only from the **first** line-initial `*last verified ...*` line in it. An
indented stamp is not read, so a real date four spaces in reports as unverified, and a date
in prose below the stamp is not read either. `register` writes `last verified never` and no
verb ever writes a real date there, so the stamp moves only when a human has re-read the
narrative.

## What `repo` buys, and when to leave it blank

`repo` lets `sync` check a project against reality rather than against itself: `STALE`
compares the stated state to that repo's last commit, `MISSING-REPO` fires when the path is
gone. A row with no `repo` is invisible to both.

Set it on every project with its own checkout: `projects set <slug> --repo <path>`. Leave it
blank on a docs-only, Notion-only or home-checkout project. Pointing such a row at the home
repo would compare it against a repo that commits many times a day for unrelated reasons, so
`STALE` could never fire and the check would be noise wearing the costume of a signal.
