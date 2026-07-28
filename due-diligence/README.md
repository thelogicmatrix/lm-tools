# due-diligence

Two skills that make work hold up under a hostile reviewer — one for *before* you build, one for *before* you ship.

- **`due-diligence`** — an adversarial **Critic ↔ Corrector loop** run to convergence over a per-case selection of review lenses. Work is ready only when a hostile reviewer can find no material defect — not when it "looks fine." Targets fabricated/unverifiable data, silent data loss, wrong results, unhandled inputs, filler, unexplained jargon, contradictions, and usability gaps.
- **`cdd`** (Construction Due Diligence) — the same lens library run **forward**: before you build, it emits a *build brief* (the "what good looks like" bar + each lens's checks flipped into build targets) so you construct to the standard and the later review finds little. `cdd` does **not** replace the review — it reduces what it finds.

## How it works

**Per-case lens selection.** No lens is automatic. For each artifact you establish what produced it, what it's for, and what type it is (tags), then select the lenses it actually needs — reasoning about how it could fail. A visibility guard requires that any generally-applicable lens you *skip* be named with a reason, so coverage is never silently dropped.

**A library of 44 lenses (9 general + 35 domain)**, each a small checklist grounded in one of 19 research-backed knowledge files (`references/res_*.md`, cited to primary standards — WCAG, OWASP, SRE, learning science, SemVer, data-protection, and more). Nothing loads until a lens is selected, so an unused lens costs no context.

- **General lenses** (apply to most artifacts): data-provenance, necessity, clarity, operational-completeness, audience-fit, structure-navigability, voice (AI-tells), actionability, depth-sufficiency.
- **Domain lenses** (selected by artifact type): security, dependencies, reproducibility, idempotency, performance, maintainability, error-handling, test-coverage, prompt-injection, output-grounding, cost/token-efficiency, visual-ui-ux, accessibility, brand-consistency, statistical-soundness, cross-artifact-consistency, rollback/blast-radius, compliance-policy, assumptions-risk, alternatives-considered, pedagogy, data-privacy, data-quality, observability, concurrency-safety, resilience, backup-recovery, api-contract, llm-eval.

**Tiered effort.** The review self-calibrates how hard to look — Light (one pass), Standard (one fresh sub-agent critic), Heavy (one critic per lens + re-attack to convergence) — and states the tier. You can steer it ("quick check" / "go deep" / "bulletproof").

## Install

**As a plugin (auto-updating):**
```
/plugin marketplace add thelogicmatrix/lm-tools
/plugin install due-diligence@lm-tools
```

**As plain skills (static, no auto-update):** both skills are ordinary skill folders under
`due-diligence/skills/` — copy them straight into your project's or user `.claude/skills/`
(paths below are from the repo root after cloning):
```
cp -r due-diligence/skills/due-diligence due-diligence/skills/cdd  <your-repo>/.claude/skills/
```
Copy **both** as siblings — `cdd` reads `../due-diligence/references/`, so they must sit
next to each other under `.claude/skills/`. This gives you a frozen copy you commit to your
own repo that never updates from the marketplace. (`cdd` is optional; `due-diligence` works
standalone. cdd without due-diligence loses the shared knowledge base.)

## Use

- Before building: *"cdd this"* / *"build to DD standard"* → get the build brief.
- Before shipping: *"run due diligence on this"* / *"make this bulletproof"* → the Critic ↔ Corrector loop.

## Extending — add or change lenses without forking

Due Diligence follows the lm-tools three-tier contract: a core you don't touch, and a tier
you own that survives updates.

| Tier | Where | Updates? |
|---|---|---|
| **Core** | the plugin's `references/lenses/` + `res_*.md` (the 44 shipped) | with the tool |
| **Yours** | `.dd/` in *your* repo | never touched by a plugin update |

**Add your own lens** — drop a checklist in `.dd/lenses/<name>.md` in your repo (same shape
as a shipped lens: `## Fires on` / `## Attacks` / `## Evidence of attack` / `## Severity guide`),
with any backing knowledge in `.dd/res/<domain>.md`. DD scans `.dd/lenses/` on every run and
selects your lens per-case just like a built-in — no table edit, no plugin change.

**Change how a built-in lens behaves** — put a lens in `.dd/lenses/` with the **same name** as
a shipped one (e.g. `.dd/lenses/visual-ui-ux.md`). Yours overrides the built-in for your repo.

**Update-safe by design:** `.dd/` lives in your repo and DD only ever *reads* it, so a plugin
update can't clobber your lenses. Want a lens shipped for everyone instead? Add it under the
plugin's `references/lenses/` + a selection-table row in `SKILL.md` and open a PR.
