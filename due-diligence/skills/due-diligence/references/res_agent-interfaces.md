# res_agent-interfaces — The Absent-User & Inferred-Intent Bar
> Research-backed reference for the Due Diligence absent-user-handoff and inference-legibility lenses. Two related failures of systems that act on a user's behalf: what the interface owes someone who *was not present while it worked*, and what it owes someone whose intent was *interpreted rather than received*. Distinct from res_llm-eval (is the output good) and res_llm-safety (is the input/output handled safely); this is about the human's position relative to the action.

## The two shifts

**1. The user recedes in time.** Sixty years of interface design narrowed the distance between intent and visible consequence — Shneiderman's direct manipulation (objects continuously represented, actions physical, operations rapid and reversible, effects immediately visible) and Hutchins/Hollan/Norman's account of narrowing the *gulf of execution* (intention → required action) and the *gulf of evaluation* (system state → user's perception of it). Agentic systems reopen that distance on a different axis: **temporal, not spatial.** The user is still on the surface; what they no longer share is the moment of action.

Duration crosses meaningful thresholds. Half a second is a pause *within* an action. Thirty seconds is a turn in a conversation. **Thirty minutes is an episode with a beginning, middle and end that the user was absent from.** The design question that follows: *when the user is not in the room while the system acts, what does the interface owe them on their return?*

**2. Intent is inferred rather than received.** In every pre-inference state, the system's state and the user's understanding of it were — in principle — the same thing. Paused is unambiguously paused; cancelled is gone. **An inferred state introduces a structural gap between what the user believes the system understood and what it actually computed** — and typically the interface produces no signal that an interpretation took place at all.

Showing the result does not close the gap: it surfaces the *output* of the inference, not the reasoning, the confidence, the parameters assumed, or how differently the same phrasing could have resolved. Hence the bind — act immediately and errors stay silent until the outcome is wrong; require confirmation and the friction you removed returns, plus a new cognitive step. **A bare confirmation asks the user to audit a decision they did not make.**

Underneath both: the interface stops being a surface the user **acts upon** and becomes a surface the user **supervises**. That is a different cognitive relationship and needs a different interface.

## Why "review, confirm, undo" is not sufficient

The pattern that stabilised across generative tools — diff views, accept/reject, regenerate, expandable reasoning traces — is version control applied to model output. It lets the user remain *authoritative over the output* without remaining *attentive to its production*, and it works well at small units.

Its limit is structural: **it assumes the unit of human attention can keep pace with the unit of agent action.** True when the agent's unit is a paragraph. False when it is a long run touching many files, opening connections, sending messages, and changing shared state. It can absorb a few generations per session; it cannot absorb sustained autonomy. A confirmation prompt on an artifact too large to actually read is theatre.

## What good looks like (the bar)

**For the absent user's return**

- **The return view is designed as a deliverable, not as a transcript.** Bret Victor's distinction applies directly: most software is treated as *manipulation software* (the user acts continuously) when what a returning user needs is **information software** — well-designed reading. Presenting the artifact of a long autonomous run as a conversation to resume, rather than a site to arrive at, is the characteristic failure. [Victor, *Magic Ink*]
- **Glanceable whole-state over event-by-event narration.** The mature precedent is air traffic control, where competence is reading the entire airspace at once rather than tracking each aircraft; the interface privileges current state and exception points over a log of everything that happened. [ATC ethnographic literature; Hutchins, *Cognition in the Wild*]
- **Deviations from expectation are surfaced, not events.** Process-control practice optimises for making trends, rates of change, and departures from expected operation legible — because the operator cannot review every event and the catastrophic failure mode is flooding them with all of it. [Rasmussen; Vicente, *Cognitive Work Analysis*]
- **Clear, specific intervention points.** The user can stop, correct, or take over at named places — and knows what happens to work already in flight when they do.
- **Maintained coherence where possible.** The spreadsheet precedent: declare the relationships once, and the system keeps them current, so returning after time away shows a consistent state rather than a replay. [Nardi, *A Small Matter of Programming*]
- **Existing conventions are borrowed rather than reinvented.** Daemons, scheduled jobs, structured logs, process and status views have been interface-for-the-absent-user since the 1970s; observability tooling has already converged on persistent state surfaces for exactly this problem.
- **Reviewability scales with autonomy.** As the unit of agent action grows, the review surface changes shape — summarised architectural impact, grouped changes, diffs by consequence rather than by file. If the run got bigger and the review UI did not change, review has quietly become rubber-stamping.

**For inferred intent**

- **The user can tell an interpretation happened.** Inference is visibly distinguished from instruction — an inferred value never looks identical to one the user supplied.
- **The inference is legible, not just its output.** What was assumed, from what, with what confidence, and where a different reading was plausible. Enough for the user to disagree with the *reasoning*, not merely the number.
- **Ambiguity is surfaced at the point it arises,** not resolved silently in favour of the most common reading.
- **The cost of being wrong sets the interaction.** Cheap-to-reverse, low-consequence inferences can act immediately with a visible undo; expensive or irreversible ones require explicit confirmation *with the reasoning attached*.
- **Plan-then-act for multi-step inference.** Stating the interpreted plan before executing it is the practical form of legibility, and is the pattern coding and automation agents converged on.
- **Scope is narrow enough to be trustworthy.** Narrowness is what makes trust possible: a user can learn what a bounded system will and will not do and build a practice on top of it. Breadth ("ask me anything") forecloses that, because there is nothing stable to calibrate against.
- **Confidence claims match reliability.** Hiding the machinery — no spinner, no hedge, no score — is a strong implicit claim that the system is consistently right, and is only legitimate when it is. A frequently-wrong system that presents seamlessly is misrepresenting itself.

**Common to both** — mixed-initiative principles remain the best-established guidance: consider uncertainty about the user's goal, weigh the cost of acting wrongly against the cost of interrupting, provide efficient direct invocation and termination, maintain working memory across turns, and let the human and system take turns rather than one replacing the other. [Horvitz, *Principles of Mixed-Initiative User Interfaces*]

## Common defects (what to attack)

- **The return view is a chat transcript or a raw log.** The user must reconstruct what happened by reading everything in order.
- **Narration instead of state.** A stream of "did X, did Y" with no answer to *what is true now* and *what needs me*.
- **No deviation surface.** Everything reported at equal weight; nothing distinguishes the expected from the surprising.
- **Unreviewable confirmation.** An accept/reject on an artifact too large to read in the time the interface implies — consent that cannot be informed.
- **No intervention point, or an unclear one.** No way to stop or correct mid-run, or no statement of what happens to in-flight work when the user does.
- **Silent inference.** An interpreted value rendered identically to a user-supplied one, with no signal that a decision was made on their behalf.
- **Confirmation-as-theatre.** A number or summary presented for approval with none of the reasoning, confidence, or assumptions that produced it.
- **Silent ambiguity resolution.** Genuinely ambiguous input resolved to the most likely reading with no flag, so the error only appears in the outcome.
- **Irreversible action on inferred intent** without explicit, informed confirmation.
- **Confidence theatre in either direction:** a seamless, caveat-free presentation from an unreliable system; or a confidence score with no meaning behind it, used as liability cover.
- **Lost audit trail.** No durable record of what was done, on what basis, that the user can inspect after the fact.
- **Review UI unchanged as autonomy grew.** The same accept/reject that worked for a paragraph now sitting under a hundred-file run.

## Quick-reference checklist

- [ ] The return view is designed reading, not a transcript or log
- [ ] Current state is glanceable; the user can see what is true now without replaying events
- [ ] Deviations from expectation are distinguished from routine progress
- [ ] Intervention points are named, and in-flight behaviour on intervention is defined
- [ ] Review effort scales with the size of the run — no unreviewable accept/reject
- [ ] Inferred values are visually and semantically distinct from supplied values
- [ ] Assumptions, confidence, and the plausible alternative reading are inspectable
- [ ] Ambiguity is surfaced when it arises, not resolved silently
- [ ] Irreversible or expensive actions require confirmation *with reasoning attached*
- [ ] Presentation seamlessness is justified by actual reliability
- [ ] A durable, inspectable audit trail of actions and their basis exists

## Sources

- [Shneiderman, "Direct Manipulation: A Step Beyond Programming Languages" (1983)](https://www.cs.umd.edu/~ben/papers/Shneiderman1983Direct.pdf) — continuous representation, physical action, rapid reversible operations with immediate visible effect; the baseline the absent-user case departs from.
- [Hutchins, Hollan & Norman, "Direct Manipulation Interfaces" (1985)](https://www.tandfonline.com/doi/abs/10.1207/s15327051hci0104_2) — the gulfs of execution and evaluation; the framework for measuring what a returning user has to bridge.
- [Bret Victor, *Magic Ink* (2006)](https://worrydream.com/MagicInk/) — information software vs manipulation software; designing for reading rather than acting, which is exactly what a returning user needs.
- [Horvitz, "Principles of Mixed-Initiative User Interfaces" (1999)](https://www.microsoft.com/en-us/research/publication/principles-mixed-initiative-user-interfaces/) — uncertainty about user goals, the cost of acting vs interrupting, invocation and termination, and turn-taking between human and system.
- [Shneiderman & Maes, "Direct Manipulation vs Interface Agents" (1997)](https://www.lri.fr/~mbl/ENS/FONDIHM/2013/papers/ShneidermanMaes-Interactions97.pdf) — the original statement of the predictability, control and comprehensibility costs of delegation.
- [Hutchins, *Cognition in the Wild* (1995)](https://mitpress.mit.edu/9780262581462/cognition-in-the-wild/) — cognition distributed across artifacts and arrangement; the basis for glanceable-state interfaces in control settings.
- [Vicente, *Cognitive Work Analysis* (1999)](https://www.routledge.com/Cognitive-Work-Analysis-Toward-Safe-Productive-and-Healthy-Computer-Based-Work/Vicente/p/book/9780805823974) and [Rasmussen's skill/rule/knowledge framework](https://ieeexplore.ieee.org/document/6313160) — designing supervisory interfaces for processes that cannot be paused for review.
- [Nardi, *A Small Matter of Programming* (1993)](https://mitpress.mit.edu/9780262140539/a-small-matter-of-programming/) — maintained coherence and why declared relationships survive the user's absence better than replayed actions.
