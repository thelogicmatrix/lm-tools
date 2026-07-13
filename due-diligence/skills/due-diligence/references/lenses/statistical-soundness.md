# statistical-soundness — Does the analysis actually support its conclusion?
> Cites: res_data-analysis.md

## Fires on
Tags: data-analysis. Any artifact that draws a conclusion from data — a report, dashboard, metric, or claim of impact/lift/correlation.

## Attacks
- Sampling bias: self-selected/opt-in respondents, "whoever we could scrape/log," non-response bias — presented as representative just because n is large (bigger n fixes precision, not a biased selection mechanism).
- False causation: correlation reported with causal verbs ("X drove Y," "caused a lift") with no confounder-control method (randomization, matching, regression adjustment, DiD) named.
- No matched control or DiD baseline: a before/after delta with no counterfactual, or a treatment-vs-control comparison where pre-period trends were never shown to be parallel.
- P-hacking / data dredging: the hypothesis was formed by eyeballing the same data used to "confirm" it, or data collection stopped as soon as a threshold was crossed (optional stopping).
- Cherry-picking: the best week/segment/cohort is showcased while the full-period or full-population number is materially different or simply absent.
- Survivorship bias: only entities that "made it" (retained users, still-active accounts) are analyzed, with churned/excluded cases silently dropped from the denominator.
- Simpson's paradox: an aggregate trend reverses the trend in every subgroup because subgroup sizes are unevenly weighted by a lurking variable (e.g. region, cohort, plan tier).
- Base-rate neglect: a detection/accuracy rate quoted without the underlying prevalence it depends on.
- Significance without effect size: "statistically significant" reported with no effect size, confidence interval, or business-magnitude translation.
- Outliers deleted rather than handled: extreme values silently removed with no documented cause, especially if removal is what flips the conclusion.
- Dropped/mismatched rows: row counts don't reconcile across pipeline stages, a join silently drops unmatched rows, or a summary total doesn't equal the sum of its own detail rows.

## Evidence of attack (clean-pass proof)
Name the sample (source, size, selection mechanism) and state it was checked separately from precision; name the control/counterfactual (randomization, matching, DiD with parallel-trends check, or "correlational only" downgrade) for any causal claim; confirm row counts reconcile at each join/filter/aggregation boundary named; confirm outliers were investigated (robust method or documented cause) rather than silently dropped, and state whether removing them would flip the conclusion. "The numbers look right" is not evidence — "n=X drawn from Y, checked against Z control, row counts reconcile A→B→C" is.

## Severity guide
- blocker: the conclusion is unsupported or false once the bias/confound/dropped-rows issue is accounted for — the headline would change or reverse.
- should-fix: the method is weak (no stated control, no effect size, sample selection unexamined) but the direction of the conclusion likely survives scrutiny.
- nit: presentation only — e.g. effect size omitted but easily inferred, or a caveat that should be stated more prominently.
