# actionability — Does it tell the reader what to do / what it means for them?
> Cites: res_technical-writing.md

## Fires on
General lens (no tag) — select for any artifact meant to drive a decision or action (report, recommendation, analysis, status update, proposal). Skip for pure reference material with no decision attached. Extends operational-completeness's "answers the so-what" from tools to prose.

## Attacks
- No "so what": data/findings presented with no interpretation — the reader is left to figure out what it means and what to do.
- No next action / owner: a problem or recommendation with no concrete step, owner, or deadline; "we should improve X" with no how/who/when.
- Decision not surfaced: the artifact supports a decision (per Step 0) but never states the decision, the options, or the recommendation.
- Findings not ranked: everything presented flat, so the reader can't tell what matters most or where to act first.
- Buried ask: the one thing the reader must decide or do is not called out (ties to structure-navigability's buried bottom-line).

## Evidence of attack (clean-pass proof)
State the decision/action the artifact exists to drive (from Step 0), then confirm the artifact makes it explicit — the recommendation, the next step, the owner — or name where the reader is left with "so what do I do?" For a findings doc, confirm findings are prioritised. Not "actionable" without pointing at the action.

## Severity guide
- blocker: the reader cannot tell what to do or decide after reading — the artifact's whole purpose (drive a decision) fails.
- should-fix: findings lack interpretation or a next step; recommendation present but no how/who/when; no prioritisation.
- nit: action is present but could be stated more prominently.
