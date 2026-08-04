# Got to Go (gtg) — pause and resume for Claude Code

> Part of the **[lm-tools](../README.md)** marketplace, which also ships [`due-diligence`](../due-diligence/README.md) — build-to-standard construction (`cdd`) + pre-ship adversarial review. Install either independently: `/plugin install gtg@lm-tools` or `/plugin install due-diligence@lm-tools`.

Say **"gtg"** when you have to leave mid-task: Claude writes a structured handoff
(what was done, where you stopped, the exact next action, decisions already made)
and pins it to a tracked list. Days later, say **"let's continue X"** in a fresh
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
| "gtg" (or any departure phrase) | Handoff written to `docs/handoffs/`, entry pinned, both committed |
| "let's continue <project>" | Handoff found, read, resumed from its Next Action; entry consumed |
| "gtg resume <n\|slug>" | Consume a handoff on pick-up — **not** a ship |
| "gtg stats" | A terminal snapshot: streak, shipped count, deepest project, effort, velocity |
| "gtg report" | Writes `docs/handoffs/_report.json`, then `/reporter` builds an HTML habit-grid report from it |
| "gtg list" | Active handoffs (idle >7d auto-shelf to the backlog) |
| "gtg backlog <idea>" | Park a long-horizon idea on the shelf |
| "gtg back <n\|slug>" / "gtg active <n\|slug>" | Shelf / reactivate an entry |
| "gtg remove <n>" / undo via "gtg undo" | Prune; git history is the undo stack, scoped to your own session |
| "gtg supersede <n\|slug> [--into <n\|slug>]" | Rolled up into another entry, or filed in error — neither a ship nor an abandonment |
| "gtg rename <n\|slug> <new>" | Change a slug, re-pointing any sub-projects that named it as their parent. Given a slug no entry carries, it repairs a stale `parent` reference instead, which is what a rename on the portfolio side leaves behind |
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
| **Bundled** | the plugin's `extensions/` | on by default (`gtg stats`, reattachment hooks) |
| **Yours** | `<storage-root>/.gtg/` | when you add a file |

Two extension points:

**1. CLI commands** — any subcommand the CLI doesn't recognize resolves to
`<storage-root>/.gtg/commands/<name>.mjs`, dynamically imported, default export called as
`fn(ctx)`:

```js
// .gtg/commands/hello.mjs
export default async ({ root, args, readStore, writeStore, commit, countHandoffFiles }) => {
  const data = readStore('docs/handoffs/_active.json'); // parsed JSON or null
  console.log(`hello from ${root}, ${data?.handoffs?.length ?? 0} active, args: ${args.join(' ')}`);
};
```

`ctx` = `{ root, args, readStore(path), writeStore(path, data), commit(paths, message), countHandoffFiles(slug) }`.
`countHandoffFiles(slug)` returns how many `docs/handoffs/*.md` files exist for that slug — the
same true-count fallback the CLI itself uses when an entry's `sessions` field is absent (legacy
entries), so an extension doesn't have to re-implement the file-count logic to avoid the same
hardcoded-`1` bug.

A command whose output's **first line** starts with `GTG-DIRECTIVE:` is not relayed to you —
the skill follows the instruction on that line instead. That lets a custom command hand control
back to a skill procedure rather than just printing, e.g.
`console.log('GTG-DIRECTIVE: resume my-project — read references/resume.md and follow it.')`
makes `gtg <yourverb> <arg>` resolve an argument to a slug and then run the real Resume Procedure,
consume step and hooks included, instead of reimplementing it.

**2. Procedure hooks** — the exit and resume flows load markdown hooks if present, so you
can add project-specific steps without forking the skill:

```
.gtg/skill/on-exit.md     # runs while the handoff is being written (may append to it / stage files)
.gtg/skill/on-resume.md   # runs while a handoff is being consumed
```

A hook is just instructions the model reads and follows. See the bundled examples in the
plugin's `extensions/skill/`.

**Resolution & precedence:** built-in commands always win. Otherwise **your** `.gtg/`
command overrides a bundled one of the same name (so you can replace `stats`). Hooks are
**additive** — the bundled hook runs, then yours.

**Update-safe by design:** your `.gtg/` lives in your own repo/hub, never inside the
plugin, and the CLI only ever *reads* it — a plugin update can't touch your files. The
extension surface (`ctx`, the `.gtg/` layout, hook load-points, resolution order) only
grows within a major version; a breaking change is a major version bump.

## Storage format

`docs/handoffs/_active.json` — `{"handoffs":[{...}]}`; `_backlog.json` the same
with key `backlog`. Handoff docs are plain markdown next to them.

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
`gtg list`, they never touch the store.

### Entry fields

Each entry in `docs/handoffs/_active.json` / `_backlog.json`:

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
