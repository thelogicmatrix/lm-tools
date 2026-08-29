# Phase 7 — research corpus → review lens pack

Read this only when phases 1–6 are done and the corpus produced durable principles worth turning
into permanent review capability.

Written against the [`due-diligence`](https://github.com/thelogicmatrix/lm-tools) plugin's lens
format. If you use a different review framework, the mapping still holds — only the file shapes change.

## The mapping is direct

| Research artifact | Review artifact |
|---|---|
| A core thesis with primary sources behind it | `res_<domain>.md` — the knowledge pack |
| The "common defects" implied by that thesis | the lens's `## Attacks` section |
| An applicable principle | one bullet in `## What good looks like (the bar)` |
| The corpus's own worked failure cases | the severity examples |

## When to do it — and when not to

**Do it** when the research produced a *failure surface* nothing existing covers: a way work goes
wrong that no current lens would catch.

**Don't** when it only produced better vocabulary for something a lens already attacks. Extend that
lens's `res_` file instead. This single call is what stops a lens library from bloating into
overlapping near-duplicates, and it is the least mechanical step in the pipeline — spend the
judgment here.

## Steps

1. **Check overlap first.** List every candidate lens against the shipped roster and name, for
   each, the lens it would otherwise duplicate and why it doesn't. Anything you can't defend gets
   folded into an existing lens rather than added. On the reference run this cut the candidate list
   roughly in half.

2. **Write the `res_` file first.** Shape:
   - `# res_<name> — The <X> Bar`
   - a one-line scope statement saying explicitly what it is *distinct from*
   - `## What good looks like (the bar)` — with bracketed source attributions
   - `## Common defects (what to attack)`
   - `## Quick-reference checklist`
   - `## Sources` — real links, one line of description each

   **Draw the attacks from the sources, don't invent them.** That's the whole point of grounding.

3. **Write the lens against it.** Shape:
   - `# <name> — <the question it asks>`
   - `> Cites: res_<name>.md`
   - `## Fires on` (tags + prose)
   - `## Attacks` (grouped A–F)
   - `## Measure` (optional). The number the lens can count and the thresholds that make it should-fix or blocker. Omit when nothing is countable.
   - `## Evidence of attack`
   - `## Severity guide` (blocker / should-fix / nit)

4. **Wire the tag rows** in the review skill's `SKILL.md`. Add to existing rows rather than
   inventing tags — the tag set is closed and the selection step emits from it.

5. **Update the counts.** Lens and `res_` totals appear in several READMEs and in
   `marketplace.json`. They drift: **recount from the filesystem** rather than trusting the last
   number, and bump the plugin version.

6. **Verify cites resolve** — grep only the `^> Cites:` line, never the file body. Prose
   legitimately mentions `res_` files that don't exist yet as future work, so a body-wide grep
   produces false positives.

## Where it lands

Generic lenses go upstream into the plugin on a feature branch — public, so no personal or work
references. Anything specific to your own stack goes in `.dd/lenses/` in the repo it applies to,
which plugin updates never touch. A `.dd/` lens whose filename matches a shipped one overrides it.

## Reference run

The Interface Studies corpus (33 videos, 11.7h, 94k words) produced four `res_` files and five
lenses — interface-state-coverage, inference-legibility, absent-user-handoff, attention-cost,
agency-preservation — taking that library from 39 to 44 lenses. Roughly one session on top of the
research itself.
