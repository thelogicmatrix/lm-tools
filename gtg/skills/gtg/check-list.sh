#!/usr/bin/env bash
# One-shot self-check for gtg list rendering. Runs the CLI against a throwaway store.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/docs/handoffs/active"
NOW="$(date +%Y-%m-%dT%H:%M:%S%z)"
# One file per record: the sharded store is the only store since 3.3.0, and seeding the packed
# file here would render an empty list rather than failing an assertion.
cat > "$TMP/docs/handoffs/active/alpha.json" <<EOF
{"project":"Alpha","slug":"alpha","sessions":3,"created":"$NOW","eta":"~2h","next":"do x","file":"f","updated":"$NOW"}
EOF
cat > "$TMP/docs/handoffs/active/beta.json" <<EOF
{"project":"Beta","slug":"beta","tier":"Sonnet","next":"do y","file":"f","updated":"$NOW"}
EOF
cat > "$TMP/docs/handoffs/active/gamma.json" <<EOF
{"project":"Gamma","slug":"gamma","next":"do z","file":"f","updated":"$NOW"}
EOF
# Finding I2: a legacy entry (no `sessions` field) must render the TRUE count of
# handoff files on disk, not a hardcoded 1 — cover both a 1-file and a 9-file case.
touch "$TMP/docs/handoffs/2026-01-01-0900-beta.md"
for i in 1 2 3 4 5 6 7 8 9; do
  touch "$TMP/docs/handoffs/2026-01-0${i}-0900-gamma.md"
done
OUT="$(GTG_HUB="$TMP" node "$HERE/gtg.mjs" list | cat)"   # piped => isTTY false => no color
echo "$OUT"
echo "$OUT" | grep -q '\[~2h\]'          || { echo "FAIL: eta not shown"; exit 1; }
echo "$OUT" | grep -q 'Alpha s3'         || { echo "FAIL: sessions count not shown"; exit 1; }
echo "$OUT" | grep -q 'Beta s1'          || { echo "FAIL: legacy entry with 1 handoff file must fall back to the TRUE disk count (s1), not a hardcoded default"; exit 1; }
echo "$OUT" | grep -q 'Gamma s9'         || { echo "FAIL: legacy entry with 9 handoff files must render s9, not hardcoded s1 (Finding I2)"; exit 1; }
echo "$OUT" | grep -q 'Beta.*\[?\]'      || { echo "FAIL: legacy tier entry not rendered as [?]"; exit 1; }
printf '%s' "$OUT" | grep -q $'\x1b\['    && { echo "FAIL: ANSI escapes leaked into piped output"; exit 1; }
echo "PASS"
