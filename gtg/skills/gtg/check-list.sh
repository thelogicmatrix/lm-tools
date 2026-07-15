#!/usr/bin/env bash
# One-shot self-check for gtg list rendering. Runs the CLI against a throwaway store.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/docs/handoffs"
NOW="$(date +%Y-%m-%dT%H:%M:%S%z)"
cat > "$TMP/docs/handoffs/_active.json" <<EOF
{"handoffs":[
 {"project":"Alpha","slug":"alpha","phase":"executing","eta":"~2h","next":"do x","file":"f","updated":"$NOW"},
 {"project":"Beta","slug":"beta","phase":"free-form","tier":"Sonnet","next":"do y","file":"f","updated":"$NOW"}
]}
EOF
OUT="$(GTG_HUB="$TMP" node "$HERE/gtg.mjs" list | cat)"   # piped => isTTY false => no color
echo "$OUT"
echo "$OUT" | grep -q '\[~2h\]'          || { echo "FAIL: eta not shown"; exit 1; }
echo "$OUT" | grep -q 'Beta.*\[?\]'      || { echo "FAIL: legacy tier entry not rendered as [?]"; exit 1; }
printf '%s' "$OUT" | grep -q $'\x1b\['    && { echo "FAIL: ANSI escapes leaked into piped output"; exit 1; }
echo "PASS"
