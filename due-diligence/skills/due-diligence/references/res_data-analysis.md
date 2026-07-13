# res_data-analysis — The Analytical-Soundness Bar
> Research-backed reference for the Due Diligence statistical-soundness and cross-artifact-consistency (numbers) lenses.

## What good looks like (the bar)

### Sampling & representativeness
- **Bigger isn't the fix for biased.** Larger samples increase *precision* (law of large numbers, CLT), but "in some situations the increase in precision for larger sample sizes is minimal, or even non-existent" — specifically when there are systematic errors or strong dependence in the data [sample-size]. A huge non-representative sample still produces a confidently wrong number; a smaller properly-drawn one beats it.
- **Sampling bias is a distinct failure mode from sample size**, arising when the selection mechanism itself correlates with the outcome being measured (who responds, who's included, who's excluded) rather than from having "too few" rows [sampling-bias]. A dashboard built on "whoever logged in" or "whoever we could scrape" data inherits this silently.

### Confounding & causal inference
- **Correlation ≠ causation, formally.** A variable Z confounds the X→Y relationship if Z independently predicts Y, is associated with X, and is not on the causal pathway between them — not controlling for Z "introduces a spurious relationship between X and Y" [confounding]. Any claim of the form "we did X and Y went up" needs this checked before it's accepted.
- **Standard controls**: randomization (breaks the X–Z association by design), matching/stratification on Z, regression adjustment, and natural experiments. In causal-graph terms, adjusting means blocking every open "backdoor path" between X and Y [confounding].
- **Difference-in-differences (DiD)** isolates a treatment effect from confounds by comparing the *change* in treatment vs. control groups, not their levels — canceling out anything constant within each group over time. It requires the **parallel trends assumption**: absent treatment, both groups' trends would have moved together: DiD is "often combined with matching" on pre-treatment covariates specifically to make this assumption more plausible [did]. A campaign-impact analysis that reports a raw before/after delta with no control group, or a control group not shown to be trending in parallel pre-campaign, hasn't earned a causal claim.

### Effect size vs. statistical significance
- These answer different questions: significance (p-value) asks "how surprising is this under the null," effect size asks "how big is it." The ASA warns against "accepting the alternative hypothesis for any p-value nominally less than 0.05 without other supporting evidence" — context like study design, measurement quality, external evidence, and assumption validity all matter, and a p-value is not the probability the null is true [pvalue-misuse]. A large enough sample makes trivially small effects "significant"; a soundness review must ask for the effect size and its practical/business magnitude, not just the p-value or "statistically significant" badge [effect-size].

### Data integrity
- **Totals must reconcile.** Recognized data-quality dimensions include completeness, accuracy, consistency, and validity [data-quality] — a pipeline stage that silently drops or double-counts rows breaks completeness/consistency even if every individual number "looks" plausible. Row counts and control totals should be checked at every join/filter/aggregation boundary, not just at the final output.
- **Outliers are handled, not deleted.** "Outliers are expected for large sample sizes and should not automatically be discarded" — the right response is a method robust to outliers (or investigating/correcting a genuine data error), while "removing a data point solely because it is an outlier... typically invalidates statistical results" and is "controversial" even when a mathematical rejection rule is used [outlier-handling]. Silent trimming of "weird" values before an analysis is a red flag, not a data-cleaning virtue.

### Data quality (the raw-data health beneath the analysis)
The recognized dimensions [data-quality], operationalised as checks on the data *before* any inference:
- **Completeness** — required fields not null/missing; no rows silently dropped at a join or filter.
- **Validity** — values conform to type/format/domain: dates parse, enums in range, one consistent unit, no "N/A"/sentinel values masquerading as data.
- **Consistency** — no contradictory duplicates; referential integrity across tables; one canonical format/unit for the same quantity (the ISO vs dd-mm-yyyy date-format split that broke a dedupe is the archetype).
- **Uniqueness** — deduplicated; no double-counting from a fan-out join.
- **Accuracy** — spot-checked against the source of truth, not assumed.
- **Timeliness** — data fresh enough for the decision; a stale snapshot not presented as current.

## Common defects (what to attack)
- **Sampling bias** — tell: self-selected/opt-in respondents, "whoever we could scrape," non-response bias, presented as representative just because n is large [sampling-bias].
- **False causation** — tell: correlation reported with causal verbs ("X drove Y," "caused a lift") with no confounder check and no control group [confounding].
- **No matched control or DiD baseline** — tell: a before/after delta with no counterfactual, or treatment-vs-control where pre-period trends were never shown to be parallel [did].
- **P-hacking / data dredging** — tell: the hypothesis was formed by looking at the same data used to "confirm" it; "every data set contains some patterns due entirely to chance" if not tested against held-out data [data-dredging].
- **Optional stopping** — tell: data collection stopped as soon as the result crossed a significance threshold, rather than at a pre-set sample size [data-dredging].
- **Cherry-picking** — tell: the best week/segment/cohort is showcased while the full-period or full-population number is materially different or simply absent from the report.
- **Survivorship bias** — tell: only entities that "made it" (retained users, still-active accounts) are analyzed, with excluded failures/churned cases silently dropped from the denominator; the canonical case is Abraham Wald's WWII finding that armor belonged where returning aircraft had *no* damage, since planes hit in the missing spots never made it back to be counted [survivorship-bias].
- **Simpson's paradox** — tell: an aggregate trend reverses the trend in every subgroup because subgroup sizes are unevenly weighted by a lurking variable; a real kidney-stone study found Treatment A beat Treatment B on both small stones and large stones individually, yet B "won" overall because doctors preferentially gave A to the harder (large-stone) cases [simpsons-paradox]. Any topline metric split unevenly across a segment (region, cohort, plan tier) needs a subgroup check before the aggregate is trusted.
- **Base-rate neglect** — tell: a test's accuracy/precision is quoted without the underlying prevalence; the same detection rate yields wildly different real-world precision depending on how rare the target condition is (the "false positive paradox") [base-rate-fallacy].
- **Significance without effect size** — tell: "statistically significant" reported with no effect size, confidence interval, or business-magnitude translation, inviting a trivial effect to be read as a meaningful win or vice versa [pvalue-misuse] [effect-size].
- **Dropped/mismatched rows** — tell: row counts don't reconcile across pipeline stages or between the dashboard and its source query; a join silently drops unmatched rows; a summary total doesn't equal the sum of its own detail rows.
- **Outlier deletion presented as cleaning** — tell: extreme values removed with no documented cause, especially if the removal is what flips the conclusion [outlier-handling].

## Quick-reference checklist
- [ ] Sample size AND selection mechanism both justified — precision (n) and representativeness (how selected) are checked separately
- [ ] Any causal claim has a stated confounder-control method (randomization, matching, regression adjustment, DiD) — or is downgraded to correlational language
- [ ] If a before/after or treatment/control comparison drives a headline number, the counterfactual/parallel-trends assumption is stated and checked
- [ ] Hypothesis was tested on data independent of the data that generated it (no visible p-hacking/data-dredging pattern: optional stopping, post-hoc subgroup fishing)
- [ ] No cherry-picked window/segment presented without the full-population/full-period number alongside it
- [ ] Cohort/dashboard scope is checked for survivorship filtering (are churned/failed/excluded cases accounted for?)
- [ ] Any aggregate metric spanning uneven subgroups is also checked at the subgroup level for a Simpson's-paradox reversal
- [ ] Detection/accuracy claims are paired with the relevant base rate, not quoted in isolation
- [ ] Effect size (and ideally a CI) is reported alongside any p-value or "significant" claim
- [ ] Row/record counts reconcile across every pipeline stage, join, and filter — no silently dropped or duplicated rows
- [ ] Totals in summaries/dashboards equal the sum of the underlying detail rows
- [ ] Outliers are investigated (robust method or documented correction), not silently deleted, especially if removal changes the conclusion

## Sources
- [Wikipedia — Sample size determination](https://en.wikipedia.org/wiki/Sample_size_determination) — precision vs. sample size, and why bigger n doesn't rescue systematic bias
- [Wikipedia — Sampling bias](https://en.wikipedia.org/wiki/Sampling_bias) — selection-mechanism bias as distinct from sample-size problems
- [Wikipedia — Confounding](https://en.wikipedia.org/wiki/Confounding) — formal confounder definition, backdoor-path/adjustment-set framing, control methods
- [Wikipedia — Difference in differences](https://en.wikipedia.org/wiki/Difference_in_differences) — DiD mechanics, the parallel-trends assumption, pairing with matching
- [Wikipedia — P-value, "Misuse"](https://en.wikipedia.org/wiki/P-value) — ASA-sourced guidance on p-value misinterpretation and the p<0.05 accept/reject trap
- [Wikipedia — Effect size](https://en.wikipedia.org/wiki/Effect_size) — effect size as the "how big" complement to significance's "how surprising"
- [Wikipedia — Data quality](https://en.wikipedia.org/wiki/Data_quality) — recognized data-quality dimensions (completeness, accuracy, consistency, validity) underlying reconciliation checks
- [Wikipedia — Outlier, "Working with outliers"](https://en.wikipedia.org/wiki/Outlier) — why blanket outlier deletion is controversial and invalidates results; robust methods as the alternative
- [Wikipedia — Data dredging](https://en.wikipedia.org/wiki/Data_dredging) — p-hacking mechanics: testing a hypothesis on the same data that generated it is meaningless
- [Wikipedia — Survivorship bias](https://en.wikipedia.org/wiki/Survivorship_bias) — Abraham Wald's WWII aircraft-armor case as the canonical example
- [Wikipedia — Simpson's paradox](https://en.wikipedia.org/wiki/Simpson%27s_paradox) — the real kidney-stone-treatment dataset showing aggregate reversal from uneven subgroup weighting
- [Wikipedia — Base rate fallacy](https://en.wikipedia.org/wiki/Base_rate_fallacy) — the false-positive paradox from ignoring prevalence
