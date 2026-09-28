# Renaming a slug

`projects rename <old> <new>` is the only sanctioned way. It moves the page with the slug so
the two stay in step, and it refuses rather than guessing in the three cases that would lose
something: an unknown source, a target already registered, and a target whose page file
already exists on disk under another row's narrative.

Two things it deliberately does not do. It never bumps `Last touched`, because a rename is
bookkeeping and not work, and bumping it would restart the staleness window `sync` measures.
And it leaves a page whose basename had already diverged from its slug exactly where it is,
on the grounds that a page named differently was named that way on purpose.

**gtg keeps its own slug for the same project, and the two can disagree.** Renaming here does
not rename there. Run `gtg rename <old> <new>` as well when the point is to make them match.

One reference points the other way: a gtg entry names the family it belongs to by a
**portfolio** slug, in its own `parent` field. A rename here can dangle that reference in a
store this CLI does not own, and the cost is quiet: an unresolved parent merely lists that
project as standalone. `rename` therefore reads gtg's two stores, never writes them, and
prints a `NOTE:` naming every entry still pointing at the old slug together with the
`gtg rename` command that re-points them. Relay that note. It is the one part of a rename
left undone.
