# assumptions-risk — Are the load-bearing assumptions named, tested, and monitored?
> Cites: res_decision-quality.md

## Fires on
Tags: proposal, plan, recommendation. Any artifact whose conclusion depends on facts about the future or about users/systems not yet verified.

## Attacks
- Unstated assumption: a conclusion depends on an assumption never written down anywhere in the document (RAND ABP's whole premise).
- Unassessed assumption: an assumption is named but never rated for how load-bearing (plan fails if false) or how vulnerable (likely to fail) it is.
- No signpost: a risky assumption has no defined trigger/indicator for noticing in-flight that reality has diverged from it.
- No premortem: the document reads as if success is the only considered outcome — no "assume this failed, list every reason why" pass, only generic "what might go wrong."
- Generic-only failure scenarios: failure modes raised are safe/boilerplate ("market conditions could change") rather than specific and occasionally impolitic (e.g. "the exec sponsor retires and interest evaporates").
- Optimistic single-point estimates: cost/time/benefit given as one number with no range, confidence interval, or reference-class check (planning fallacy signature).
- No structured dissent channel: objections were only solicited via an open "any objections?" ask, where research shows they're systematically suppressed.
- Confirmation bias: cited evidence/sources all point one direction; disconfirming data is absent or dismissed in a clause.
- Sunk-cost fallacy: the case for continuing leans on cost/effort already spent rather than the marginal case for the path forward.
- Anchoring: a first-mentioned number (initial estimate, competitor's price, prior year's budget) reappears essentially unadjusted with no independent re-derivation.
- Overconfidence / planning fallacy: point estimates with no error bars, "best case" used as the default case, no reference-class or outside-view comparison despite comparable past efforts existing.
- Base-rate neglect: a vivid anecdote or single comparable case drives the forecast instead of the actual distribution of outcomes across similar past efforts.
- Availability heuristic: risks or precedents that are easy to recall (recent, dramatic, personally experienced) get outsized weight over less memorable but more probable ones.

## Evidence of attack (clean-pass proof)
List every load-bearing assumption found (or state none exist and why that's plausible), and for each: what would falsify it, whether a signpost/hedge is defined, and whether it was actually load-bearing-rated vs. just mentioned. Name whether a premortem-style pass happened (not just a risks section) and quote one specific, non-generic failure reason if present. State whether estimates carry a range/reference-class or are bare single points. For each named bias, say what was checked (e.g. "cited sources: 4, all pro-adoption, no disconfirming case surfaced" = confirmation bias present) — "no bias found" without naming what was searched for is not evidence.

## Severity guide
- blocker: a false load-bearing assumption sinks the plan, or no premortem/failure-scenario pass exists at all for a consequential decision.
- should-fix: an assumption is named but unrated, has no signpost, or a bias tell is present but doesn't change the recommendation's viability.
- nit: wording — assumptions could be stated more precisely but the substance is already there.
