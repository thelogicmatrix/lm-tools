---
name: logical-research
description: Use whenever research is asked for or a body of source material must become reusable, traceable context. Triggers on "research X", "look into X properly", "what do the docs or sources say about X", "research this channel/author/book", "build me a knowledge pack on X", "read all of these and synthesise", or when a later task needs principles extracted from sources with every claim traceable. Self-selects a tier, Scan (a question or a small source set, one graded file) or Pack (a bounded corpus, the full pipeline). A single fact lookup with no synthesis is a plain search, not this.
runbooks:
  - topic: searching files, pages and code on this host
    at: acquire
---

# Logical Research

## Overview

At Scan tier the output is one graded file. At Pack tier it is a synthesis doc, per-item notes
and a bibliography. Either way, a bounded body of source material becomes **actionable context**,
structured so it can be fed to a model as working context for a later task.

The output is **not a summary**. It's a reusable knowledge artifact: original analysis with
claims graded by evidence strength, principles extracted as instructions, and every source
traceable back to the item it came from.

## Runbooks

With the runbooks plugin, the topics in this skill's frontmatter resolve to this host's runbooks when the skill loads, and each path arrives with the step that reads it. Read them before fetching or searching any source, at either tier, and paste the paths into any worker's brief. Without the plugin, open this skill's SKILL.md, read the runbooks: list in its frontmatter, and read what your own docs say on each topic before the step named beside it. A topic the load reports as unmapped reads as if the plugin were absent.

## Pick the tier

Say which tier in one line before starting. Both tiers keep the non-negotiables: rank sources by
authority before reading, split every claim into grounded / supported / speculative, and trace
every claim to the source it came from.

**Scan** is the default when the ask is a question, or the source set is under about eight items.
Enumerate the sources and rank them by authority (a first-party statement beats commentary on
it). Read each in full. Write one file, `<root>/<slug>.md`, containing: the question, the answer
graded well-grounded / reasonably supported / explicitly speculative, the sources ranked with one
line each on why they rank where they do, and applicable principles as numbered imperatives when
the material yields any. No notes folder, no bibliography file.

**Pack** is the six-phase pipeline below, for a corpus that is bounded and enumerable (a channel,
an author's works, a doc set), that you will return to more than once or hand to a model later,
and whose value is in cross-item synthesis rather than any single item.

Scan escalates to Pack when enumeration passes the threshold, or the caller says they will return
to the material. A corpus you cannot enumerate up front gets scoped down until you can.

A single fact lookup with no synthesis is not research. Use a search.

## Front-load two questions (Pack only)

Scan asks nothing. It writes one file.

Ask these before phase 4, batched, then run autonomously:

1. **Doc shape** — synthesis only, synthesis + per-item notes, or those plus retained raw text?
2. **Angle** — what is the research *for*? This becomes a named section in every item note.

Everything else — corpus boundaries, which items are primary, how to bucket the bibliography —
is a judgment call. Make it and say what you decided.

## Driven by another skill — the brief

This skill is usable on its own and as a callee. Another skill drives it by writing a **corpus
brief** and handing it over, instead of holding a conversation:

```markdown
# Corpus brief
slug:   <kebab-slug>            # names the output folder
root:   docs/research           # where the pack lands. Default: research/
shape:  synthesis+notes         # synthesis | synthesis+notes | synthesis+notes+raw
tier:   scan                    # scan | pack. Absent: the skill picks.
angle:  <what this research is for, one line>
corpus:                         # the enumerated items, or how to enumerate them
  - <item or source>
  - <item or source>
```

Three rules, and they are what make it composable:

- **A field the brief answers is never asked about.** The front-loaded questions are `shape` and
  `angle`, Pack only, and the tier when absent. If the brief carries them, run autonomously from
  there.
- **The output path is the return value.** Finish by printing the output path: `<root>/<slug>/` for
  Pack, `<root>/<slug>.md` for Scan. The caller links to that path, it does not copy the contents
  out — one fact, one home.
- **Know nothing about the caller.** No branch in this skill reads "a learning sprint asked" or
  "a review asked". If a caller needs something shaped differently, that belongs in its `angle`.

An incomplete brief is not an error. Ask only for the missing fields, then proceed.

## Pipeline

Six phases. 1–3 are mechanical and cheap. **Phase 4 is the expensive one and cannot be skipped
or delegated.**

### 1. Scope — establish the corpus before committing

Enumerate everything and get a word count *first*. This decides whether the job is one session
or several.

Pick a scratch directory outside the repo before the first command, for example
`$TMPDIR/research-<slug>`, and use it as `<scratch>` in every command here. Files written into a
shared repo get reported into every session that opens it.

```bash
# YouTube channel → full inventory as JSON
mkdir -p "<scratch>"
python -m yt_dlp --flat-playlist --dump-single-json --no-warnings \
  --retries 10 --socket-timeout 30 \
  "https://www.youtube.com/channel/<ID>/videos" > "<scratch>/channel.json"
```

The inventory takes no `--download-archive`. An archive filters flat playlist entries too, so a
re-run would leave the videos already pulled out of the count.

Then compute item count, total duration, total words, median length.

| Corpus size | Approach |
|---|---|
| < 150k words | One session, read everything |
| 150k–400k | Split by theme across sessions; write notes as you go, synthesise last |
| > 400k | Narrow the scope, or sample deliberately **and say so in the output** |

These thresholds are a working estimate from the reference run, not a measured limit. Adjust them
to your own session budget.

**Rank the items by authority now, not later.** On an authored corpus that means flagging what
is not the author's own work — reuploads, guest content — which gets a factual note rather than
principle extraction. On an authoritative corpus it means writing down which source outranks
which *before* reading, because the whole synthesis turns on it: a first-party statement beats
the public summary of it, and widely repeated secondary commentary is frequently the thing the
primary source contradicts. Mislabelling here contaminates everything downstream.

### 2. Acquire

**YouTube** — `yt-dlp`, with `--write-info-json` (the descriptions are the bibliography source):

```bash
python -m yt_dlp --skip-download --write-subs --write-auto-subs \
  --sub-langs "en.*" --sub-format vtt --write-info-json --sleep-requests 1 \
  --retries 10 --socket-timeout 30 \
  --download-archive "<scratch>/archive.txt" --force-write-archive \
  -o "<scratch>/subs/%(playlist_index)02d-%(id)s.%(ext)s" "<channel-url>/videos"
```

A killed or stalled pull resumes where it stopped: re-run the same command and it skips every
video already listed in `<scratch>/archive.txt`. `--socket-timeout` turns a stalled socket into
a retry instead of a hang. `--force-write-archive` is load-bearing. With `--skip-download`,
yt-dlp writes nothing to the archive without it, so the re-run would start from zero.

**Books / PDFs** — read directly; chapters are the items. **Podcasts** — as YouTube if hosted
there, else transcribe. **Docs sites / articles** — fetch one file per page.

Run long pulls in the background and do phase 3 setup while they run.

### 3. Normalise

Get everything to clean prose: one file per item, plus a machine-readable index.

For VTT, a ~30-line cleaner handles it — strip `WEBVTT`/`Kind:`/`Language:`/cue-timing lines,
strip inline `<00:00:00.000>` and `<c>` tags, then de-duplicate rolling captions (drop a line
identical to the previous or contained in it; replace the previous if the new line extends it).
**Hard-wrap the output at ~110 chars** — see gotchas. Keep the script; it's reusable.

Extract two more things here, because they're free and they shape the reading:

- **The bibliography** — regex `https?://[^\s)>\]]+` over descriptions/footnotes. Bucket by
  frequency: links appearing in more than a third of items are boilerplate (the author's own
  properties); the rest are real citations. The one-third line is a heuristic from one reference
  run, not a measured constant. This list is often as valuable as the corpus.
- **Per-item metadata** — date, length, popularity, chapters.

### 4. Read and note — the part that can't be automated

Read every item **in full**, in batches of 3–5, **in corpus order**. One note per item.

Do **not** delegate this to extraction scripts or subagents. Cross-item connections — the
recurring citation, the argument that reverses later, the thesis restated three different ways —
only surface when one reader holds the whole corpus. That is the entire value-add.

```markdown
# NN — Title
[Link] · date · length · popularity
**Thesis:** one sentence, in your words.

## Argument
2–5 short paragraphs. Your summary, not a transcript.

## Applicable
Bulleted. Each one an instruction, not an observation.

## [Angle]          ← the angle from the brief, or the one named up front
## Sources          ← citations from this item
```

**Read everything before writing the synthesis.** It is tempting to write notes and synthesis in
one pass; don't. The strongest cross-cutting themes typically only become visible two-thirds of
the way through.

If the repo has `.lr/angles/*.md`, read the ones matching the requested angle and let them shape
the angle section — that's your own extension tier (see `references/extending.md`).

### 5. Synthesise

The main doc. Four sections are invariant, two read differently depending on what kind of
corpus you have:

1. **Why this corpus is worth the time** — what distinguishes it. Specific and falsifiable.
2. **The structure** — *authored corpus:* the author's method, often the most transferable thing
   and rarely stated by them explicitly. *Authoritative corpus:* how the rules actually stack,
   which source outranks which, and where they interlock.
3. **Core claims** — 5–10. *Authored:* their theses, each with supporting evidence and the
   counter-case they raise. *Authoritative:* the findings, each with the source that settles it
   and the common misreading it corrects.
4. **Applicable principles** — the extract. Numbered, grouped, phrased as instructions. **This is
   the section a model will actually consume.**
5. **Grounded vs speculative** — split every significant claim into well-grounded / reasonably
   supported / explicitly speculative. **Non-negotiable.** Without it the doc launders speculation
   into fact, and in three months nobody remembers which was which.
6. **Reading order** — what to consume if not all of it. Name the one item to read first.
7. **What to do next** — only when the angle is a decision rather than a body of knowledge.
   Omit it otherwise rather than padding it.

**Which kind you have.** An *authored* corpus is one mind across many items: a channel, a back
catalogue, an author's works. The value is their method. An *authoritative* corpus is many
first-party sources on one question: regulations, official docs, specs, filings. There is no
method to extract, and the value is in precedence between sources. A corpus with a single
authoritative source and a pile of commentary is the second kind, not the first.

### 6. Verify

- Every internal link resolves — slugs in the synthesis must match the filenames actually written.
- Every claim attributed to a source is that source's, not your inference from it.
- Names and technical terms checked against **citations, not transcripts** (see gotchas).
- The grounded/speculative split is honest, including where that's unflattering.
- The headline answer, if the angle asked for one, is the one the highest-authority source
  supports — not the one the most sources repeat.

## Output shape

`root` from the brief, defaulting to `research/`.

Scan: `<root>/<slug>.md`, one file. Pack:

```
<root>/<slug>/
  README.md          synthesis — themes, principles, evidence grading
  links.md           bibliography, grouped by theme
  notes/README.md    index table + by-theme groupings
  notes/NN-slug.md   one per item
```

Working files — raw transcripts, JSON, cleaner scripts — stay in a scratch directory **outside
the repo**. They're bulky and regenerable. Only the synthesis, notes and bibliography are durable.

## Feeding it to a model

A Scan file is pasted whole. The three modes below are for a Pack.

The point of the exercise. Three modes, cheapest first:

1. **Principles only** — paste the "Applicable principles" section. ~2k tokens, covers most
   task-shaped uses ("review this against these principles").
2. **Synthesis** — the whole README. ~8k tokens. For anything needing the reasoning behind a principle.
3. **Synthesis + relevant notes** — add 2–4 note files by theme. For deep work in one area.

Both token figures are estimates from the reference run, not measured counts.

Design the principles section for this: **numbered, self-contained, imperative.** A principle that
needs surrounding context to parse will be dropped or misapplied when quoted alone.

Keep the grounded/speculative split *in* whatever you paste, or a model will state speculation as
fact and cite your document for it.

## Phase 7 (optional) — turn the research into a review lens pack

The highest-value downstream use: research that yielded durable principles can become permanent
review capability instead of a doc you have to remember to re-read. If the corpus produced a
**failure surface** — a way work goes wrong that no existing review would catch — read
`references/dd-lens-pack.md` and follow it.

## Gotchas

**YouTube caption tracks are not equivalent.** `--sub-langs "en.*"` pulls up to three tracks per
video. Plain `en` and `en-en` are unpunctuated ASR dumps (~2 punctuation marks per 1k chars).
**`en-orig` is the punctuated one** (~35 per 1k). Both rates were measured on one reference run
of a ~30-video channel, 2026-07. `en-orig` carries word-level timing tags that need stripping,
but sentence structure is intact and worth the extra parsing. Always compare a sample
across variants before cleaning the whole set; the wrong track costs you sentence boundaries.

**Auto-captions garble every proper noun.** On that same reference run one author's name rendered
four different ways across videos, and tool names mangled variously. **Correct names against the
description citations and links, never the transcript**, and put a warning in the synthesis so
nobody later quotes a hallucinated name.

**Cleaned transcripts are one long line, and file reads truncate them.** A 100k-char single-line
file hits the character cap and can't be paginated by line. Hard-wrap at ~110 chars when writing
the cleaned file — fixing it after the fact costs a second pass.

**Sandboxed exec tools don't persist to the host filesystem.** Anything you need afterwards must
be written with the real write tool (or a shell command that writes). Computing an aggregate in a
sandbox and printing it is fine; producing a file there is not.

**Long list-shaped output gets collapsed.** Printing 200+ lines of URLs can get archived into a
summary view and the content is lost. Write list-shaped output to a file and read it back.

## Roadmap

Extensions the reference run didn't need:

- **Books** — chapters as items; cross-reference the index and bibliography rather than
  descriptions. Expect a much denser citation graph per item.
- **Multi-corpus** — two authors on one topic. Add a "where they disagree" section to the
  synthesis; that's where the value concentrates.
- **Refresh** — re-run phases 1–3, diff the item list, write notes only for what's new. The
  synthesis needs a full re-read to stay coherent, so a refresh is only cheap for additive corpora.
