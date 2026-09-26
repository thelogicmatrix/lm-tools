# Extending runbooks

Your tier is a `.runbooks/` folder. The plugin only reads it, so an update never touches it.

## Where `.runbooks/` is found

The first of these that is a folder wins. Folders are never merged.

1. `.runbooks/` at the git top of the working directory
2. `.runbooks/` in the working directory itself
3. `~/.runbooks/`

Outside a git repo, or with git unavailable, the working directory stands in for the git top.

## Where the runbooks folder is found

The first of these that exists as a folder wins. A missing candidate is skipped.

1. the `RUNBOOKS_DIR` environment variable
2. `dir` in `.runbooks/config.json`
3. `docs/runbooks/` at the git top of the working directory
4. `~/docs/runbooks/`

With none found, both hooks print nothing, and the lint and `check.mjs` exit with an error.

## 1. `config.json`

Every key is optional. A missing or unreadable file, or one that is not a JSON object, counts as
empty.

| Key | Default | What it sets |
|---|---|---|
| `dir` | see above | the runbooks folder |
| `firesAt` | `0.8` | the score a runbook needs to be injected |
| `writeBar` | `firesAt + 0.05`, so `0.85` | the score `check.mjs` needs from each task prompt |
| `maxInject` | `6` | the most runbooks injected on one prompt |
| `shortlist` | `30` | how many top-ranked runbooks the word match keeps, before every standard is added back |
| `ledger` | `<runbooks folder>/.router-ledger.json` | where `check.mjs --record` writes |
| `projects` | unset | allowed project slugs for lint, local packs, and retirement |

A relative `dir` or `ledger` resolves from the folder that holds `.runbooks/`. A relative
`RUNBOOKS_DIR` resolves from the working directory. A `writeBar` below `firesAt` counts as unset.

## 2. `nudges/<name>.mjs`

A line of your own at session start, printed after the tails. The default export is a function
`fn({ root, dir, entries })`:

- `root` is the `.runbooks/` path, `dir` the runbooks folder.
- `entries` holds one parsed header per top-level runbook: `slug`, `type`, `status`, `purpose`,
  `run` and `order`.
- It returns a string to print, or null for nothing. It may be async.

All nudges start at once under a shared 1.2 second deadline, and the deadline counts their import
time too. A throw, a non-string or a nudge still pending at the deadline drops that nudge only. So
keep any timeout inside a nudge, a network call's included, well under 1.2 seconds, or the nudge is
dropped before its own timeout can fire. An import still pending at the deadline drops every
nudge, so keep slow work out of a module's top level. A file that throws on import, or whose
default export is not a function, is skipped, and so is any `*.test.mjs`, here and in `lint/`.

## 3. `lint/<name>.mjs`

A rule of your own for `index.mjs --lint`, run once per runbook. The default export is a function
`fn({ slug, text, header })`:

- `slug` is the file name without `.md`, `text` the whole file.
- `header` is the parsed header: `type`, `status`, `purpose`, `run` and `order`.
- It returns a list of violation strings. They print and count like core violations, so start
  each with the slug, as the core ones do.

A rule that throws or returns something other than a list adds nothing, so one broken rule never
hides the core violations.

## 4. `standard/<name>.md`

Writing rules of your own. Read every `standard/*.md` alongside this skill's `references/`. A
file with the same name as a bundled reference (`format`, `lifecycle`, `purpose-lines`,
`extending`) overrides it. A new name adds to the set.
