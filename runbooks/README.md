# runbooks: immediate intelligent context injection

Context is best fresh, relevant and detailed to the task. Runbooks give you that, on the prompt that needs it, without the cost of loading every document into every session.

## What a runbook is

A runbook is a short markdown file of concentrated, useful context. It tells an AI agent how to do one thing, or what rule to follow while doing it. You or your agent writes them (sold separately). Each one opens with a short header:

- **A title.** What it's called, like `# Restoring a backup`.
- **A type.** Which of five kinds it is (table below).
- **A purpose line.** One sentence saying what it's for and when it applies. This is the most important line, because the plugin reads nothing else when it decides whether the runbook is relevant.
- **Optional extras.** The command that runs it, the date someone last checked it was still true, and a note if it has been retired.

Under the header is the body: steps, rules, a table, whatever the job needs.

| Type       | In plain English                | Example                              |
| ---------- | ------------------------------- | ------------------------------------ |
| Procedure  | Steps you follow in order       | How to restore a backup              |
| Standard   | A rule you must not break       | Never print a password into the chat |
| Reference  | Something you look up           | Which server runs which app          |
| Residual   | Something left wrong on purpose | A known bug we decided to live with  |
| Postmortem | Something we tried that ended   | Why we stopped using X               |

The full format is in the `runbooks` skill, which fires when you write, retype, retire or lint a runbook.

## How the right runbook finds you

On every prompt, a fast, cheap model called Jev reads what you asked and scores each runbook's purpose line from 0 to 1. Any runbook scoring 0.8 or higher is named to the agent before it answers, up to six at a time. The agent opens the ones it needs, and the rest cost nothing.

To keep that check cheap, a word match (BM25) first cuts a big collection down to the 30 likeliest runbooks. Rules you must not break are never cut, so a word match can never hide one.

This matters most for standards. You go looking for a procedure because you know you're about to restore a backup. Nobody goes looking for a rule they don't know exists. The plugin brings that rule to you.

Residuals and postmortems work differently. When a session starts, the plugin lists them by name, one line each, so the agent knows what not to re-propose and what not to "fix".

If the scoring call can't run (no API key, no internet), the plugin says so rather than silently doing nothing.

## Install

Add the logical-tools marketplace as the [root README](../README.md) shows, then:

```
/plugin install runbooks@logical-tools        # Claude Code
codex plugin add runbooks@logical-tools       # Codex
```

Codex may ask you to trust the plugin's hooks once before they fire.

You need Node 20 or later and an OpenRouter key. The plugin reads the key from `OPENROUTER_API_KEY`, then from a line `OPENROUTER_API_KEY=...` in `~/.jev.env`. It has no other dependencies.

## Where your runbooks live

The plugin uses the first of these folders that exists:

1. the `RUNBOOKS_DIR` environment variable
2. `dir` in `.runbooks/config.json`
3. `docs/runbooks/` at the git top of the working directory
4. `~/docs/runbooks/`

With no folder found, the plugin does nothing, so installing it in a repo without runbooks costs nothing.

## Commands

`<plugin>` is the plugin's install folder.

```
node <plugin>/scripts/index.mjs --lint                     lint every header, exit 1 on a violation
node <plugin>/scripts/check.mjs <runbook.md> "<prompt>" ... [--not "<prompt>"] [--purpose "<text>"] [--record]
node <plugin>/scripts/check.mjs --changed [--dry]          re-score only purposes that moved
node <plugin>/scripts/router.mjs --selftest                offline router check, no API call
node --test <plugin>/test/*.test.mjs                       the plugin's tests
```

The router and `check.mjs` write API usage receipts to
`~/.local/state/jev-spend/calls.jsonl`. The jevtools command
`node <jevtools>/scripts/spend-report.mjs` breaks out active routing, purpose-line tests,
tools and sessions. Set `JEV_SPEND_LOG` to use another path. Old `claude-router/spend.jsonl`
rows remain readable as unclassified history.

`check.mjs` tests a purpose line before you commit it. Give it three or four prompts phrased the way a real task would arrive. Each must score 0.85, and each `--not` prompt must stay under 0.8. `--record` saves a passing run so `--changed` can skip it later.

## Extend it

Change the thresholds, add your own session-start lines, lint rules and writing rules, or tag runbooks by project to pack and retire them together. All of it lives in a `.runbooks/` folder you own, which updates never touch. See [extending.md](skills/runbooks/references/extending.md).

## Details

**The router** runs on every prompt (UserPromptSubmit).

- With more than 30 procedures, standards and references, BM25 keeps the top 30, padded to 30 even where a runbook scores zero. Every standard outside the top 30 is added back. Then it makes one `jev-latest` call on the OpenRouter System One endpoint, about $0.0004 a prompt.
- It injects each match by name, type and purpose.
- Retries fit inside a 4 second total budget. Only a timeout, a 5xx, a 429 or a network error is retried. When all of them fail, the router skips the API for 60 seconds and injects the notice straight away.
- A failure (no key, no network, a timeout, a bad response) injects a short notice saying routing is unavailable, why, and to read the runbooks folder directly.
- Once a key is set, a prompt under 12 characters, like "ok" or "yes", injects nothing. With no key, the failure notice fires on every prompt.
- A second copy of the hook on the same prompt exits before the API call.
- Spend, dedupe and outage logs go to `%LOCALAPPDATA%/claude-router/` on Windows and `~/.local/state/claude-router/` elsewhere.

**The index** runs at session start (SessionStart) and makes no API call. It names residuals, postmortems and top-level retired runbooks (as "do not re-propose"), one line each. Your nudges print after them.
