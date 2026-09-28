# logical-research: research you can hand to a model

A summary gets read once and forgotten. logical-research reads your sources in full and writes context you can paste into a model later, with every claim graded and traced to where it came from.

## What it is

One skill that turns a question, or a bounded corpus (a YouTube channel, a book, a podcast back catalogue, a docs site, a set of papers), into a reusable file rather than a summary. It picks one of two tiers and tells you which.

| Tier | When | What you get |
|---|---|---|
| **Scan** (default) | a question, or under about eight sources | one graded file, `<root>/<slug>.md` |
| **Pack** | a bounded corpus you will return to | a synthesis, one note per item, and a bibliography, in `<root>/<slug>/` |

`<root>` defaults to `research/`. A Scan becomes a Pack when the source count passes the threshold or you say you will come back to the material.

Both tiers keep three rules:

- **Sources ranked by authority before reading.** A first-party statement beats commentary on it.
- **Every significant claim graded** as well-grounded, reasonably supported or explicitly speculative. Without the split, speculation passes as fact, and the split has to survive into whatever you paste into a model.
- **Every claim traceable** to the item it came from. Names are checked against citations, never transcripts, because auto-captions garble proper nouns.

## How it works

A Scan ranks the sources, reads each one in full, and writes one file: the question, the graded answer, the ranked sources, and any principles as numbered instructions.

A Pack runs six phases. The first three are mechanical: list the whole corpus, pull it, and clean it into prose while pulling out the bibliography. The fourth is the one that matters, and it is never handed to a script or a subagent. The agent reads every item in full, in corpus order, and writes one note each. Connections across items (the recurring citation, the argument that reverses later, the thesis restated three ways) only show up when one reader holds the whole corpus. Phase five writes the synthesis and phase six checks it.

It handles two kinds of corpus. An **authored** corpus is one mind across many items, like a channel or a back catalogue, and the value is the author's method. An **authoritative** corpus is many first-party sources on one question, like regulations, specs or official docs, and the value is which source outranks which. The synthesis reads differently for each, and the skill says which kind it assumed.

An optional seventh phase turns the research into a permanent review lens pack for the [due-diligence](../due-diligence/README.md) plugin, so the principles become review capability instead of a doc you have to remember to re-read.

## Install

Add the lm-tools marketplace as the [root README](../README.md) shows, then:

```
/plugin install logical-research@lm-tools        # Claude Code
codex plugin add logical-research@lm-tools       # Codex
```

Or copy the skill folder into a project's or your user `.claude/skills/`. A copy does not update with the plugin.

```
cp -r logical-research/skills/logical-research <your-repo>/.claude/skills/
```

Books, PDFs, docs sites and papers need nothing extra. YouTube and podcast corpora need Python 3 with `yt-dlp` (`python -m pip install yt-dlp`), which the skill runs as `python -m yt_dlp`.

## Using it

Ask in plain words:

```
research this channel for me
read all of these and synthesise
build me a knowledge pack on X
```

A Scan asks nothing. A Pack asks two questions before it starts reading, what shape the output should take and what the research is for, then runs on its own.

A single fact lookup with no synthesis is a search, not research. Anything that ranks sources or grades claims is at least a Scan. A corpus you can't list up front gets scoped down until you can.

## Extend it

The angle (what the research is for) becomes a section in every item note. Save one you reuse as `.lr/angles/<name>.md` in your repo and the skill reads it instead of you explaining it each run. See [extending.md](skills/logical-research/references/extending.md).

## Details

**Called by another skill.** Any skill can drive logical-research by handing it a corpus brief with the fields `slug`, `root`, `shape`, `tier`, `angle` and `corpus`. A field the brief answers is never asked about, and an incomplete brief only gets asked for its missing fields. The skill finishes by printing the output path, which is the return value. The caller links to that path rather than copying the contents out, so the research has one home. The skill knows nothing about who called it, so a caller that needs a different shape says so in `angle`. The brief format is in `SKILL.md`.

**Working files** (raw transcripts, JSON, cleaner scripts) stay in a scratch folder outside the repo. Only the synthesis, notes and bibliography are kept.
