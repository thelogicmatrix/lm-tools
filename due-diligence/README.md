# due-diligence

Two skills that make work hold up under a hostile reviewer — one for *before* you build, one for *before* you ship.

- **`due-diligence`** — an adversarial **Critic ↔ Corrector loop** run to convergence over a per-case selection of review lenses. Work is ready only when a hostile reviewer can find no material defect — not when it "looks fine." Targets fabricated/unverifiable data, silent data loss, wrong results, unhandled inputs, filler, unexplained jargon, contradictions, and usability gaps.
- **`cdd`** (Construction Due Diligence) — the same lens library run **forward**: before you build, it emits a *build brief* (the "what good looks like" bar + each lens's checks flipped into build targets) so you construct to the standard and the later review finds little. `cdd` does **not** replace the review — it reduces what it finds.

## How it works

**Per-case lens selection.** No lens is automatic. For each artifact you establish what produced it, what it's for, and what type it is (tags), then select the lenses it actually needs — reasoning about how it could fail. A visibility guard requires that any generally-applicable lens you *skip* be named with a reason, so coverage is never silently dropped.

**A library of 38 lenses (9 general + 29 domain)**, each a small checklist grounded in one of 14 research-backed knowledge files (`references/res_*.md`, cited to primary standards — WCAG, OWASP, SRE, learning science, SemVer, data-protection, and more). Nothing loads until a lens is selected, so an unused lens costs no context.

- **General lenses** (apply to most artifacts): data-provenance, necessity, clarity, operational-completeness, audience-fit, structure-navigability, voice (AI-tells), actionability, depth-sufficiency.
- **Domain lenses** (selected by artifact type): security, dependencies, reproducibility, idempotency, performance, maintainability, error-handling, test-coverage, prompt-injection, output-grounding, cost/token-efficiency, visual-ui-ux, accessibility, brand-consistency, statistical-soundness, cross-artifact-consistency, rollback/blast-radius, compliance-policy, assumptions-risk, alternatives-considered, pedagogy, data-privacy, data-quality, observability, concurrency-safety, resilience, backup-recovery, api-contract, llm-eval.

**Tiered effort.** The review self-calibrates how hard to look — Light (one pass), Standard (one fresh sub-agent critic), Heavy (one critic per lens + re-attack to convergence) — and states the tier. You can steer it ("quick check" / "go deep" / "bulletproof").

## Install

```
/plugin marketplace add thelogicmatrix/lm-tools
/plugin install due-diligence@lm-tools
```

## Use

- Before building: *"cdd this"* / *"build to DD standard"* → get the build brief.
- Before shipping: *"run due diligence on this"* / *"make this bulletproof"* → the Critic ↔ Corrector loop.

## Extending

Add a lens by dropping a `references/lenses/<name>.md` checklist that cites a `references/res_<domain>.md` knowledge file, and adding a row to the selection table in `skills/due-diligence/SKILL.md`. No dispatcher code to touch.
