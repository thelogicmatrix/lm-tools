# jevtools: primitive tools made for big work

Some text is too long or too costly for your agent to read in full. jevtools has a fast, cheap model read it first and hands back only the parts worth your agent's attention.

## What it is

Jev is a judgement model (`jev-latest` on OpenRouter). It answers typed questions about a text, such as a yes-or-no probability, a score or a pick from a list, and writes no text of its own. Code splits the text and asks the questions. Jev judges each part. You read only what it flags.

- **jevchecker** (a skill). Sweeps a large body for a criterion a regex cannot express and returns a ranked shortlist. It ships one sweep, which checks a tailored resume bullet by bullet against the resume it came from.
- **jevclick.** Picks the element to click from a browser accessibility snapshot, so the agent never reads the snapshot.
- **jevmail.** Tags a mailbox window from postman (rejection, interview invite, needs a reply and so on), or finds the message and link that answer a plain-English question. It refuses the `work` identity in code, before anything is read or sent.
- **jevmail.triage.** Turns jevmail's tags into a filing plan and a digest of what needs a person. It proposes and never files.
- **jevclassify.** Labels every repo on a Forgejo server from its metadata. It reads the server from `FORGEJO_URL` and the token from the Forgejo CLI's `keys.json`.
- **jevdrift.** Finds rules stated in two markdown files that disagree.
- **jevescalate** (a library). Sends only the answers Jev was unsure of to a bigger model for a second opinion.

A hit is a signal, never a verdict. Read the flagged part before acting on it.

## Install

Add the logical-tools marketplace as the [root README](../README.md) shows, then:

```
/plugin install jevtools@logical-tools        # Claude Code
codex plugin add jevtools@logical-tools       # Codex
```

You need Node 20 or later and an OpenRouter key, read from `OPENROUTER_API_KEY` or from a line `OPENROUTER_API_KEY=...` in `~/.jev.env`. jevmail's search also needs Python and the postman plugin in the same logical-tools checkout.

## Commands

`<plugin>` is the plugin's install folder. Each script's options are in its header comment.

```
node <plugin>/skills/jevchecker/jevchecker.mjs <body> --sweep <sweep.json> [--source <file>]
node <plugin>/scripts/jevclick.mjs --snapshot <file> --goal "<what to click>"
node <plugin>/scripts/jevmail.mjs --ask "<question>" --identity <id> --query "<gmail query>"
node <plugin>/scripts/jevclassify.mjs > repos.md
node <plugin>/scripts/jevdrift.mjs --root docs
node <plugin>/scripts/<script>.mjs --selftest       offline check, no API call
node --test <plugin>/skills/jevchecker/jevchecker.test.mjs
```

## Extend it

A new jevchecker sweep is one JSON file in `skills/jevchecker/sweeps/`. The format and how to word a check are in the jevchecker skill.

## Details

- Every call goes to OpenRouter's System One endpoint with a 60 second timeout. `scripts/lib.mjs` holds the shared key lookup and call.
- jevdrift and `exp-choice-scale.mjs` (the experiment that sized jevclick) read the key from `OPENROUTER_API_KEY` only, not from `~/.jev.env`.
- jevclick says to click only at 0.95 confidence or higher. Below that it says to hand the snapshot to the agent instead. With `--json` it exits 0 on ACT, 2 on HOLD and 3 when the Jev call failed.
- jevmail's search stops before any call when the narrowing still matches more than 60 messages.
- jevchecker exits 0 whenever the sweep ran, whatever it found, so it cannot serve as a gate.
- jevclassify looks for the Forgejo CLI's `keys.json` under `%APPDATA%`, so it runs on Windows.
- Before 2026-09-24 these scripts lived in a private monorepo as `scripts/jev-sweep/` and `.claude/skills/jevchecker/`.
