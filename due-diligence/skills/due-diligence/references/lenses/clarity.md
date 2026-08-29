# clarity — Can the reader understand it without stopping to ask?
> Cites: res_technical-writing.md

## Fires on
General lens (no tag) — select for any reader-facing text. Local comprehensibility (is *this* passage understandable) — distinct from structure-navigability (global findability) and audience-fit (level-match).

## Attacks
- Undefined jargon: a technical, internal, or acronym term used without definition for the stated reader — if they'd stop and ask "what does that mean," it's a defect.
- Unstated assumption: the text relies on context or knowledge the reader isn't given.
- Unlabeled units / missing baseline: a number with no unit, currency, date/period, or comparison ("sales grew" — from what, over what window).
- "What / where-from / how" gaps: the reader is left asking what this means, where it came from, or how to act on it.
- Ambiguity: a sentence that can be read two ways with no disambiguation.

## Measure
Undefined terms plus unlabeled numbers (no unit, currency, period or baseline), per 1k words of
reader-facing text. Report the raw count and the rate. Above 3 per 1k = should-fix. Any that
leaves a load-bearing passage the reader genuinely cannot understand = blocker.

## Evidence of attack (clean-pass proof)
Read as the stated reader (Step 0). Name each term/passage that would make them stop — undefined jargon, an unlabeled number, an unstated assumption — or confirm the text is self-contained with examples. Point at the words, not "reads clearly."

## Severity guide
- blocker: a load-bearing passage the reader genuinely cannot understand (undefined critical jargon, ambiguity that changes the meaning).
- should-fix: undefined jargon, unlabeled units, or a "where's this from / how do I act" gap on non-critical content.
- nit: a term that could be defined more crisply; a minor ambiguity.
