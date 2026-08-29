# cross-artifact-consistency — Do the numbers and claims agree across every file that repeats them?
> Cites: res_data-analysis.md (numeric-consistency attacks) + res_technical-writing.md (unlabeled-baseline attack).
> Synthesis note: the doc-vs-code attacks below (README/docs vs code, spec-vs-implementation drift, changelog-vs-shipped, unresolved cross-reference) are NOT drawn from a res_ file — no research base for doc↔code drift exists yet. They are a reasoned extension for this lens's multi-file purpose; add `res_doc-code-consistency.md` later to ground them.

## Fires on
Tags: multi-file, doc-describes-code. Any artifact set where a summary/report/doc restates a number or behavior that also lives in a source table, chart, spec, or codebase.

## Attacks
- Numbers in a summary don't match the source table/chart it's drawn from — a total, percentage, or count diverges from the detail rows behind it (data-quality: consistency dimension, same failure as a summary total not equaling the sum of its own rows).
- README/docs describe behavior the code doesn't actually have — a documented flag, endpoint, or default that the implementation doesn't implement or implements differently.
- Spec vs. implementation drift — the design doc's stated approach (e.g. "uses a matched control group") doesn't match what the code/pipeline actually does (e.g. raw before/after with no control).
- Changelog vs. what shipped — a changelog/release note claims a fix or feature that isn't present in the diff or running code.
- A cross-reference that doesn't resolve — a link, file path, section anchor, or "see Table 3" pointer that points at nothing or at the wrong target.
- A number restated with a different unit, date range, or baseline than its source, changing its meaning without changing its label (technical-writing's unlabeled-units/missing-baseline defect, cross-file version).

## Measure
Mismatches found between artifacts that describe the same thing (name, count, path, version,
behavior). Report the count and list each. A mismatch a reader would act on wrongly = blocker.
Any other = should-fix. Tolerance for a shipped set is 0.

## Evidence of attack (clean-pass proof)
For each cross-claim (a number, a described behavior, a changelog line), name the source location and the restating location, and state that the two were read side by side and reconciled — not "consistent," but "summary says X in file A line N, source table shows X in file B line M, same unit/period/baseline." For doc-vs-code claims, name the specific code path checked and what it actually does. A cross-reference is only cleared if it was followed and resolved to real content.

## Severity guide
- blocker: a load-bearing number (one a reader would act on) or a documented behavior is wrong once checked against its source — the reader would be misled or the code would misbehave as described.
- should-fix: a stale doc or drifted spec that doesn't yet mislead on a load-bearing point but will confuse the next reader or maintainer.
- nit: typo-level mismatch — a rounding difference, a broken anchor to an otherwise-findable section, a cosmetic label inconsistency.
