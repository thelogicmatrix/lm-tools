# data-quality — Is the underlying data healthy enough to trust?
> Cites: res_data-analysis.md (Data integrity + Data quality dimensions)

## Fires on
Tags: data-analysis, data-export. Any artifact whose output depends on a dataset. Checks the raw-data health *beneath* the analysis — distinct from statistical-soundness (which checks whether the *inference* is valid); bad data invalidates a perfect method.

## Attacks
- Completeness: missing/null values in required fields; rows silently dropped at a join or filter; counts that don't reconcile stage-to-stage.
- Validity: values that don't conform to type/format/domain — dates that don't parse, enums out of range, sentinel values ("N/A", -1, 9999) treated as real data, inconsistent units.
- Consistency: contradictory duplicates; broken referential integrity across tables; the same quantity in two formats/units (the ISO vs dd-mm-yyyy date split that broke a dedupe is the archetype).
- Uniqueness: un-deduplicated rows; double-counting from a fan-out join.
- Accuracy: values never spot-checked against the source of truth.
- Timeliness: a stale snapshot presented as current; data too old for the decision.

## Evidence of attack (clean-pass proof)
State the dataset's shape (row count, key fields) and the checks run: null/missing rates on required fields, whether counts reconcile across stages, format/unit consistency, dedup status, and freshness. Spot-check a sample against source. Name issues found or confirm each dimension with the numbers, not "data looks clean."

## Severity guide
- blocker: a data-quality failure that changes the result — dropped/double-counted rows feeding a headline number, a format split corrupting a dedupe, stale data sold as current.
- should-fix: missing values or dupes present but not (yet) shown to flip a conclusion; unverified freshness/accuracy on load-bearing fields.
- nit: minor validity noise in non-load-bearing columns.
