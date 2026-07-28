# logical-research

One skill that turns a **bounded corpus** — a YouTube channel, a book, a podcast back catalogue, a
docs site, a set of papers — into **reusable context** rather than a summary you read once.

Output: a synthesis doc with every significant claim graded by evidence strength, one note per item,
and a traceable bibliography — shaped so you can paste the useful part into a model later as working
context for a real task.

## How it works

Six phases. 1–3 are mechanical (enumerate the corpus, pull it, normalise to clean prose and extract
the bibliography). **Phase 4 is the one that matters and cannot be delegated**: read every item in
full, in corpus order, one note each. Cross-item connections — the recurring citation, the argument
that reverses later, the thesis restated three ways — only surface when one reader holds the whole
corpus. Extraction scripts and subagents cannot produce them. Phase 5 synthesises, phase 6 verifies.

Two things are non-negotiable in the output:

- **A grounded vs speculative split** on every significant claim. Without it the doc launders
  speculation into fact, and it must survive into whatever you paste into a model.
- **Traceability** — every claim attributable to the item it came from, names checked against
  citations rather than transcripts (auto-captions garble proper nouns beyond recognition).

**Optional phase 7** turns the research into a permanent review lens pack for the
[`due-diligence`](../due-diligence/README.md) plugin — so principles become review capability
instead of a doc you have to remember to re-read.

## Install

**As a plugin (auto-updating):**
```
/plugin marketplace add thelogicmatrix/lm-tools
/plugin install logical-research@lm-tools
```

**As a plain skill (static, no auto-update):** it's an ordinary skill folder — copy it into your
project's or user `.claude/skills/`:
```
cp -r logical-research/skills/logical-research <your-repo>/.claude/skills/
```

## Use

*"research this channel for me"* · *"read all of these and synthesise"* · *"build me a knowledge
pack on X"* — then answer the two scope questions it asks (doc shape, and what the research is
*for*) and let it run.

Don't use it for a one-off question; that's a search. Don't use it on a corpus you can't enumerate
up front — scope it down until you can.

## Extending — your own reading angles

logical-research follows the lm-tools three-tier contract: a core you don't touch, and a tier you own.

| Tier | Where | Updates? |
|---|---|---|
| **Core** | the plugin's `SKILL.md` + `references/` | with the tool |
| **Yours** | `.lr/angles/*.md` in *your* repo | never touched by a plugin update |

The variable part of the pipeline is the **angle** — what the research is for, which becomes a named
section in every item note. Drop a recurring one in `.lr/angles/<name>.md` (what to look for, what
counts as relevant, how to phrase the section) and phase 4 reads it instead of you re-explaining the
angle each run. Nothing else is required; an angle passed in conversation works fine without a file.
