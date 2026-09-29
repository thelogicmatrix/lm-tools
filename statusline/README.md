# statusline: usage and context at a glance

Your context fill and usage limits in the footer of Claude Code and Codex, with nothing running in the background.

## What it shows

Claude Code gets two rows:

```
Opus 5 | hi | my-app | █░░░░░░░░░ 12% | personal
5h:42% ↺ 7:26p | 7d:8% | $3.46
```

Codex gets one row.

| Field | Claude Code | Codex |
| --- | --- | --- |
| Model and effort | Yes | Yes |
| Project | Yes | Yes |
| Context used | Bar and percent | Yes |
| 5-hour limit | Percent and reset time | Yes |
| Weekly limit | Percent | Yes |
| Account | Yes | No |
| Session cost | Yes | On demand |

In Claude Code, context and the 5-hour limit go yellow at 50 percent, orange at 70 and blinking red at 80. The weekly limit stays grey. Missing data drops out rather than showing a dash.

## How it works

Claude Code hands the script the session's details on each refresh. The script keeps no state of its own.

Codex only allows built-in footer items, so the installer switches on five and leaves your other settings alone. It asks before replacing a different footer.

Codex's own cost item only shows on Enterprise workspaces, so `$statusline cost` gives a vibes cost from the session log, at OpenAI's API rates:

```
~$2.37 · gpt-5.6-sol · 193.9K uncached in + 3.33M cached in + 13.2K out · API-equivalent, not billed
```

That is the API price, not your ChatGPT subscription cost. An unpriced model gets a clear error.

## Install

Add the logical-tools marketplace as the [root README](../README.md) shows. You need Node.

Claude Code:

```
/plugin install statusline@logical-tools
/statusline-install
```

Re-run `/statusline-install` after each plugin update, because it installs a copy.

Codex:

```
codex plugin add statusline@logical-tools
```

Then ask Codex `$statusline install`. Restart the session or Codex afterwards.

## Details

- Claude's account label is `CLAUDE_STATUSLINE_ACCOUNT` if set, else the `CLAUDE_CONFIG_DIR` folder name (`.claude` reads as `personal`).
- The Codex footer goes under `[tui]` in `$CODEX_HOME/config.toml`, normally `~/.codex/config.toml`.
- Prices cover GPT-5.6 Sol, Terra and Luna as of 2026-08-27, in `scripts/statusline-codex.mjs`. Cache reads and writes are priced separately. Reasoning tokens count once. Long-context surcharges and tool fees are excluded. Sources: [model prices](https://developers.openai.com/api/docs/models/compare), [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
- The Enterprise-only limit is per the item description in codex-cli 0.156.1.
- Tests: `npm test`.
