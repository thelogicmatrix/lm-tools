# statusline

A two-row Claude Code status line, built only from the payload the harness hands a status
line command on stdin. No cache files, no background writer, no state of its own.

```
Opus 5 | hi | orion | █░░░░░░░░░ 12% | personal
5h:42% ↺ 7:26p | 7d:8% | $3.46
```

**Row 1** model, effort level, project directory, context fill, account.
**Row 2** the 5 hour usage window with its reset time, the 7 day window, session cost.

Every segment except the model and directory disappears when its data is absent, so a cold
session shows a short line rather than a row of dashes.

## Why an account label

If you run two logins against one machine (say a personal `~/.claude` and a work
`~/.claudework`, selected with `CLAUDE_CONFIG_DIR`), nothing on screen otherwise tells you
which one is driving the session. The label is the config dir name with the leading dot
stripped, and a bare `.claude` reads as `personal`. Override it with
`CLAUDE_STATUSLINE_ACCOUNT`.

## Install

```
/statusline-install
```

Claude Code plugins cannot declare a top-level `statusLine` themselves: a plugin's
`settings.json` supports only the `agent` and `subagentStatusLine` keys. So the command
copies `scripts/statusline.js` to `<config-dir>/hooks/statusline-lm.js` and points
`statusLine` at the copy. It copies rather than referencing the plugin directory because a
plugin cache path carries its version number and would break on the next update. Re-run the
command to pick up a newer version of the script.

Restart the session after installing.

## Colors

Context fill and the 5 hour window share one set of pressure bands: green under 50 percent,
yellow to 70, orange to 80, blinking red above that. The 7 day window stays grey, because it
moves too slowly to be worth an alarm.

## Test

```
npm test
```

Covers the band boundaries, the optional segments, the account label including both
fallbacks, and that a malformed payload prints nothing instead of breaking the status line.
