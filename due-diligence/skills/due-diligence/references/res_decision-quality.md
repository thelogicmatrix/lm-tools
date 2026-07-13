# res_decision-quality — The Decision-Quality Bar
> Research-backed reference for the Due Diligence assumptions-risk and alternatives-considered lenses.

## What good looks like (the bar)

- **A premortem was run before commitment.** Before sign-off, the team is told the project "has failed spectacularly" and independently writes down every plausible reason why — surfacing objections people would otherwise suppress for fear of seeming impolitic (Gary Klein, "Performing a Project Premortem," HBR Sept 2007).
- **Prospective hindsight, not generic risk-brainstorming.** Asking "what *did* go wrong" (assuming failure as fact) outperforms asking "what *might* go wrong" — imagining an outcome has already occurred increases correct identification of its causes by ~30% (Mitchell, Russo & Pennington, 1989, cited in Klein 2007).
- **Load-bearing assumptions are named, not buried.** The plan's assumptions are listed explicitly and each is rated for how "load-bearing" (the plan fails if it's wrong) and how vulnerable (likely to fail) it is — not left as implicit background belief (RAND, *Assumption-Based Planning: A Planning Tool for Very Uncertain Times*, Dewar et al., MR-114).
- **Vulnerable load-bearing assumptions get a signpost and a hedge.** Each critical assumption has a monitored "signpost" (an indicator that it's breaking down) and a pre-planned "shaping" or "hedging" action — not a plan that just quietly breaks when reality diverges (RAND MR-114).
- **The recommendation is reframed as "what would have to be true?" (WWHTBT).** Instead of arguing whether a choice is "right" (which muddles logic and data and entrenches both sides), the team decomposes it into the discrete conditions that would have to hold, then agrees in advance what evidence would confirm or kill each one — turning a truth-fight into a joint research plan (Roger Martin, "What Would Have to Be True?", 2022).
- **Real alternatives were weighed, not one option rationalized.** Two or more materially different options are scored against explicit, weighted criteria (a decision/Pugh matrix), not a single preferred option with a token "alternatives considered" paragraph (ASQ Decision Matrix; Lucid/Asana weighted-scoring guides).
- **Estimates use an outside view, not just inside-view judgment.** For cost/schedule/benefit forecasts, a reference class of comparable past projects and its actual outcome distribution is consulted before trusting the plan's own bottom-up number (Kahneman & Tversky, 1979; Flyvbjerg & COWI, 2004; formalized as UK Dept for Transport guidance).
- **Optimism is corrected with an outside-view check at the executive level, not just the analyst level.** Kahneman & Lovallo's "Delusion at the Top" (HBR 2003) documents that executives systematically underestimate timelines and costs and overestimate benefits even when the base rate is known to them individually — the fix is a mandated outside-view step in the approval process, not relying on individual judgment to self-correct.
- **Known bias failure modes are actively checked for**, not assumed absent because the team is smart or well-intentioned (Kahneman, *Thinking, Fast and Slow*).
- **Dissent has an explicit channel.** The premortem's core design insight is that reviewers self-censor reservations unless a structured, low-cost way to voice them is built into the process — a review that only asks "any objections?" in an open meeting will systematically under-elicit them (Klein, 2007).

## Common defects (what to attack)

**Unstated or unexamined assumptions**
- A conclusion depends on an assumption that is never written down anywhere in the document (RAND ABP's whole premise: most planning failures trace to assumptions nobody surfaced).
- An assumption is named but never assessed for how load-bearing it is — treated as equally minor as a footnote when the plan actually collapses if it's false.
- No signpost/trigger defined for a risky assumption — the plan has no way to notice, in-flight, that reality has diverged from the assumption.

**No real alternatives considered**
- Exactly one option is presented, with competitors dismissed in a line or two rather than scored against the same criteria.
- Criteria for comparison are invented post hoc to justify the option already chosen (reverse-engineered scoring, not real MCDA).
- "Do nothing" / status quo is never included as a baseline alternative.

**Ignored failure scenarios**
- No premortem or equivalent was run — the document reads as if success is the only considered outcome.
- Failure modes raised are generic/safe ("market conditions could change") rather than the specific, occasionally-impolitic reasons a premortem is designed to surface (e.g., "the exec sponsor retires and interest evaporates" — an actual example from Klein's HBR piece).
- Optimistic single-point estimates for cost/time/benefit with no distribution, confidence interval, or reference-class check — a signature of the planning fallacy (Kahneman & Tversky).

**Bias tells** (Kahneman's named failure modes — one-line tells for each)
- **Confirmation bias** — evidence and sources cited all point one direction; disconfirming data, if it exists, is absent or dismissed in a clause.
- **Sunk cost fallacy** — the case for continuing leans on cost/effort already spent ("we've already invested X") rather than on the marginal case for the path forward.
- **Anchoring** — a first-mentioned number (initial estimate, competitor's price, prior year's budget) reappears essentially unadjusted as the final figure, with no independent re-derivation.
- **Overconfidence / planning fallacy** — point estimates with no error bars, "best case" used as the default case, and no reference-class or outside-view comparison despite comparable past projects existing.
- **Base-rate neglect** — a vivid anecdote or one comparable case drives the forecast instead of the actual distribution of outcomes across similar past efforts.
- **Availability heuristic** — risks or precedents that are easy to recall (recent, dramatic, personally experienced) get outsized weight over less memorable but more probable ones.

**Process defects (how the decision was made, not just what it says)**
- No structured channel for dissent — objections were only solicited in an open group setting, where research shows they're systematically suppressed (Klein, 2007).
- Decision criteria and their weights were set (or silently adjusted) after the preferred option was already known.
- Time pressure or a single strong advocate substitutes for comparison against alternatives — "we didn't have time to consider other options" as the explicit or implicit rationale.

## Quick-reference checklist

- [ ] A premortem (or written equivalent) was run: "assume this failed — list every reason why," not just "what might go wrong"
- [ ] Every load-bearing assumption is named explicitly, not left implicit
- [ ] Each risky assumption has a stated signpost (how we'd notice it's breaking) and a fallback/hedge
- [ ] The recommendation is stated as "what would have to be true" conditions, with a plan for what evidence would confirm/kill each
- [ ] At least one genuine alternative (including status quo / do-nothing) is scored against the same explicit criteria as the chosen option
- [ ] Scoring criteria were set before/independent of picking a winner, not reverse-engineered to fit it
- [ ] Cost/schedule/benefit estimates are checked against a reference class of comparable past efforts, not inside-view judgment alone
- [ ] Estimates carry a range/confidence level, not a single optimistic point figure
- [ ] Disconfirming evidence is present and engaged with, not omitted (confirmation-bias check)
- [ ] The case for the chosen path rests on forward-looking merit, not on cost/effort already sunk
- [ ] Key numbers are independently re-derived, not anchored on the first figure mentioned
- [ ] Failure scenarios named are specific to this plan, not generic boilerplate risks
- [ ] Objections/dissent had a structured, low-cost channel to surface (not just "any objections?" in a meeting)
- [ ] Vivid/recent precedents aren't substituting for the actual base rate of outcomes across comparable cases

## Sources

- [Gary Klein, "Performing a Project Premortem," HBR Sept 2007](https://hbr.org/2007/09/performing-a-project-premortem) — originates the premortem technique; cites Mitchell/Russo/Pennington (1989) on prospective hindsight's ~30% lift in correctly identifying causes of an outcome; explains why premortems beat generic risk sessions (safe to voice dissent, reduces overinvestment/"damn-the-torpedoes" attitude).
- [RAND, *Assumption-Based Planning: A Planning Tool for Very Uncertain Times*, Dewar, Builder, Hix & Levin, MR-114](https://www.rand.org/content/dam/rand/pubs/monograph_reports/2005/MR114.pdf) — the canonical ABP methodology: surface assumptions, identify which are load-bearing and vulnerable, attach signposts and shaping/hedging actions.
- [Roger Martin, "What Would Have to be True?", 2022](https://rogermartin.medium.com/what-would-have-to-be-true-83dac5bd2189) — WWHTBT reframes "is this true" (which muddles logic + data and entrenches disagreement) into naming the discrete conditions a choice depends on and agreeing in advance what data would test them; also emphasizes using the question to create a future, not just judge the present.
- [Kahneman & Tversky, "Intuitive Prediction: Biases and Corrective Procedures," 1979](https://en.wikipedia.org/wiki/Reference_class_forecasting) (via Reference class forecasting overview) — origin of inside-view vs. outside-view distinction and the recommendation to use distributional data from comparable past cases (reference class forecasting) instead of case-specific judgment alone.
- [Flyvbjerg & COWI (2004), formalized as UK Dept for Transport guidance](https://en.wikipedia.org/wiki/Reference_class_forecasting#Practical_use_in_policy_and_planning) — turned reference class forecasting into a practical planning method; first live application was the Edinburgh Tram Line 2 business case review (2004).
- [PMI, "From Nobel Prize to Project Management: Getting Risks Right"](https://www.pmi.org/learning/library/nobel-project-management-reference-class-forecasting-8068) — practitioner-facing summary connecting Kahneman's Nobel-winning work to project cost/schedule forecasting.
- [ASQ, "What is a Decision Matrix?"](https://asq.org/quality-resources/decision-matrix) — decision/Pugh matrix method: baseline option, weighted criteria, comparative scoring against alternatives rather than a single-option pitch.
- Daniel Kahneman, *Thinking, Fast and Slow* (2011) — standard reference for confirmation bias, anchoring, overconfidence, and System 1/2 framing underlying all four named bias tells above.
- Kahneman & Lovallo, "Delusion at the Top: How Optimism Undermines Executives' Decisions," HBR (July–Aug 2003) — planning fallacy persists at the executive level; the remedy is a mandated outside-view/reference-class step in the approval workflow, not trusting individual debiasing.

**Notable conflicts/notes:** Klein's premortem and RAND's ABP are complementary, not competing — premortem is a single facilitated session surfacing *failure reasons*, ABP is an ongoing planning discipline surfacing and monitoring *assumptions*; a rigorous review wants evidence of both, not either/or. Reference class forecasting requires a genuinely comparable reference class — several sources (Wikipedia's "reference class tennis" discussion) note that if the wrong reference class is chosen, the method still produces a confident but wrong number, so the review should check the class was chosen before deciding, not fitted after.
