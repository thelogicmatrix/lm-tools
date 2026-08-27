---
description: Install the lm-tools status line into this account's settings.json
---

Wire `scripts/statusline.js` from this plugin into the user's Claude Code settings.

1. Resolve the config dir: `$CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`.
2. Copy `${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js` to `<config-dir>/hooks/statusline-lm.js`,
   creating `hooks/` if needed. Copy rather than point at the plugin directory: a plugin
   cache path carries the version number, so it breaks on the next update.
3. Read `<config-dir>/settings.json`, set:

   ```json
   "statusLine": { "type": "command", "command": "node '<config-dir>/hooks/statusline-lm.js'" }
   ```

   Preserve every other key. If `statusLine` already points somewhere else, show the user
   the existing value and ask before replacing it.
4. Verify by piping a fixture through the copy and showing the two rows:

   ```
   echo '{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"/tmp/demo"},"context_window":{"used_percentage":12},"cost":{"total_cost_usd":0.42}}' | node '<config-dir>/hooks/statusline-lm.js'
   ```
5. Tell the user to restart the session, and that re-running this command is how they pick
   up a newer version of the script.

Optional: `CLAUDE_STATUSLINE_ACCOUNT` overrides the account label, which otherwise comes
from the config dir name (`.claude` reads as `personal`).
