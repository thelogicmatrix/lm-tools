# data-provenance — Does every fact trace to a real, named source?
> Cites: none external — this is a DD-core principle (trace or delete). Pairs with res_technical-writing for passive-hedging tells.

## Fires on
General lens (no tag) — select for any artifact carrying figures, names, dates, quotes, or factual claims, *especially* AI-generated (Step 0 Q1: AI output is presumed unverified until traced). Skip only for an artifact with no facts to trace (e.g. a pure UI mockup with placeholder text). DD's flagship anti-fabrication check.

## Attacks
- Untraceable figure/name/date/quote/claim: stated as fact but no real, named source behind it. **Unverifiable = presumed fabricated.**
- Invented citation: a source named to paper over a gap that doesn't actually say what's claimed (or doesn't exist).
- Guess rounded into fact: an estimate or assumption presented as a measured number with no `estimate`/`unverified` label.
- "Reportedly" hedge: vague attribution ("reportedly", "studies show", "it's said") standing in for a real trace.
- Bulk data unverified: a large dataset presented whole with no sampling check and no verification of the load-bearing figures.

## Measure
Untraced claims ÷ total claims, where a claim is any figure, name, date or quote. Count both.
Report as "n/N untraced". Any untraced load-bearing claim = blocker. Any untraced claim = should-fix.

## Evidence of attack (clean-pass proof)
For each load-bearing fact, name the source it traces to (or flag it). For bulk/large data: verify a sample (≥10% or 20 items, whichever is larger) **plus every load-bearing figure**, flag untraceable items in place (don't bulk-delete real data), and report the verified fraction. "Numbers look right" without a trace is exactly the defect.

## Severity guide
- blocker: a load-bearing figure/claim is fabricated, unverifiable, or backed by an invented citation — it would mislead the reader.
- should-fix: an estimate presented as fact without a label; a "reportedly" hedge on a non-load-bearing claim; sampling below the bar.
- nit: a traceable fact whose citation could be more precise.
