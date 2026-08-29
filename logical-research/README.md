# logical-research

One skill that turns a **bounded corpus** — a YouTube channel, a book, a podcast back catalogue, a
docs site, a set of papers — into **reusable context** rather than a summary you read once.

Two tiers: **Scan** answers a question or a handful of sources in one graded file, **Pack** turns a
bounded corpus into a durable pack.

A Pack's output: a synthesis doc with every significant claim graded by evidence strength, one note
per item, and a traceable bibliography — shaped so you can paste the useful part into a model later
as working context for a real task.

## Two tiers

| Tier | When | Output |
|---|---|---|
| **Scan** (default) | a question, or under about eight sources | one graded file, `<root>/<slug>.md` |
| **Pack** | a bounded corpus you will return to | the full synthesis, notes and bibliography |

Both rank sources by authority before reading and keep the grounded / supported / speculative split. Scan escalates to Pack when the source count grows or you say you will come back to it.

## How a Pack works

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

**Prerequisites:** nothing extra for books, PDFs, docs sites and papers. For YouTube or podcast
corpora, Python 3 with `yt-dlp` on PATH (`pip install yt-dlp`).

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
pack on X"*. On a Pack it asks two scope questions (doc shape, and what the research is *for*),
then runs. A Scan asks nothing.

A single fact lookup with no synthesis is a search, not research. Anything that ranks sources or
grades claims is Scan. Don't use it on a corpus you can't enumerate up front — scope it down
until you can.

It handles two kinds of corpus, and says which it assumed. An **authored** corpus is one mind
across many items (a channel, a back catalogue) and the value is the author's method. An
**authoritative** corpus is many first-party sources on one question (regulations, specs, official
docs) and the value is which source outranks which. The synthesis skeleton reads differently for
each, and getting the kind wrong is the most expensive mistake available here.

## Called by another skill

Any skill can drive it instead of you, by writing a **corpus brief** (`slug`, `root`, `shape`, `tier`,
`angle`, `corpus`) and handing it over — the same way a mail skill takes a batch file. A field the
brief answers is never asked about, the output path is the return value, and this skill knows
nothing about who called it. `SKILL.md` holds the format.

That is what makes it a component rather than a destination: the caller keeps its own docs and
links into the research pack, instead of copying the contents out and owning a second stale copy.

## Extending — your own reading angles

logical-research follows the lm-tools two-tier contract: a core you don't touch, and a tier you own.

| Tier | Where | Updates? |
|---|---|---|
| **Core** | the plugin's `SKILL.md` + `references/` | with the tool |
| **Yours** | `.lr/angles/*.md` in *your* repo | never touched by a plugin update |

The variable part of the pipeline is the **angle** — what the research is for, which becomes a named
section in every item note. Drop a recurring one in `.lr/angles/<name>.md` (what to look for, what
counts as relevant, how to phrase the section) and phase 4 reads it instead of you re-explaining the
angle each run. Nothing else is required; an angle passed in conversation works fine without a file.
