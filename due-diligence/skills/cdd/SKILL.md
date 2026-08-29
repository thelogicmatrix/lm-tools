---
name: cdd
description: Use BEFORE building any work product a stakeholder will scrutinise — a report, doc, dataset, spec, UI, code, pipeline, or educational content — to build it to standard from the first line instead of fixing it under review afterward. Triggers on "cdd", "construction dd", "build to dd standard", "build to spec", or when about to start building something that Due Diligence would later review. The forward half of Due Diligence.
---

# Construction Due Diligence (cdd)

## What this is

DD's research corpus, run **forward**. DD attacks a finished draft; `cdd` briefs the build *before the first line*, so the artifact is built to the bar and the later critic finds little. Same tags, same lenses, same knowledge — consumed to construct rather than to review.

`cdd` reuses the Due Diligence skill's `references/` library (sibling skill `due-diligence`). It does **not** duplicate that knowledge, and it does **not** load DD's `SKILL.md` — it reads only the specific lens/res files a tag selects, on demand, by path. Nothing enters context until a tag calls for it.

## Hard guard — read first

`cdd` does **NOT** replace the DD review. Building to a checklist is not the same as being verified against it: you still run Due Diligence on the finished artifact. `cdd` reduces what the critic finds; it never licenses skipping it. If you catch yourself thinking "I built it with cdd, so it's already DD'd" — stop. That's the failure this guard exists for.

## Flow

1. **Establish context (DD Step 0).** What are you building, for whom, what decision does it serve? Then **tag the intended artifact** from DD's closed tag set:
   `code, config, data-export, llm-pipeline, rendered-ui, data-analysis, multi-file, doc-describes-code, deploy, migration, infra, pipeline, cron, external-send, proposal, plan, recommendation, runbook, educational`.
   No tag → general lenses only, selected per case.

2. **Select lenses per-case (same as DD).** No lens is automatic. Select from the nine general lenses and the domain lenses this specific artifact needs, reasoning about how it could fail. The rosters are in `../due-diligence/references/lens-selection.md` (general lenses by when they apply, domain lenses by tag). State the selected set in one line, and name any general lens you deliberately skip and why (DD's selection guard).

3. **Open only the selected knowledge, on demand, at the brief tier that fits.**
   - **Light brief (default).** For each selected lens read `../due-diligence/references/lenses/<name>.md` only. Flip its Attacks into targets. Where the lens has a `## Measure`, state the target as the number to hit ("0 untraced claims", "6/6 edge-case classes", "4/4 viewports").
   - **Full brief.** Also read the `../due-diligence/references/res_<domain>.md` the lens cites, for the "what good looks like" bar. Only when the user asks, or the artifact is external or irreversible.
   Say which tier ran in the brief's first line. Read nothing else. (Paths are relative to the skills directory; `cdd` and `due-diligence` are siblings.)

4. **Emit the build brief.** One checklist to build against — for each **selected** lens, that lens's attacks **flipped into build targets**, plus the res_ bar on a Full brief (each "attack X" → "satisfy / avoid X"). Examples:
   - *Provenance* (if selected) — every figure/name/date/quote you put in must trace to a real source as you write it; never fabricate or hedge with "reportedly."
   - *Necessity* — cut anything not serving the reader's decision before it goes in.
   - *Clarity* — define jargon and label units inline, at first use.
   - *Operational completeness* — handle the whole input and the edge cases (empty/zero/max/missing/duplicate/failure) from the start.
   - *data-provenance* with Measure → "0/N untraced when the draft is done".
   - *visual-ui-ux* "forced horizontal scroll" → "no horizontal scroll at 390/768/1024/1280"; *pedagogy* "forward reference" → "introduce every concept before you use it".

5. **Build to the brief.** Keep the checklist in view while constructing. When done, hand off to the **Due Diligence** skill for the actual review (see hard guard).

## Output

Lead with the one-line tag + lens selection, then the build brief as a checklist grouped by concern (general lenses first, then each domain lens). Keep it a brief — targets to build toward — not an essay. If no tags apply, the brief is the selected general lenses' targets.
