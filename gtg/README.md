# gtg: leave mid-task, pick it up cold days later

Walking away mid-task usually means re-explaining everything next session. Say "gtg" and the agent writes a handoff that a fresh session can resume from, with no re-explaining and no re-litigating.

## What gtg is

gtg (Got to Go) is a pause-and-resume skill for Claude Code and Codex, with a small CLI that keeps the records.

- **A handoff.** One markdown document per project: where you stopped, the one next action, decisions already made and open questions. Each checkpoint updates it in place, and git keeps the earlier versions.
- **An entry.** A small record that pins the handoff to your list, either active or shelved on the backlog.
- **The CLI.** The bookkeeping commands (list, shelve, complete, undo) run without a model, so they cost no tokens.
- **Progress records.** Optional per-task state for a long plan, covered in [progress.md](skills/gtg/references/progress.md).

## How it works

Say "gtg" mid-session. The agent names the project, writes the handoff and makes one CLI call from the worktree. The CLI adds what it can read from disk (your task list, this session's commits and the files touched), then commits the handoff and its entry.

In a new session, say "gtg <project>", or just "gtg" when one project is active. The CLI first pulls the latest store down from git, then prints the handoff, and the agent carries on from the next action. A name that fits several projects gets a pick list instead of a guess.

Entries stay until the work is finished. The agent completes one itself when a departure finds no next action left, or when a resumed session meets the project's goal, and `gtg undo` reverses that. When an entry goes quiet (active work untouched for 5 days, backlog for 14), a command asks you about it, one entry at a time.

## Install

Add the lm-tools marketplace as the [root README](../README.md) shows, then:

```
/plugin install gtg@lm-tools        # Claude Code
codex plugin add gtg@lm-tools       # Codex
```

Or copy `skills/gtg/` into your project or user `.claude/skills/` as a frozen copy that never updates. You need Node 18 or later and git on PATH.

## Where things live

Handoffs live in your repo, under `docs/handoffs/`, committed to your history. Set `GTG_HUB=<path to a git repo>` to keep one list for all your projects there instead. A `.gtg/forge.json` stores projects on a Forgejo or Gitea forge instead of files ([forge-store.md](skills/gtg/references/forge-store.md)).

Pin the record files in `.gitattributes`, or every command rewrites the whole store after a fresh clone on Windows:

```
docs/handoffs/active/*.json   -text
docs/handoffs/backlog/*.json  -text
```

## Commands

Say these to the agent. The agent runs the matching `gtg.mjs` command.

```
gtg                            leave (mid-session) or resume the only active project (session start)
gtg <project>                  resume a project at session start
gtg list | backlog             active entries | the shelf
gtg backlog <idea>             park a long-horizon idea
gtg back <slug> [--wake <date>]  shelve, optionally until a date
gtg active <slug>              reactivate
gtg complete <slug>            finished (legacy: remove, prune)
gtg supersede <slug> [--into <slug>]
gtg keep <slug>                answer a review question with "still live"
gtg rename <slug> <new> | unparent <slug>
gtg log | undo | stats | report
gtg progress init|show|list|update|add
```

`supersede` is for an entry rolled into another or filed in error, which is neither a ship nor an abandonment. `rename` re-points any sub-projects that named the old slug as their parent, and `unparent` clears one entry's parent. `log` reads what happened from git. `report` writes a JSON file that the `reporter` skill turns into an HTML habit-grid report. Full routing is in [commands.md](skills/gtg/references/commands.md).

## Extend it

Drop `.gtg/commands/<name>.mjs` into your repo and it becomes a real `gtg <name>` subcommand, no fork. Add `.gtg/after-handoff.mjs` or `.gtg/after-resume.mjs` to run your own steps on each departure or resume. Your `.gtg/` lives in your repo and updates never touch it. See [extending.md](skills/gtg/references/extending.md), which also documents the store and report formats.

## Details

- **Sync on resume.** `gtg resume` fast-forwards the hub from the current branch's upstream (`--ff-only`, 5 seconds). With no upstream set, it falls back to `$GTG_SYNC_REMOTE/$GTG_SYNC_BRANCH` (default `origin/main`), and only on that branch. It prints nothing unless it moved. A divergence says so on stderr and the resume carries on from local state. The forge store skips the sync.
- **Undo is scoped to your session.** Every gtg commit carries a `gtg-session:` trailer from `GTG_SESSION_ID`, else `CLAUDE_CODE_SESSION_ID`. Undo only reverts a commit with the calling session's id that is still at the tip of store history, and refuses otherwise. A session with no id cannot undo.
- **Completion verbs write different commit subjects**, and `stats` and `report` read those subjects. Using `complete` for rolled-up work records a phantom ship.
