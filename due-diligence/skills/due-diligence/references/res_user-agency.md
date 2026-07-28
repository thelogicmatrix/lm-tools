# res_user-agency — The Agency-Preservation Bar
> Research-backed reference for the Due Diligence agency-preservation lens. Whether the user can still see into, audit, override and act on the system — or has been reduced to an operator of something they cannot inspect. Distinct from res_accessibility (can they perceive and operate it) and actionability (does it drive a decision); this is about whether the *capability to act competently* survives the design.

## The core claim

Simplification is not free. Every interface that hides complexity makes a trade, and the thing most often traded away is the user's ability to understand and correct what the system is doing. The trade is frequently worth making — but it is a **choice**, and a design that presents it as an inevitability has hidden its most consequential decision.

The general form: **whenever an interface promises to make something clear, or to let you work "in the simplest way possible", that promise is the thing to interrogate.** Ease of use is not neutrality. The gap between a model of a function and the function itself is, in some cases, a degree of freedom — and in others, a paralysing incapacity to act.

Two distinct failure modes follow, and they compound:

- **Opacity** — the user cannot see how a result was produced, so they cannot tell a right answer from a wrong one, and cannot fix either.
- **Passivity** — the interface is designed so that the user is not expected to ask *why* or *what if*, and over time stops doing so. A summary that answers "is it fine?" and nothing else is a stop-thinking signal.

The long-run cost is **deskilling**: expertise becoming unfamiliar even to the professionals who once had it, because the arrangement no longer requires it. This is well documented in workplaces where an easy-to-use control layer replaced an understanding of the underlying process — the interface was genuinely usable, and its relation to the process it managed was too shallow to support judgement.

## The reference case: why the spreadsheet persists

The spreadsheet is the clearest demonstration of what agency-preserving design buys, and it is instructive precisely because it is *dangerous*.

Its four properties:

- **Collocated data and logic (the glass box).** Everywhere else, logic and data are separated — logic in source files or on a server, data in memory or a database, and the user sees the *what* but never the *how*. The spreadsheet puts a value or an executable formula in every cell, and the formula bar is the window into it. **If a number looks wrong, the user can audit, trace and correct rather than file a request.**
- **Direct manipulation.** Continuous representation of the object of interest, physical action rather than syntax, rapid reversible operations with immediate feedback.
- **Liveness.** No edit-compile-run seam; the model is always running, so changing an input updates everything and experimentation is cheap.
- **Low floor, high ceiling.** Zero barrier to entry, and the tool grows with the user from data entry through to real modelling without switching tools.

And the honest counterweight: the same freedom produces catastrophic, *silent* failures — data truncated past a row limit with no warning, a formula applied to the wrong range, a sum where an average was meant. **Representation is easily mistaken for reality; the interface makes powerful actions feel trivial and trivial mistakes consequential.** Note the pattern in the well-known cases: the safeguards existed and were not applied. Availability is not adoption.

The lesson is not "prefer spreadsheets". It is that **transparency and auditability are what make trust rational rather than credulous** — and that a system offering agency must also make the guardrails the default, not an option.

## What good looks like (the bar)

- **The user can see how a result was produced.** A derivation, a formula, a source, a query, a chain of steps — reachable from the result itself rather than from documentation.
- **Wrong results are correctable by the person who noticed.** The path from "this looks wrong" to a fix does not require going through someone else. Where it must, that path is short and stated.
- **The system invites "why" and "what if".** Beyond a status verdict, the user can interrogate a number, change an input and see the consequence, or view what a summary is summarising.
- **An escape hatch exists.** Export, raw view, API, download, "show the underlying data". Users route around rigid systems regardless; a designed route beats an improvised one, and its persistence in mature products is evidence of a real need rather than a legacy quirk.
- **Guardrails are enforced, not merely available.** Validation, range checks, truncation warnings, confirmation on destructive scope. The known failure mode is a safeguard that ships turned off.
- **Silent truncation and partial processing are impossible.** Anything that drops, skips, samples or caps says so, in the output, where a user will see it. *What is visible must not be silently assumed to be complete.*
- **The competence the system depends on is not quietly removed.** If the design assumes the user can judge the output, it must also keep them equipped to judge it — the reviewing skill has to survive the automation of the producing skill.
- **Simplification is disclosed.** Where the interface presents a reduced model, it says so and offers the fuller one, rather than presenting the reduction as the whole truth.
- **The user remains the author of the arrangement where arrangement carries meaning** — able to organise, name and place things themselves rather than having structure imposed and reshuffled underneath them.
- **Openness to repurposing.** Whole tasks are temporary; a design that permits recombination and use beyond the original intent outlasts one fitted exactly to today's workflow.

## Common defects (what to attack)

- **Black-box result.** A number, score, status or recommendation with no reachable derivation, source or logic.
- **Helplessness on error.** The user can see something is wrong and has no route to investigate or fix it; the only action is to ask someone else.
- **Verdict without interrogation.** A green light, a score, or a summary that answers *is it fine* and offers no way to ask *why* or *what if*.
- **Silent truncation, sampling or capping.** Output presented as complete when it is not — no row-limit warning, no "showing first N", no note that a step was skipped. **The single highest-severity defect in this lens**, because it produces confident wrong conclusions.
- **Safeguards present but off.** Validation, protection and auditing features shipped disabled or undocumented.
- **No export or raw view.** The user is locked into the presented abstraction with no way to take the data elsewhere.
- **Undisclosed simplification.** A reduced model presented as the whole picture, with the omitted nuance discoverable only by being wrong.
- **Operator, not author.** Ordinary adaptations (add a field, change a category, reorder) require a privileged role or a ticket, with no self-service path and no acknowledgement of the cost.
- **Imposed arrangement.** Structure, ordering or grouping continually rearranged by the system where the user's own arrangement carried meaning.
- **Deskilling by design.** The interface removes the practice that the user's oversight role still depends on, while continuing to hold them responsible for the outcome.
- **Automation without an override.** No manual path, no way to disagree with the system and proceed, or an override that is punitive or hidden.

## Quick-reference checklist

- [ ] Every derived result has a reachable derivation, source or formula
- [ ] A user who spots an error can investigate and correct it themselves
- [ ] The interface supports "why" and "what if", not just a verdict
- [ ] Any truncation, sampling, capping or skipped step is stated in the output
- [ ] Guardrails and validation are enabled by default, not optional extras
- [ ] An export / raw-data / underlying-view escape hatch exists
- [ ] Simplifications are disclosed as simplifications
- [ ] Ordinary adaptations do not require a privileged role or a ticket
- [ ] User-authored arrangement is preserved rather than reshuffled
- [ ] An override path exists and is neither hidden nor punitive
- [ ] The judgement the design still expects of the user is still supported by it

## Sources

- [Shneiderman, "Direct Manipulation: A Step Beyond Programming Languages" (1983)](https://www.cs.umd.edu/~ben/papers/Shneiderman1983Direct.pdf) — continuous representation and reversible action as the basis of user control and comprehension.
- [Nardi, *A Small Matter of Programming* (1993)](https://mitpress.mit.edu/9780262140539/a-small-matter-of-programming/) — end-user programming; why non-programmers succeed with formal computation when the system is transparent and incremental.
- [Ink & Switch — End-user programming](https://www.inkandswitch.com/end-user-programming/) — modern survey of what it takes for ordinary users to remain authors rather than operators.
- [Ink & Switch — Local-first software](https://www.inkandswitch.com/essay/local-first/) — ownership and continued access as a component of agency.
- [Sarkar (Microsoft Research), "The spreadsheet experience" (2020)](https://www.microsoft.com/en-us/research/wp-content/uploads/2020/04/sarkar_2020_spreadsheet_experience.pdf) — why the grid retains users against purpose-built alternatives.
- [Public Health England COVID case-loss incident (2020)](https://www.bbc.co.uk/news/technology-54423988) — silent truncation past a row limit; the canonical case for "what is visible is not necessarily complete".
- [Fuller, *Behind the Blip* — "The Impossibility of Interface" (2003)](https://www.amazon.co.uk/dp/1570271399) — interfaces as reductive control maps over processes the user cannot see into; the deskilling argument and the case for interrogating promises of simplicity.
- [Sennett, *The Corrosion of Character* (1998)](https://wwnorton.com/books/9780393319873) — the bakery case: an easy-to-use control layer over a process the workforce no longer understands.
