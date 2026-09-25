# Purpose lines

A purpose line is a context pointer. It sits in context, names material that is not in context,
and encodes the condition for reaching it. For a procedure, standard or reference it is also the
router's whole input about that runbook. The router asks one model call whether each purpose line
applies to the prompt and injects the runbooks that score 0.8 or higher. So every word in a
purpose line decides whether that runbook ever reaches a task.

## Three rules

1. **Front-load the leading word.** The pointer does its triggering work at the start.
2. **One trigger per branch.** A branch is a distinct case the document handles. Synonyms that
   rename one branch are that branch written twice. Collapse them.
3. **Cut identity the body already carries.** The pointer says when to reach for the file, not
   what the file is called.

Write it as the tasks a reader would be doing when they need the file, in the words they would
type. Do not write what the document is or how its mechanism works.

Keep it to 25 words or fewer and on one physical line. The lint fails a standard or reference
over 25 words, and only the first physical line reaches the index and the lint.

A must-have runbook behind a weakly worded purpose is a variance bug. Sharpen the wording first,
and inline the material somewhere always loaded only if sharpening fails.

## The gate

A word-match prefilter runs before the model call once the corpus holds more than 30 routable
runbooks. It ranks every one by BM25 over its file name and purpose and keeps the top 30 (the
`shortlist` setting), padded to 30 even where a runbook scores zero. Every standard outside the
top 30 is added back, so only a procedure or reference can be cut. Then the model scores what is
left. A new or reworded procedure, standard or reference passes this check before it is committed:

    node <plugin>/scripts/check.mjs <runbook.md> "<prompt>" "<prompt>" "<prompt>" --not "<unrelated prompt>"

- **Three or four task prompts**, worded the way a real task would arrive, without borrowing the
  runbook's own vocabulary. Each must print PASS at **0.85**.
- **One unrelated prompt** after `--not`, which must stay under 0.8.
- **Why 0.85 and not 0.8.** Identical runs wobble by 0.02 to 0.04, so a line written at 0.80
  fails the next time. The write bar is the firing bar plus 0.05.
- **A prompt the prefilter cuts is a fail**, because a cut runbook never reaches the model. A
  procedure or reference whose purpose shares no rare word with the task ranks low and is cut
  first in a large corpus.
- **A prompt under 12 characters never routes**, so test prompts must be longer.

On a fail, rewrite the purpose around the task the reader is doing, not the mechanism the
document uses. Trial the rewrite with `--purpose "<text>"` before editing the file.

Each prompt costs one API call, about $0.0004.

## The ledger

Add `--record` to the run that passes. It writes the prompts and a fingerprint of the scored
purpose to the ledger (`<runbooks folder>/.router-ledger.json` unless `.runbooks/config.json`
sets `ledger`). From then on:

- `check.mjs --changed` re-runs only the runbooks whose purpose moved since their entry, with the
  stored prompts. An unchanged purpose costs no call.
- `check.mjs --changed --dry` lists what would run, free.
- `index.mjs --lint` names the changed and never-checked purposes.

Only reword a purpose when the check fails or the runbook's job changed. A passing line stays as
it is.

## Worked case

A runbook about clicking elements in a browser said "Decide which element to click in any
browser-automation loop without the accessibility snapshot entering a model's context". It scored
0.52 to 0.64 on browser prompts, and two were cut by the prefilter, so it never fired through a
whole browser session. Rewritten around the task (website, web form, admin console, logging in,
changing a setting), the same five prompts scored 0.87 to 0.94 and the unrelated ones stayed cut.

The first line described the mechanism. The rewrite named what the reader was doing.

## A pointer with no words does no work

A runbook with no purpose line never routes. It can only be reached by someone remembering it
exists, which is the load the router exists to take away.
