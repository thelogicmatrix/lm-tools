# inference-legibility — When the system interpreted intent, can the user tell, and check?
> Cites: res_agent-interfaces.md

## Fires on
Tags: `llm-pipeline`, `rendered-ui`, `code`. Any artifact where the system **infers what the user meant** rather than receiving it explicitly — natural-language input, intent classification, auto-categorisation, smart defaults, agentic planning, "did you mean", automatic parameter selection. Distinct from output-grounding (is the *content* supported by sources) and llm-eval (is quality measured): this lens asks whether the **act of interpretation** is visible and checkable by the person it was performed for.

## The failure this catches
In every non-inferring state, the system's state and the user's understanding of it are in principle the same. An inferred state introduces a structural gap between what the user believes was understood and what was actually computed — and typically nothing in the interface signals that an interpretation happened. Showing the result does not close the gap: it surfaces the output, not the reasoning, the confidence, or the assumptions. **A bare confirmation asks the user to audit a decision they did not make.**

## Attacks

**A. Invisible inference**
- An inferred value rendered identically to a user-supplied one — nothing distinguishes "you said this" from "we decided this for you".
- No signal that an interpretation occurred at all; the user cannot know there was a decision to disagree with.
- Smart defaults or auto-categorisation applied silently and presented as fact.

**B. Illegible reasoning**
- The output is shown but not what was assumed, from what, or with what confidence.
- No indication of where a different reading was plausible — genuinely ambiguous input resolved to the most likely interpretation with no flag, so the error only appears in the outcome.
- Confirmation-as-theatre: a number, plan or summary presented for approval with none of the reasoning that produced it. The user can only accept or reject an opaque result.

**C. Mismatched stakes**
- Irreversible, expensive or externally-visible action taken on inferred intent without explicit confirmation *with the reasoning attached*.
- Conversely: heavyweight confirmation on a cheap, trivially reversible inference, adding the friction the feature was meant to remove.
- No visible undo on an act-immediately inference.
- Multi-step inferred work executed without stating the interpreted plan first.

**D. Misrepresented reliability**
- A seamless, caveat-free presentation from a system that is frequently wrong. Hiding the machinery is an implicit claim of consistent correctness and must be earned.
- A confidence score with no defined meaning, or one used as liability cover rather than to inform a decision.
- Breadth that forecloses calibration: the scope is so wide the user cannot learn what the system will and will not do reliably, so they cannot form a working practice around it.

**E. No trail**
- No durable, inspectable record of what was inferred, on what basis, and what was then done — so a wrong interpretation cannot be diagnosed after the fact.

## Evidence of attack (clean-pass proof)
Name every point where the system infers rather than receives, and for each state: how the user can tell an inference happened; what of the reasoning is inspectable; whether ambiguity is surfaced or silently resolved; the reversibility and cost of being wrong; and whether the confirmation (if any) shows reasoning or only output. **Walk one ambiguous input through the system and say what it resolved to, whether the alternative reading was plausible, and whether the interface would have told the user.** Quote the actual confirmation text. "The model is accurate" is not evidence — the question is what happens on the occasion it isn't.

## Severity guide
- **blocker**: an irreversible, costly or externally-visible action taken on inferred intent with no informed confirmation; a silent misinterpretation that produces a wrong result the user has no way to detect; a confident caveat-free presentation from a demonstrably unreliable inference.
- **should-fix**: inferred values indistinguishable from supplied ones; confirmation showing output but not reasoning; ambiguity resolved silently; no visible undo on an act-immediately inference; multi-step inferred work executed with no stated plan; no inspectable record of what was inferred.
- **nit**: confidence could be expressed more precisely; the assumed-parameters view could be easier to reach; a plan step that could be worded more plainly.
