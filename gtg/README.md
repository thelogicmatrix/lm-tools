# Got to Go (gtg) — pause and resume for Claude Code

> Part of the **[lm-tools](../README.md)** marketplace, which also ships [`due-diligence`](../due-diligence/README.md) — build-to-standard construction (`cdd`) + pre-ship adversarial review. Install either independently: `/plugin install gtg@lm-tools` or `/plugin install due-diligence@lm-tools`.

Say **"gtg"** when you have to leave mid-task: Claude writes a structured handoff
(what was done, where you stopped, the exact next action, decisions already made)
and pins it to a tracked list. Days later, say **"gtg X"** in a fresh
session and it picks up cold — no re-explaining, no re-litigating.

Why this one, when several handoff skills exist:

1. **Terminal-level control.** `list` / `remove` / `back` / `active` / `undo` are
   zero-model CLI commands — bookkeeping costs no tokens and no agent turns.
2. **A framework, not a fixed format.** Drop `.gtg/commands/<name>.mjs` into your
   repo and it becomes a real subcommand of the installed CLI — no fork.
3. **Self-cleaning.** Resuming consumes the entry; entries idle 7+ days auto-shelf
   to a backlog. The active list only ever contains what's genuinely open.

## Install

**As a plugin (auto-updating):**
```
/plugin marketplace add thelogicmatrix/lm-tools
/plugin install gtg@lm-tools
```

**As a plain skill (static, no auto-update):** the skill is self-contained under `skills/gtg/`
(SKILL.md + the `gtg.mjs` CLI + `extensions/`) — copy that one folder into your project or
user `.claude/skills/`:
```
cp -r gtg/skills/gtg  <your-repo>/.claude/skills/
```
A frozen copy you commit to your own history that never updates from the marketplace. Your
own `.gtg/` extensions still live in your repo/hub, untouched either way.

Requires Node.js ≥ 18 and git on PATH.

## Use

| You say | What happens |
|---|---|
| "gtg" (or any departure phrase) | Handoff written to `docs/handoffs/`, entry pinned, both committed. One CLI call, run from the worktree: `--wip` checkpoints it first, an existing entry's slug is reused when the project name matches it (`--exact` to opt out), the next action is read from the body's `## Next Action`, the worktree from where you ran it, the task list and this session's commits from disk, and the writing harness is recorded (`--harness` to override) |
| "gtg <project>" at session start | One CLI call (`gtg resume <project>`) fast-forwards the hub from the current branch's upstream before reading anything - `branch.<b>.remote`/`branch.<b>.merge`, falling back to `obelisk-backup/master` when no upstream is set, and skipping a branch with neither (`--ff-only`, 5s, silent unless it actually moved; a divergence says so on stderr and the resume carries on locally), prints the handoff, consumes the entry and runs `.gtg/after-resume.mjs`; the session continues from the Next Action. Bare "gtg" with one active project does the same without naming it. A name that fits several projects, or a project sharing its name with a command, prints the candidates instead (exit 1) |
| "gtg resume <n\|slug>" | The same, by hand. Consuming is a pick-up, **not** a ship. `--keep` reads without consuming |
| "gtg <project>" as the first thing you say | Resumes that project. At session start a project name outranks an *extension* verb; if both exist (a project called `issues` **and** your own `gtg issues` command) you get a numbered pick list instead of a guess. Mid-session the verb wins, and core verbs (`list`, `report`, `stats`, …) are always commands |
| "gtg stats" | A terminal snapshot: streak, shipped count, deepest project, effort, velocity |
| "gtg report" | Writes `docs/handoffs/_report.json`, then `/reporter` builds an HTML habit-grid report from it |
| "gtg list" | Active handoffs (idle >7d auto-shelf to the backlog) |
| "gtg backlog <idea>" | Park a long-horizon idea on the shelf |
| "gtg back <n\|slug>" / "gtg active <n\|slug>" | Shelf / reactivate an entry |
| "gtg remove <n>" / undo via "gtg undo" | Prune; git history is the undo stack, scoped to your own session |
| "gtg supersede <n\|slug> [--into <n\|slug>]" | Rolled up into another entry, or filed in error — neither a ship nor an abandonment |
| "gtg rename <n\|slug> <new>" | Change a slug, re-pointing any sub-projects that named it as their parent. Given a slug no entry carries, it repairs a stale `parent` reference instead, which is what a rename on the portfolio side leaves behind |
| "gtg unparent <n\|slug>" | Clear one entry's `parent`, so it lists as standalone. `rename` re-**points** a parent, this **removes** one — re-pointing a dangling parent at the entry's own slug would only make it a self-parent |
| "gtg log [n\|slug]" | What happened, read from git rather than a ledger |

Handoffs live in *your repo* (`<repo>/docs/handoffs/`), committed to *your* history.

## Advanced: tracking multiple repos from one place

Set `GTG_HUB=<path>` (a git repo) and every gtg command stores its handoffs there
instead of the repo you're working in — one list across all your projects.

## Extending gtg

gtg has three tiers. You only ever touch the third.

| Tier | Lives in | Active |
|---|---|---|
| **Core** | the plugin's `gtg.mjs` + `SKILL.md` | always |
| **Bundled** | the plugin's `extensions/` | on by default (`gtg issues`, `gtg learn`, `gtg stats`, `gtg report`) |
| **Yours** | `<storage-root>/.gtg/` | when you add a file |

Two extension points:

**1. CLI commands** — any subcommand the CLI doesn't recognize resolves to
`<storage-root>/.gtg/commands/<name>.mjs`, dynamically imported, default export called as
`fn(ctx)`:

```js
// .gtg/commands/hello.mjs
export default async ({ root, args, ownEntries, readStore, writeStore, commit }) => {
  const { active, shelved } = ownEntries();                 // this command's own entries
  const session = readStore('docs/handoffs/_session.json'); // parsed JSON or null
  console.log(`hello from ${root}, ${active.length} active, args: ${args.join(' ')}`);
};
```

**Don't read the records through `readStore`.** It is a whole-file JSON reader and the records
live one per file since 3.1.0 (see *Storage format*). `readStore('docs/handoffs/_active.json')`
returns `null` since 3.3.0, because that packed file is deleted — and `?.handoffs ?? []` turns
`null` into an empty list, so a command reading it reports every live entry as missing with no
error anywhere. `ownEntries()` reads the sharded store; `readStore` is for genuine single-object
files like `_session.json`.

`ctx` = `{ root, args, readStore(path), writeStore(path, data), commit(paths, message), countHandoffFiles(slug), ownEntries() }`.
`countHandoffFiles(slug)` returns how many `docs/handoffs/*.md` files exist for that slug — the
same true-count fallback the CLI itself uses when an entry's `sessions` field is absent (legacy
entries), so an extension doesn't have to re-implement the file-count logic to avoid the same
hardcoded-`1` bug.

A command whose output's **first line** starts with `GTG-DIRECTIVE:` is not relayed to you —
the skill follows the instruction on that line instead. That lets a custom command hand control
back to a skill procedure rather than just printing, e.g.
`console.log('GTG-DIRECTIVE: run gtg.mjs resume my-project and follow SKILL.md\'s Resume Procedure.')`
makes `gtg <yourverb> <arg>` resolve an argument to a slug and then run the real Resume Procedure,
consume step and hooks included, instead of reimplementing it. Both bundled extensions use it:
`gtg issues <name>` and `gtg learn <topic>` resolve their argument and then hand off to the
skill's Resume Procedure.

`ownEntries()` returns `{ active, shelved }`, this command's own handoff entries, read from
`docs/handoffs/active/` and `docs/handoffs/backlog/` and filtered to the `parent` namespace it
owns — through the same reader the CLI uses, so it never sees the frozen packed file. Both shelves
every time, because `gtg list` auto-shelves anything idle over 7 days and an active-only read
would report a live package as missing. A command that owns no namespace gets two empty arrays.

**Extensions vs mods.** An *extension* owns entries in the handoff store and renders its own
separated list, so its entries are excluded from the bare `gtg list` and `gtg backlog` (and from
their counts) to avoid listing the same work twice. `issues` and `learn` are extensions, owning the
`issues` and `learning` parent namespaces. A *mod* owns no entries and only adds a view, so it
sees the whole store: `stats` and `report` are mods and their counts stay whole-store totals.
Adding a third extension is one line in the `EXTENSIONS` map in `gtg.mjs`, and that is the
whole of it: an extension is a registered `parent` namespace and nothing more. **It must not
add a field to the entry.** Membership is read off the existing `parent` field precisely
because `gtg handoff` rebuilds each entry as a fresh literal and drops fields it does not
know, so a marker field of your own would survive exactly until the next wrap and then go
missing with no error.

**Seed documents live in `skills/gtg/templates/`.** An extension whose data lives in a folder
of the user's own needs that folder to explain itself on a fresh install, so the plugin ships
the starting document rather than pointing at a file that may not exist. `gtg:issues` copies
`templates/issues-README.md` to `docs/issues/README.md` the first time it files into a folder
without one, and never overwrites an existing one, because that file is the folder's own
conventions and whoever wrote it outranks the template.

**Decluttering is not lookup.** Only the *bare* listing hides extension entries. `gtg list
<name-or-slug>` is you naming what you want, so it searches every entry and will surface an issue
package or a learning sprint. A queried extension entry is labelled with its slug instead of a row
number, because row numbers index the bare listing and that is the order `gtg back <n>` resolves
against. Use the slug, which every verb accepts, and which is what the bring-back hints print for
these entries for the same reason.

A targeted query also reaches a **shelved** extension entry, printed as its own `shelved:` line
rather than as a numbered row, since it is not active work, and printed whether or not the same
query also matched active work. That case is not an edge: an issue
package sits idle between fix sessions, so the 7-day auto-shelf catches it routinely, and without
this the exit procedure's reuse probe would go blind again the moment a package was parked. This is
deliberately narrower than the general rule that `gtg list` never shows backlog items: a shelved
*normal* project is still invisible to a query, because widening that is a behaviour change rather
than a fix.

**2. Procedure hooks** — two script hooks, one per direction:

```
.gtg/after-handoff.mjs    # default export fn(ctx), runs after `gtg handoff` has committed
.gtg/after-resume.mjs     # default export fn(ctx), runs after `gtg resume` has printed + consumed
```

There are no markdown hooks any more (2.0.0 removed `.gtg/skill/on-exit.md`, 3.0.0 removed
`on-resume.md`): checking for one cost a tool turn every time, and anything they did is
either mechanical (belongs in the script) or already in the handoff body. The resume hook's
`ctx` is `{ root, entry, file, body, kept, readStore, writeStore, commit }`; `kept` is true
under `--keep`. On exit the CLI itself
appends what the machine knows and the model used to type: a `## Task list` read from the
harness's task store (Claude Code: `<config dir>/tasks/<session id>/`), and, for a project in
its own worktree, `## Commits this session` and `## Files touched` from its git log since the
session started. A body that already carries a section of the same name keeps its own.

`ctx` = `{ root, entry, file, body, worktree, readStore, writeStore, commit }` — the entry
just written, the handoff's path and body, and the same store helpers commands get. This
is where a derived `docs/sessions/` entry or a portfolio-row flip belongs: zero model
tokens, and it cannot be skipped in a hurry. A throwing hook is reported on stderr and
sets the exit code; the handoff itself is already committed and stays so.

**Resolution & precedence:** built-in commands always win. Otherwise **your** `.gtg/`
command overrides a bundled one of the same name (so you can replace `stats`).

**Update-safe by design:** your `.gtg/` lives in your own repo/hub, never inside the
plugin, and the CLI only ever *reads* it — a plugin update can't touch your files. The
extension surface (`ctx`, the `.gtg/` layout, hook load-points, resolution order) only
grows within a major version; a breaking change is a major version bump.

## Storage format

**One file per entry, since 3.1.0.** `docs/handoffs/active/<slug>.json` and
`docs/handoffs/backlog/<slug>.json` each hold a single entry object, serialised
`JSON.stringify(entry, null, 2) + '\n'` with no wrapper key. Handoff docs are plain markdown in
`docs/handoffs/` itself, as before.

A packed array made every write rewrite the whole file, so two machines editing unrelated
projects still collided on the same bytes, and a JSON array conflict has no semantic merge. One
file per entry makes unrelated edits disjoint, and a same-project fork conflicts on one small
file, which is correct.

Each directory also holds a `.gitkeep`. Git cannot track an empty directory, and an emptied
collection — the last active entry consumed, or everything parked — has to survive as an *empty*
collection: without the keeper the directory is simply absent on the other machine's checkout,
which reads as a store that was never created rather than one deliberately emptied.

`docs/handoffs/_active.json` (`{"handoffs":[...]}`) and `_backlog.json` (key `backlog`) were the
packed files this replaced. **Both are deleted as of 3.3.0, along with the self-migration and
the fallback that read them.** A directory is now the whole store, and an absent directory is a
fresh hub rather than a tree waiting to be migrated. Rolling back to a pre-3.1.0 plugin means
restoring a packed file from git history — `git show <pre-shard-commit>:docs/handoffs/_active.json`
— and installing that plugin; the snapshot is the state at the shard, so records written after
it stay in the directory's own history. To migrate a still-packed tree, install 3.1.0–3.2.0
once and let it shard, then upgrade.

Pin the record files as-is in `.gitattributes`:

```
docs/handoffs/active/*.json   -text
docs/handoffs/backlog/*.json  -text
```

The `-text` line is correctness, not tidiness. A write is skipped when the file's bytes already
equal the record's serialisation, so under a `text=auto` rule every record reads as changed after
a fresh clone on Windows and every command rewrites the whole store — losing exactly the
per-record isolation the sharding exists to deliver.

## Report JSON (`gtg report`)

`gtg report` writes `docs/handoffs/_report.json` (override with `--json <path>`) —
a regenerable derivative, not tracked state (gitignore it). Every figure is
computed by `extensions/lib/history.mjs` from the git log and the handoff files;
nothing is inferred by a model. Top-level keys:

| Key | What |
|---|---|
| `historyAvailable` | false when not in a git repo — sections degrade rather than lie |
| `counts` | active / backlog |
| `habit` | activity grid, current & longest streak, weekday & hour distribution |
| `throughput` | shipped (total/7d/30d), parked, resumed, ship rate, days-to-ship |
| `effort` | from committed `duration_min`: `total` minutes, `bySlug`, `hoursBySlug`, `hoursByWeek`, `avgSessionMin`, `longestSessionMin`. Counts handoff commits only — a `gtg activate`/`undo` re-adds an entry unchanged and must not re-bill the session. Accrues over time, empty at first |
| `families` | per-parent rollup: sub-projects, shipped, active, sessions, `totalHours`, first & latest activity |
| `perProject` | one row per project: born, last seen, sessions, minutes, worktree, days alive, days-to-ship, status |
| `health` | resurrection & abandonment rate, WIP-over-time, aging |
| `fun` | best week, longest-lived shipped project, most-resumed, velocity label |

`gtg stats` prints a few of these as terminal lines. Both are read-only — unlike
`gtg list`, they never touch the store. Both are mods, so their `counts.active`
covers every entry including the extension namespaces, which is why it can read
higher than the number of rows `gtg list` shows.

### Entry fields

Each entry in `docs/handoffs/active/<slug>.json` / `docs/handoffs/backlog/<slug>.json`:

| Field | Set by | Meaning |
|---|---|---|
| `project` | `--project` | display name |
| `slug` | `--slug` | stable id; also the handoff filename suffix |
| `sessions` | auto | how many handoffs this slug has, counted from files on disk |
| `created` | auto | first handoff's date, carried forward across parks and reactivations |
| `worktree` | `--worktree` | where the work lives; the literal `repo root` if in the storage repo |
| `branch` | `--branch`, else detected **in the worktree** | the project's branch, not the hub's |
| `parent` | `--parent`, else inferred from `docs/projects/INDEX.md` | family page slug; absent means standalone |
| `duration_min` | auto | session length from `_session.json`; absent when unknown or stale |
| `harness` | `--harness`, else detected from the environment | who wrote the last handoff (`claude`, `codex`, …); shown on the `list` row; absent on pre-1.11 entries |
| `eta` | `--eta` | rough time remaining on the next action |
| `next` | `--next` | the one concrete next action |
| `file` | auto | path to the handoff document |
| `updated` | auto | last touch; drives the 7-day auto-shelf |

**`phase` was removed in 1.3.0.** Entries written by older versions keep the key;
it is ignored on read and never rewritten. `sessions` and `created` backfill from
the handoff files already on disk, so no migration is needed.

**`gtg resume <n|slug>` vs `gtg remove <n|slug>` vs `gtg supersede <n|slug>`** —
`resume` consumes a handoff when you pick a project back up, `remove` (alias
`prune`) means it shipped, and `supersede` means it was rolled up into another
entry or filed in error. They commit different subjects, which is what makes the
git log a usable history. Borrowing the wrong one writes a phantom ship or a
phantom abandonment, and the stats read straight off those subjects.

**`gtg undo` reverts your own last change, not the newest one.** Every gtg commit
carries a `gtg-session:` trailer (from `GTG_SESSION_ID`, or `CLAUDE_CODE_SESSION_ID`
under Claude Code), and undo will only revert a commit bearing the calling session's
id *and* still sitting at the tip of store history. Anything else refuses and names
what it found. Two sessions sharing one checkout is the normal setup, and undo used
to revert whichever of them committed last. A session with no id set cannot undo.
