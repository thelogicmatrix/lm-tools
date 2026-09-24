# statusline

One package with harness-native status lines for Claude Code and Codex.

## Claude Code

Claude gets the original two-row renderer directly from the JSON payload supplied to its status
line command. It has no cache file, background writer, or state of its own.

```
Opus 5 | hi | orion | █░░░░░░░░░ 12% | personal
5h:42% ↻ 7:26p | 7d:8% | $3.46
```

**Row 1** model, effort level, project directory, context fill, account. **Row 2** the
5-hour usage window with its reset time, the 7-day window, and session cost. Optional data
disappears instead of rendering dashes.

Install it with:

```
/statusline-install
```

The command copies `scripts/statusline.js` to `<config-dir>/hooks/statusline-lm.js` and updates
`settings.json`. Re-run it after plugin updates. `CLAUDE_STATUSLINE_ACCOUNT` overrides the account
label. Otherwise the label comes from `CLAUDE_CONFIG_DIR` (`.claude` reads as `personal`).

Context fill and the 5-hour window share pressure bands: green under 50 percent, yellow to 70,
orange to 80, and blinking red above that. The 7-day window stays grey.

## Codex

Codex supports a native single-row footer made from predefined items. Install the plugin, then ask
the skill to configure it:

```powershell
codex plugin add statusline@lm-tools
```

```text
$statusline install
```

The installer surgically adds this to `$CODEX_HOME/config.toml` (normally
`~/.codex/config.toml`) while preserving every other setting:

```toml
[tui]
status_line = ["model-with-reasoning", "project-name", "context-used", "five-hour-limit", "weekly-limit"]
status_line_use_colors = true
```

If a different status line already exists, the installer stops rather than replacing it without
approval. Restart Codex after installation.

### Vibes cost

Codex does not support custom calculated footer items. Its native `estimated-thread-cost` item
only renders on Enterprise workspaces (per the item description in codex-cli 0.156.1). The local
rollout still contains the same
model and cumulative token data used by `/status`. Get an on-demand estimate with:

```text
$statusline cost
```

Example:

```
~$2.37 · gpt-5.6-sol · 193.9K uncached in + 3.33M cached in + 13.2K out · API-equivalent, not billed
```

This is intentionally fun, not accounting. It applies the API token prices captured on 2026-08-27
for GPT-5.6 Sol, Terra, or Luna, prices cache reads and cache writes separately, and does not count
reasoning tokens twice. It is not the cost of a ChatGPT subscription session. Unknown future models
fail clearly until the pricing snapshot is updated. The estimate uses the published base token rates.
It does not reconstruct per-request long-context surcharges or tool fees. Pricing source:
<https://developers.openai.com/api/docs/models/compare>. Cache-write multiplier source:
<https://developers.openai.com/api/docs/guides/prompt-caching>.

## Test

```powershell
npm test
```

The suite covers the Claude renderer plus Codex config preservation, conflict handling, session
selection, subagent exclusion, cache-aware cost arithmetic, and plugin packaging.
