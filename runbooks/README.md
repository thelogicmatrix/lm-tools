# runbooks: typed runbooks that find the session

A folder of runbooks only helps when the session knows which one applies. Listing them all at
session start pays for every file in every session, and a rule you break without suspecting a
document covered it never gets looked up. `runbooks` asks the question per prompt instead. One
cheap model call scores each runbook's purpose line against the task and injects only the
matches.

**Never put customer data in a runbook.** Every prompt and every purpose line is sent to
OpenRouter.

## Install

Add the lm-tools marketplace as the [root README](../README.md) shows, then:

```
/plugin install runbooks@lm-tools        # Claude Code
codex plugin add runbooks@lm-tools       # Codex
```

Codex may ask you to trust the plugin's hooks once before they fire.

Node 20 or later, the version CI runs. No dependencies. The router needs an OpenRouter key, read from
`OPENROUTER_API_KEY` first, then from `~/.jev.env` as a line `OPENROUTER_API_KEY=...`.

## Where your runbooks live

The runbooks folder is the first of these that exists:

1. the `RUNBOOKS_DIR` environment variable
2. `dir` in `.runbooks/config.json`
3. `docs/runbooks/` at the git top of the working directory
4. `~/docs/runbooks/`

With no runbooks folder found, both hooks print nothing. Installing the plugin in a repo
without runbooks costs nothing.

Each runbook is a markdown file with a typed header. The format, the five genres and the
process are in the `runbooks` skill, which fires when you write, retype, retire or lint one.

## What the hooks do

**The router** runs on every prompt (UserPromptSubmit).

- It reads the procedures, standards and references. With more than 30, it ranks them
  against the prompt by a local BM25 word match and keeps the top 30, padded to 30 even where a
  runbook scores zero. Every standard outside the top 30 is added back, because a rule you must
  not break can share no words with the task. Only procedures and references are ever cut. Then it makes one `jev-latest` call
  on the OpenRouter System One endpoint. That costs about $0.0004 a prompt.
- It injects every runbook scoring 0.8 or higher, at most six, by name, type and purpose.
- A retry fits inside a 4 second total budget. Only a timeout, a 5xx, a 429 or a network
  error is retried.
- It fails loud. No key, no network, a timeout or a bad response each inject a short notice
  that routing is unavailable, why, and to read the runbooks folder directly. Nothing is
  hidden silently.
- Once a key is set, a prompt under 12 characters injects nothing. It is a continuation like "ok"
  or "yes". With no key the fail notice fires on every prompt, short ones included.
- A second copy of the hook on the same prompt exits before the API call.
- Spend and dedupe logs go to `%LOCALAPPDATA%/claude-router/` on Windows and
  `~/.local/state/claude-router/` elsewhere.

**The index** runs at session start (SessionStart). It makes no API call. It names the
runbooks a prompt cannot route, one line each: residuals, postmortems, and top-level retired
tombstones as "do not re-propose". Your nudges print after them.

## The commands

```
node <plugin>/scripts/index.mjs --lint                     lint every header, exit 1 on a violation
node <plugin>/scripts/check.mjs <runbook.md> "<prompt>" ... [--not "<prompt>"] [--purpose "<text>"] [--record]
node <plugin>/scripts/check.mjs --changed [--dry]          re-score only purposes that moved
node <plugin>/scripts/router.mjs --selftest                offline router check, no API call
node --test <plugin>/test/*.test.mjs                       the plugin's tests
```

`<plugin>` is the plugin's install folder. `check.mjs` scores a purpose line through the live
router path, one call a prompt. Each task prompt must reach 0.85 and each `--not` prompt must
stay under 0.8. `--record` saves a passing run to the ledger so `--changed` can skip it later.

## Extend it

Your tier is a `.runbooks/` folder. It resolves at the git top of the working directory
first, then the working directory, then `~/.runbooks/`. The first one found wins, and the
folders are never merged. The plugin only reads it.

### 1. `.runbooks/config.json`

Every key is optional.

| Key | Default | What it sets |
|---|---|---|
| `dir` | `docs/runbooks` at the git top, then `~/docs/runbooks` | the runbooks folder |
| `firesAt` | `0.8` | the score a runbook needs to be injected |
| `writeBar` | `firesAt + 0.05`, so `0.85` | the score `check.mjs` needs from each task prompt |
| `maxInject` | `6` | the most runbooks injected on one prompt |
| `shortlist` | `30` | how many top-ranked runbooks the word match keeps, before every standard is added back |
| `ledger` | `<dir>/.router-ledger.json` | where `check.mjs --record` writes |

Relative paths in `dir` and `ledger` resolve from the folder that holds `.runbooks/`.
`RUNBOOKS_DIR` beats `dir`.

```json
{ "dir": "docs/ops", "maxInject": 4 }
```

### 2. `.runbooks/nudges/<name>.mjs`

A line of your own at session start. The default export takes `ctx` and returns a string, or
null for nothing. It may be async. `ctx` is `{ root, dir, entries }`: the `.runbooks/` path,
the runbooks folder and one parsed header per runbook (`slug`, `type`, `status`, `purpose`,
`run`). All nudges run in parallel under a shared 1.2 second deadline. A throw or a timeout
drops that nudge only.

```js
// .runbooks/nudges/no-purpose.mjs
export default function ({ entries }) {
  const bare = entries.filter((e) => !e.purpose).map((e) => e.slug);
  return bare.length ? `Runbooks with no purpose line: ${bare.join(", ")}` : null;
}
```

### 3. `.runbooks/lint/<name>.mjs`

A rule of your own for `index.mjs --lint`. The default export takes `{ slug, text, header }`
and returns a list of violation strings. They print and count like the core violations. A rule
that throws or returns something other than a list adds nothing.

```js
// .runbooks/lint/owner.mjs
export default function ({ slug, text, header }) {
  if (header.type !== "procedure") return [];
  return /^## Owner\s*$/m.test(text) ? [] : [`${slug}: procedure with no ## Owner section`];
}
```

### 4. `.runbooks/standard/<name>.md`

Writing rules of your own. The skill reads these alongside its bundled references
(`format.md`, `lifecycle.md`, `purpose-lines.md`, `extending.md`). A file with the same name overrides the
bundled one, and a new name adds to the set.

```markdown
<!-- .runbooks/standard/house-style.md -->
# House style

Test prompts are phrased the way the on-call engineer types them, never in the runbook's words.
```
