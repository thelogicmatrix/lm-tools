# operational-completeness — Does it actually work, fully, on real inputs?
> Cites: none single external — DD-core; draws on res_data-analysis (reconciliation) and res_code-quality (edge/error paths) where relevant.

## Fires on
General lens (no tag) — select for anything that *runs* or *processes*: code, a pipeline, a dataset, an analysis, a tool. Skip for static prose with nothing to execute (a plain blurb). The lens that catches the bug before the boss does.

## Attacks
- Internal inconsistency: counts/lists/totals that don't match each other or the source (a summary total ≠ sum of its detail rows).
- Incomplete processing: silently dropped records, truncated data, or missing context — processes *part* of the input while looking like it did all of it (the PostgREST 1000-row cap, a join dropping unmatched rows).
- Wrong on real inputs: correct on the toy case but not on the actual data.
- Unhandled edge cases: empty, zero, max, missing/duplicate input, and failure paths not handled.
- No "so what": produces output but doesn't answer the reader's "what do I do with this."
- Clean-looking output from broken processing: the result *looks* fine but was built from incomplete or wrong steps — the highest-value catch.

## Evidence of attack (clean-pass proof)
Confirm internal totals reconcile; confirm the whole input is processed (row counts match end to end, nothing silently dropped/truncated); exercise the edge cases (empty/zero/max/missing/dup/failure) or name the unhandled one; confirm it answers the reader's "so what." A clean-looking output is not evidence — trace the processing.

## Severity guide
- blocker: wrong result, lost/dropped data, silent truncation, or an unhandled edge case that produces a bad output on real input.
- should-fix: an edge case unhandled that real use will hit but that doesn't corrupt the main result; a missing "so what."
- nit: a defensive check that would be nice but isn't load-bearing.
