---
name: logical-research
description: Use when turning a bounded body of source material — a YouTube channel, a book, a podcast back catalogue, a docs site, a set of papers — into reusable context rather than answering a one-off question. Triggers on "research this channel/author/book", "read the whole corpus", "build me a knowledge pack on X", "go through all of these and synthesise", or when a later task needs principles extracted from source material and every claim traceable. Not for a single question — that's a search.
---

# Logical Research

## Overview

Turn a bounded corpus into **actionable context**: a synthesis doc, per-item notes, and a
bibliography, structured so it can be fed to a model as working context for a later task.

The output is **not a summary**. It's a reusable knowledge artifact: original analysis with
claims graded by evidence strength, principles extracted as instructions, and every source
traceable back to the item it came from.

## When to use

All three must hold:

- The corpus is **bounded and enumerable** — a channel, an author's works, a doc set. Not "everything about X".
- You'll **return to it more than once**, or want to hand it to a model later.
- The value is in **cross-item synthesis**, not any single item.

Don't use it for a one-off question — that's a search. Don't use it for a corpus you can't
enumerate up front; scope it down until you can.

## Front-load exactly two questions

Ask these before phase 4, batched, then run autonomously:

1. **Doc shape** — synthesis only, synthesis + per-item notes, or those plus retained raw text?
2. **Angle** — what is the research *for*? This becomes a named section in every item note.

Everything else — corpus boundaries, which items are primary, how to bucket the bibliography —
is a judgment call. Make it and say what you decided.

## Pipeline

Six phases. 1–3 are mechanical and cheap. **Phase 4 is the expensive one and cannot be skipped
or delegated.**

### 1. Scope — establish the corpus before committing

Enumerate everything and get a word count *first*. This decides whether the job is one session
or several.

```bash
# YouTube channel → full inventory as JSON
python -m yt_dlp --flat-playlist --dump-single-json --no-warnings \
  "https://www.youtube.com/channel/<ID>/videos" > channel.json
```

Then compute item count, total duration, total words, median length.

| Corpus size | Approach |
|---|---|
| < 150k words | One session, read everything |
| 150k–400k | Split by theme across sessions; write notes as you go, synthesise last |
| > 400k | Narrow the scope, or sample deliberately **and say so in the output** |

**Flag non-primary items now** — reuploads, guest content, anything not the author's own work.
Those get factual notes, not principle extraction. Mislabelling them contaminates the synthesis.

### 2. Acquire

**YouTube** — `yt-dlp`, with `--write-info-json` (the descriptions are the bibliography source):

```bash
python -m yt_dlp --skip-download --write-subs --write-auto-subs \
  --sub-langs "en.*" --sub-format vtt --write-info-json --sleep-requests 1 \
  -o "subs/%(playlist_index)02d-%(id)s.%(ext)s" "<channel-url>/videos"
```

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
  properties); the rest are real citations. This list is often as valuable as the corpus.
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

## [Angle]          ← the angle the user named up front
## Sources          ← citations from this item
```

**Read everything before writing the synthesis.** It is tempting to write notes and synthesis in
one pass; don't. The strongest cross-cutting themes typically only become visible two-thirds of
the way through.

If the repo has `.lr/angles/*.md`, read the ones matching the requested angle and let them shape
the angle section — that's your own extension tier (see the plugin README).

### 5. Synthesise

The main doc:

1. **Why this corpus is worth the time** — what distinguishes it. Specific and falsifiable.
2. **The author's method** — often the most transferable thing, and rarely stated by them explicitly.
3. **Core theses** — 5–10, each with supporting evidence *and* the counter-case the author raises.
4. **Applicable principles** — the extract. Numbered, grouped, phrased as instructions. **This is
   the section a model will actually consume.**
5. **Grounded vs speculative** — split every significant claim into well-grounded / reasonably
   supported / explicitly speculative. **Non-negotiable.** Without it the doc launders speculation
   into fact, and in three months nobody remembers which was which.
6. **Reading order** — what to consume if not all of it.

### 6. Verify

- Every internal link resolves — slugs in the synthesis must match the filenames actually written.
- Every claim attributed to the author is theirs, not your inference.
- Names and technical terms checked against **citations, not transcripts** (see gotchas).
- The grounded/speculative split is honest, including where that's unflattering.

## Output shape

```
research/<slug>/
  README.md          synthesis — themes, principles, evidence grading
  links.md           bibliography, grouped by theme
  notes/README.md    index table + by-theme groupings
  notes/NN-slug.md   one per item
```

Working files — raw transcripts, JSON, cleaner scripts — stay in a scratch directory **outside
the repo**. They're bulky and regenerable. Only the synthesis, notes and bibliography are durable.

## Feeding it to a model

The point of the exercise. Three modes, cheapest first:

1. **Principles only** — paste the "Applicable principles" section. ~2k tokens, covers most
   task-shaped uses ("review this against these principles").
2. **Synthesis** — the whole README. ~8k tokens. For anything needing the reasoning behind a principle.
3. **Synthesis + relevant notes** — add 2–4 note files by theme. For deep work in one area.

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
**`en-orig` is the punctuated one** (~35 per 1k) — it carries word-level timing tags that need
stripping, but sentence structure is intact and worth the extra parsing. Always compare a sample
across variants before cleaning the whole set; the wrong track costs you sentence boundaries.

**Auto-captions garble every proper noun.** On the reference run one author's name rendered four
different ways across videos, and tool names mangled variously. **Correct names against the
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
