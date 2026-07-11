# gtg — pause and resume for Claude Code

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

```
/plugin marketplace add <github-owner>/gtg-skill
/plugin install gtg@gtg-marketplace
```

Requires Node.js ≥ 18 and git on PATH.

## Use

| You say | What happens |
|---|---|
| "gtg" (or any departure phrase) | Handoff written to `docs/handoffs/`, entry pinned, both committed |
| "let's continue <project>" | Handoff found, read, resumed from its Next Action; entry consumed |
| "gtg list" | Active handoffs (idle >7d auto-shelf to the backlog) |
| "gtg backlog <idea>" | Park a long-horizon idea on the shelf |
| "gtg back <n\|slug>" / "gtg active <n\|slug>" | Shelf / reactivate an entry |
| "gtg remove <n>" / undo via "gtg undo" | Prune; git history is the undo stack |

Handoffs live in *your repo* (`<repo>/docs/handoffs/`), committed to *your* history.

## Advanced: tracking multiple repos from one place

Set `GTG_HUB=<path>` (a git repo) and every gtg command stores its handoffs there
instead of the repo you're working in — one list across all your projects.

## Extending gtg

Any subcommand the CLI doesn't recognize falls through to
`<storage-root>/.gtg/commands/<name>.mjs` — dynamically imported, default export
called as `fn(ctx)`:

```js
// .gtg/commands/hello.mjs
export default async ({ root, args, readStore, writeStore, commit }) => {
  const data = readStore('docs/handoffs/_active.json'); // parsed JSON or null
  console.log(`hello from ${root}, ${data?.handoffs?.length ?? 0} active, args: ${args.join(' ')}`);
};
```

`ctx` = `{ root, args, readStore(path), writeStore(path, data), commit(paths, message) }`.
**Stability contract:** post-v1 this shape only grows — new optional fields, never
removed or repurposed ones. A breaking change to `ctx` is a major version bump.
Built-in names always win; an extension can't shadow `list` or `remove`.

## Storage format

`docs/handoffs/_active.json` — `{"handoffs":[{project, slug, phase, tier, next, file, updated}]}`;
`_backlog.json` the same with key `backlog`. Handoff docs are plain markdown next to them.
