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
| "gtg list" | Active handoffs (idle >7d auto-shelf to the backlog) |
| "gtg backlog <idea>" | Park a long-horizon idea on the shelf |
| "gtg back <n\|slug>" / "gtg active <n\|slug>" | Shelf / reactivate an entry |
| "gtg remove <n>" / undo via "gtg undo" | Prune; git history is the undo stack |

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
export default async ({ root, args, readStore, writeStore, commit }) => {
  const data = readStore('docs/handoffs/_active.json'); // parsed JSON or null
  console.log(`hello from ${root}, ${data?.handoffs?.length ?? 0} active, args: ${args.join(' ')}`);
};
```

`ctx` = `{ root, args, readStore(path), writeStore(path, data), commit(paths, message) }`.

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

`docs/handoffs/_active.json` — `{"handoffs":[{project, slug, phase, tier, next, file, updated}]}`;
`_backlog.json` the same with key `backlog`. Handoff docs are plain markdown next to them.
