# jev

Nathan's sweeps over the `jev-latest` model (OpenRouter System One endpoint). Key in `~/.jev.env`
as `OPENROUTER_API_KEY=...`, read by `scripts/lib.mjs`.

Moved here 2026-09-24 from the home monorepo: `scripts/jev-sweep/` (now `scripts/`),
`scripts/jev-calibrate/` (now `scripts/calibrate/`), `.claude/skills/jevchecker/` (now
`skills/jevchecker/`) and `docs/runbooks/jevclassify.mjs` (now `scripts/jevclassify.mjs`).
History before that date is in `nathan/home`.

Never run any of these on customer data: the whole body goes to OpenRouter.

    node scripts/lib.test.mjs && node --test skills/jevchecker/jevchecker.test.mjs
    node scripts/jevgate.mjs --selftest
    node scripts/jevclassify.mjs --selftest

`jevgate`, `jevjd`, `titles`, `limits` and the `exp-*` scripts import orion's prefilter and run
helpers from `C:/Users/thelo/.claude/skills/orion/lib/` by absolute path. They need that tree.
