# jev

Nathan's sweeps over the `jev-latest` model (OpenRouter System One endpoint). Key in `~/.jev.env`
as `OPENROUTER_API_KEY=...`, read by `scripts/lib.mjs`.

Moved here 2026-09-24 from the home monorepo: `scripts/jev-sweep/` (now `scripts/`),
`scripts/jev-calibrate/` (later moved out, see below), `.claude/skills/jevchecker/` (now
`skills/jevchecker/`) and `docs/runbooks/jevclassify.mjs` (now `scripts/jevclassify.mjs`).
History before that date is in the author's private monorepo.

Never run any of these on customer data: the whole body goes to OpenRouter.

The runbook matcher prototype that used to live in `scripts/` is now the `runbooks` plugin
(`../runbooks/README.md`), which routes runbooks per prompt at a 0.8 bar.

    node scripts/lib.test.mjs && node --test skills/jevchecker/jevchecker.test.mjs
    node scripts/jevclassify.mjs --selftest
    node scripts/jevmail.mjs --selftest

`scripts/jevmail.mjs --ask "<question>" --identity <id> --query "<gmail query>"` finds the message
and the link or passage that answers a question, after narrowing with postman's search. It refuses
the `work` identity in code. Usage is in the file header.

The job-board experiments that used to live here (the MLM gate, the JD sweeps, the calibration
harness) moved to the author's private tree.
