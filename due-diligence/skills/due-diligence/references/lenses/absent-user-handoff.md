# absent-user-handoff — What does the system owe a user who wasn't there while it worked?
> Cites: res_agent-interfaces.md

## Fires on
Tags: `llm-pipeline`, `cron`, `pipeline`, `deploy`, `migration`, `infra`. Any artifact that **acts while the user is away** — an agent run, a scheduled job, a background worker, a long-running generation, a batch process, an automated deployment. Distinct from observability (signals *for operators* about system health) and error-handling (does it catch failures): this lens reviews the **return experience** — what the person who delegated the work sees when they come back.

## The failure this catches
Interface design spent decades narrowing the distance between intent and visible consequence. Agentic and scheduled systems reopen it on a **temporal** axis: the user is still present at the consequences but absent from the moment of action. Duration matters — half a second is a pause within an action, thirty seconds is a turn in a conversation, thirty minutes is an episode the user was not part of.

The dominant pattern (**review, confirm, undo** — diffs, accept/reject, regenerate) assumes the unit of human attention can keep pace with the unit of system action. True for a paragraph; false for a long run touching many files, sending messages, or changing shared state. **A confirmation prompt on an artifact too large to actually read is theatre.**

## Attacks

**A. Transcript instead of a designed return view**
- The return surface is a chat log, console dump or event stream the user must read in order to reconstruct what happened.
- The run is presented as a conversation to resume rather than a result to arrive at. What the returning user needs is *reading*, not fresh editing.

**B. Narration instead of state**
- A sequence of "did X, then Y" with no answer to **what is true now** and **what needs me**.
- No glanceable current state; the user must replay the history to learn the outcome.
- Success and failure require equal reading effort to distinguish.

**C. No deviation surface**
- Everything reported at equal weight; nothing separates the expected from the surprising.
- No trends, rates, counts, or diffs-against-expectation — only raw events.
- A partial success reads like a success (or like a failure) because nothing quantifies what completed.

**D. Unreviewable review**
- Accept/reject offered on an artifact too large to read in the time the interface implies — consent that cannot be informed.
- The review surface did not change shape as autonomy grew: the same control that suited one small change now sits under a sweeping one.
- No grouping, summarisation by consequence, or architectural-impact view for a large change set.

**E. No intervention**
- No way to stop, pause or correct mid-run.
- Intervention exists but its effect on in-flight work is undefined — the user cannot tell what will be half-done if they stop it.
- No named points at which taking over is safe.

**F. No durable trail**
- No inspectable record of what was done and why, after the fact.
- Reasoning or progress output is ephemeral — visible during the run, gone afterwards, so a bad outcome cannot be diagnosed.

**G. Silence on the failure path**
- A failed or partially-completed run that produces no notification, or one indistinguishable from routine completion (cross-refs attention-cost).
- Work that silently did not happen — a skipped schedule, a killed process, an expired credential — with the return view showing nothing amiss.

## Evidence of attack (clean-pass proof)
Describe the actual return view, don't assume one exists: **state what the user sees on return and whether it answers "what is true now" and "what needs me" without reading the history.** Name how deviations are distinguished from routine progress. State the size of a realistic run and whether the review surface is proportionate to it — if it offers accept/reject, say whether a person could genuinely read what they are approving. Name the intervention points and what happens to in-flight work at each. Confirm a durable record exists and say where. Walk one failure path and state exactly what the returning user would see. **"It logs everything" is the defect, not the evidence.**

## Severity guide
- **blocker**: a failed or partial run that the returning user cannot detect; an accept/reject on a change set too large to review, presented as if it were reviewable; no way to stop a destructive or externally-visible run in progress; no durable record of what an autonomous run did.
- **should-fix**: return view is a transcript or raw log rather than designed reading; narration with no current-state summary; no deviation surface; intervention exists but in-flight behaviour is undefined; ephemeral reasoning with no persisted trail; review surface unchanged as run size grew.
- **nit**: state summary present but could be more glanceable; the record exists but is awkward to reach; timestamps or grouping could be clearer.
