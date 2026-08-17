# lm-tools

A marketplace of **modular frameworks for Claude Code** — tools built to be *extended*, not just installed. Each one ships a solid core and a documented extension point where you add your own pieces (commands, hooks, lenses) that live in *your* repo and survive updates. Take the defaults, or bend them to fit how you actually work.

By [Nathan Wong](https://github.com/thelogicmatrix).

## Add the marketplace

```
/plugin marketplace add thelogicmatrix/lm-tools
```

Then install whichever tools you want — they're independent:

```
/plugin install gtg@lm-tools
/plugin install due-diligence@lm-tools
/plugin install logical-research@lm-tools
/plugin install projects@lm-tools
```

Prefer a frozen, non-updating copy? Each tool is also a plain skill you can copy into
`.claude/skills/` — see the per-tool README.

## Tools

### [gtg — Got to Go](gtg/README.md)
Pause and resume for Claude Code. Say **"gtg"** when you leave mid-task and it writes a
structured handoff; say **"let's continue X"** days later and it picks up cold. Zero-model
terminal commands for list/prune/backlog, 7-day auto-shelving, git-history-as-undo.
**Extend it:** drop `.gtg/commands/<name>.mjs` and `.gtg/skill/*.md` hooks in your repo —
new CLI subcommands and procedure steps, no fork. → [gtg/README.md](gtg/README.md)

### [due-diligence](due-diligence/README.md)
Make work hold up under a hostile reviewer. **`due-diligence`** runs an adversarial
Critic ↔ Corrector loop before you ship; **`cdd`** runs the same lens library *forward* to
brief a build before you start. A per-case selection from 44 lenses (9 general + 35 domain),
each grounded in a research-backed knowledge file.
**Extend it:** drop your own lenses in `.dd/lenses/` in your repo — DD reads them alongside
the shipped ones, and a same-named lens overrides a built-in. → [due-diligence/README.md](due-diligence/README.md)

### [logical-research](logical-research/README.md)
Turn a **bounded corpus** — a channel, a book, a doc set, a set of papers — into reusable
context instead of a summary you read once: a synthesis with every claim graded by evidence
strength, one note per item, and a traceable bibliography, shaped to paste into a model later.
The reading itself is deliberately not delegated — cross-item connections only surface when one
reader holds the whole corpus.
**Extend it:** drop recurring reading angles in `.lr/angles/*.md` in your repo — the pipeline
reads them instead of you re-explaining the angle each run. → [logical-research/README.md](logical-research/README.md)

### [projects](projects/README.md)
The portfolio layer above gtg: a **generated** index of everything you have going, one
narrative page per project, and **`projects sync`** — which checks every row against
reality (skeleton pages, a status older than the repo's last commit, a checkout that no
longer exists) instead of trusting a table a model maintained. A CLI owns every mechanical
field and a write-guard hook denies hand-edits to the generated files.
**No extension point yet**, deliberately: nothing was cut from this one, so a seam would be
speculative. Ask if you want one. → [projects/README.md](projects/README.md)

## The shared contract

Every lm-tools framework follows the same three-tier shape:

| Tier | Where | Updates? |
|---|---|---|
| **Core** | the plugin | ships + updates with the tool |
| **Bundled** | the plugin's defaults | on by default, updates with the tool |
| **Yours** | a dot-dir in *your* repo (`.gtg/`, `.dd/`, `.lr/`, …) | never touched by updates — you own it |

The plugin only ever *reads* your tier, so a plugin update can't clobber your extensions.
That's the point: a framework you add to and modify, not a black box.

## License

See [LICENSE](LICENSE).
