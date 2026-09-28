# Reading a sync report

`sync` reports and never rewrites. Every flag line is `TOKEN <slug or page>: <why>`, one
line each:

- `NARRATIVE-UNWRITTEN`, the page is still the skeleton.
- `UNVERIFIED`, the header carries no usable `last verified` date, or the status has moved
  on past it. No verb clears this one: the stamp moves only when a human re-reads the
  narrative and edits the date by hand. On a skeleton page it is downstream of
  `NARRATIVE-UNWRITTEN`, so it stands until the narrative is written.
- `NO-PAGE`, the row has no page, or points at one that is not on disk. `NO-ROW`, a page
  has no row.
- `NO-CURRENT-STATE`, the page has no dated Current state heading.
- `DOUBLE-HEADING`, the page carries more than one Current state heading.
- `STALE`, the status is behind the repo's last commit. Only rows with a `repo` can fire it.
- `MISSING-REPO`, the row's repo path is not on disk.
- `MALFORMED`, `sync` has no block it can use on that page and refuses to guess. This one
  exits 1. Open the page and fix it by hand.

Act on each flag with the verb the SKILL table names. Concept-level truth (is the narrative
still what the project is) is the user's call, so ask before rewriting a narrative.
