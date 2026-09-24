---
name: statusline
description: Use when the user asks to install, configure, or repair the Codex status line, or asks for an estimated cost of the current Codex session.
---

# Statusline

Use the deterministic helper bundled two directories above this `SKILL.md` at
`scripts/statusline-codex.mjs`. Resolve its absolute path from the displayed location of this
skill. Codex does not reliably expose a plugin-root environment variable.

## Route the request

- Install, configure, port, or repair the footer: run `node <helper> install`.
- Estimate the current session's cost: run `node <helper> cost` and relay its single output line.
- If the user explicitly wants machine-readable cost details, add `--json`.

The install command preserves unrelated `config.toml` content. If it exits 2 because a different
`tui.status_line` already exists, show that conflict and get approval before rerunning with
`--force`. After a successful change, tell the user to restart Codex.

The footer is Codex's native single row. It intentionally contains model/reasoning, project,
context used, and 5-hour/weekly limits, with no token counter and no invented cost item. The cost command
reads the latest matching root rollout, skips subagents, and labels the result API-equivalent and
not billed. Do not describe it as the user's actual ChatGPT subscription cost.
