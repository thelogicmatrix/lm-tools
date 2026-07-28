# agency-preservation — Can the user still see in, check, and override?
> Cites: res_user-agency.md

## Fires on
Tags: `rendered-ui`, `data-analysis`, `llm-pipeline`, `data-export`, `recommendation`. Any artifact that **presents derived results or acts on the user's behalf** — a dashboard, a report, a score, a summary, an automated decision, a recommendation, a generated analysis. Distinct from actionability (does it drive a decision) and deep-accessibility (can they perceive and operate it): this lens asks whether the user retains the **capability to check the system and act competently against it**.

## The claim
Every interface that hides complexity makes a trade, and the thing most often traded away is the user's ability to understand and correct what the system is doing. Frequently worth making — but it is a *choice*, and a design that presents it as inevitable has hidden its most consequential decision. **Whenever an interface promises to make something simple, that promise is the thing to interrogate.** Ease of use is not neutrality.

Two compounding failures: **opacity** (the user cannot see how a result was produced, so cannot tell right from wrong) and **passivity** (the interface is built so the user is not expected to ask *why* or *what if*, and stops doing so).

## Attacks

**A. Opacity**
- A number, score, status or recommendation with no reachable derivation, source, formula or query.
- The user can see something is wrong and has no route to investigate — the only available action is to ask someone else.
- Logic lives somewhere the user cannot reach and is not documented where the result appears.

**B. Silent incompleteness** — *the highest-severity failure in this lens*
- Truncation, sampling, capping, deduplication or a skipped step that is not stated **in the output**. What is visible is presented as complete when it is not.
- A partial run, a filtered subset, or a dropped record set that produces a confident, wrong conclusion with nothing flagging it.
- Row/size/rate limits hit silently.

**C. Passivity by design**
- A verdict with no interrogation path: a green light, a score or a summary that answers *is it fine* and offers no way to ask *why* or *what if*.
- No way to change an input and see the consequence; no view of what a summary is summarising.
- Undisclosed simplification — a reduced model presented as the whole truth, its omitted nuance discoverable only by being wrong.

**D. Locked in**
- No export, raw view, underlying data or API — the user is confined to the presented abstraction.
- Ordinary adaptations (add a field, change a category, reorder, filter differently) require a privileged role or a ticket, with no self-service path and no acknowledgement of the cost.
- User-authored arrangement continually reshuffled by the system where the user's own organisation carried meaning.

**E. Guardrails and override**
- Validation, protection, range-checking or auditing features that exist but ship disabled or undocumented. *Availability is not adoption* — the known failure mode is a safeguard nobody turned on.
- No override path, or one that is hidden or punitive; no way to disagree with the system and proceed.
- Destructive or wide-scope actions with no confirmation proportionate to their blast radius.

**F. Deskilling**
- The design removes the practice the user's oversight role still depends on, while continuing to hold them responsible for the outcome.
- The interface is genuinely usable and its relation to the underlying process is too shallow to support the judgement it expects.

## Evidence of attack (clean-pass proof)
Trace one result end to end: **pick a specific derived number or output and state whether a user could reach its derivation, from where, in how many steps.** Name every place the system could truncate, sample, cap or skip, and quote what the output says when it does — or state that it says nothing. List which guardrails exist and their default state. Say whether an export or raw view exists and what it contains. Name one ordinary adaptation a user might want and state whether they can make it themselves. Identify what judgement the design still expects of the user and whether the interface keeps them equipped to make it. **"It's easy to use" is the thing under review, not the defence.**

## Severity guide
- **blocker**: silent truncation, sampling or partial processing presented as complete — anything producing a confident wrong conclusion the user cannot detect; a consequential automated decision with no derivation and no override; a destructive wide-scope action with no proportionate confirmation.
- **should-fix**: derived results with no reachable derivation; no way to interrogate a verdict; guardrails present but off by default; no export or raw view; undisclosed simplification; ordinary adaptations requiring a ticket with no self-service path; user-authored arrangement reshuffled by the system.
- **nit**: the derivation is reachable but takes too many steps; the export could carry more context; a simplification is disclosed but could be flagged more visibly.
