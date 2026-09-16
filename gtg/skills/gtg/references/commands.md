# gtg — Commands and routing

Everything `gtg <verb>` does other than depart or resume. Loaded only when SKILL.md's last routing row
fires (a verb the zero-model row does not cover). `gtg.mjs` = `node "${CLAUDE_PLUGIN_ROOT}/skills/gtg/gtg.mjs"`.

Contents: Trigger semantics · Router table · Extension entries · Working a package · Backlog Park.

## Trigger semantics

Brackets `[]` are the explicit project override, required only where a bare token would
otherwise read as a verb.

| Context | Input | Meaning |
|---|---|---|
| Session start (message is *only* `gtg…`) | `gtg` | Resume mode (SKILL.md Resume Procedure): `gtg.mjs resume` with no argument |
| Session start | `gtg <project>` | Resume that project (`gtg.mjs resume <project>`; brackets optional) |
| Mid-session | `gtg` | Depart (SKILL.md Exit Procedure), slug inferred from context |
| Mid-session | `gtg [project]` | Depart, **force the handoff slug** to `project` (`--exact`) |
| Anytime | `gtg <core verb>` | Route per the table below. A **core verb** (`list`, `backlog`, `back`, `active`, `prune`, `remove`, `complete`, `supersede`, `peek`, `resume`, `rename`, `unparent`, `log`, `report`, `stats`, `undo`, `help`) always routes to its command, never to a project |

Disambiguation, in this order:

1. A bracketed token is always a project.
2. A core verb is always that command; a project sharing the name never shadows it, so
   `gtg report` reports even with a "Report & Stats" project.
3. At session start, any other bare token is a project before it is an extension verb
   (`gtg.mjs resume <token>` performs that check and prints the candidates when both exist).
4. Any other token (mid-session, or carrying further args like `gtg issues p1`) goes straight
   to the CLI as an extension verb.

Bookkeeping verbs (`list`, bare `backlog`, `back`, `active`, `complete`, `remove`, `prune`, `undo`, `log`, `stats`)
never reach this file: SKILL.md routes them straight to the CLI, slug not list number.

## Router table

| Trigger | Do this |
|---|---|
| "gtg backlog &lt;idea&gt;" (an idea named, not bare) | Park a long-horizon idea, see Backlog Park below. |
| "gtg supersede &lt;n\|slug&gt;" / "this rolled up into X" / "I filed that one in error" | The entry was **neither shipped nor abandoned**. Run `gtg.mjs supersede <n\|slug> [--into <n\|slug>]`. Use it when consolidating several entries into one parent, or clearing an entry that should never have existed: `remove` would write a phantom ship and `back` reads as shelved-for-later, and both corrupt throughput. Pass `--into` whenever another entry absorbed it. Stop. |
| "gtg peek &lt;project&gt;" | Read `docs/handoffs/active/&lt;slug&gt;.json` (or `docs/handoffs/backlog/&lt;slug&gt;.json`) — one file, one entry — then read its `file` verbatim and relay the content. Don't know the slug? `gtg.mjs list` prints it. The packed `_active.json` / `_backlog.json` no longer exist — the record directories are the whole store. **Do not consume**, no store mutation. |
| "gtg resume &lt;project&gt;" (mid-session; at session start "gtg &lt;project&gt;" is enough) | The project was **picked back up**, not shipped. SKILL.md Resume Procedure. `complete` (also `remove`/`prune`) means shipped; `resume` retains the current handoff and means picked back up; conflating them makes throughput history meaningless. |
| "gtg rename &lt;n\|slug&gt; &lt;new&gt;" | Run `gtg.mjs rename <n\|slug> <new-slug>`. It re-points any sub-project whose `parent` named the old slug, and leaves past handoff filenames alone because those record what the project was called then. The **portfolio** slug is separate: relay the `projects rename` line it prints rather than assuming both moved. Stop. |
| a `projects rename` printed a `NOTE:` about dangling parents | Run the `gtg rename <old> <new>` it names. Given a slug no entry here carries, `rename` repairs the stale `parent` reference instead of renaming an entry. Stop. |
| rename refuses because a progress record exists | Keep the stable work-line slug. Automatic migration of progress identity is unsupported; do not work around the refusal by moving JSON files or silently reassigning tasks. |
| an entry's `parent` names a family that does not exist, or names itself | Run `gtg.mjs unparent <n\|slug>`. `rename` re-**points** a parent (every child carrying it, at once), `unparent` **removes** one (a single entry). Re-pointing a dangling parent at the entry's own slug only makes a self-parent, so reach for `unparent` whenever the right answer is "no family". Stop. |
| "gtg report" | Run `gtg.mjs report` (writes `docs/handoffs/_report.json`, zero model tokens). Then invoke the **reporter** skill on that JSON to build a self-contained HTML report: a GitHub-style habit grid (from `habit.grid`), throughput and family rollups, per-project arcs, and the fun callouts. Playful tone. Write the HTML to the session scratchpad, not the repo. If `historyAvailable` is false or `effort.sessionsTimed` is 0, say so plainly rather than inventing figures. `duration_min` only accrues from sessions after gtg 1.4.0, so label effort "accruing", never present a near-zero total as if the work took no time. |
| "gtg &lt;verb&gt;" not listed above (e.g. "gtg stats", "gtg issues", "gtg learn") | Run `gtg.mjs <verb>` and relay its output. Four bundled extras ship with the plugin, in two kinds. **Extensions** own entries in the handoff store and render their own separated list: `issues` (the issues-layer listing) and `learn` (learning sprints). **Mods** own no entries and only add a view over the whole store: `stats` (a handoff-store snapshot) and `report`. A `<storage-root>/.gtg/commands/<verb>.mjs` you've added resolves here too, and yours overrides a bundled one of the same name. Unknown → the CLI errors. Stop. **Exception:** if the first output line starts with `GTG-DIRECTIVE:`, don't relay it; follow the instruction on that line instead. Both bundled extensions use this to hand control back to the Resume Procedure. |

## Extension entries

An extension's own entries are excluded from the bare `gtg.mjs list` and `gtg.mjs backlog`,
and from their counts, so the same work is not listed twice. That is decluttering, not hiding:
`gtg.mjs list <name-or-slug>` is you naming what you want, so it searches every entry and will
surface an issue package or a learning sprint, including a shelved one. A queried extension
entry prints with its slug in place of a row number, because row numbers index the bare
listing and that is the order `back <n>` and `remove <n>` resolve against. Pass the slug for
these, never a number.

## Working a package

`gtg issues <pN>` hands back a `GTG-DIRECTIVE` that resumes with `--keep`: the package entry is
retained, as with every resume. `--keep` preserves non-pickup intent for portfolio hooks.
It is the live mapping from its `pN` to a name, and every `docs/issues/` file in the batch
carries `**Package:** pN` pointing at it. A package retires by being **finished**: fix its
members and delete their files as you go; when the last one goes, its row renders
`no members - unstamped, or done` and names the `gtg remove` that closes it.

## Backlog Park (`gtg backlog <idea>`)

Same mechanics as the Exit Procedure, three differences: no work-in-progress commit (it's an
idea, not in-progress work), thin fields are fine (omit `--eta`, `--next "TBD — <first step>"`),
and the `backlog` subcommand routes it to the shelf:

```bash
gtg.mjs backlog --project "<Name>" --slug <slug> \
  --next "<first concrete step, or 'TBD — <thought>'>" <<'BODY'
## The Idea
<a few sentences: what it is, why it's worth remembering, any seed thoughts>

## Next Action
<the first concrete step when it's picked up, or 'TBD'>
BODY
```

Relay the `PARKED` line, then stop. A backlog item never shows in a bare `gtg.mjs list`.
`gtg.mjs backlog` lists them and `gtg.mjs active <n>` reactivates. The one exception is a
*queried* `gtg.mjs list <name-or-slug>`, which also reaches a shelved **extension** entry and
prints it on its own `shelved:` line. A shelved normal project stays invisible to a query.
