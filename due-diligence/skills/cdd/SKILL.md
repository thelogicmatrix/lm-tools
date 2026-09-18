---
name: cdd
description: Use only when explicitly invoked as cdd, construction dd, or build to DD standard. Do not activate automatically for planning, implementation, or work that Due Diligence might later review.
---

# Construction Due Diligence (cdd)

## What this is

DD's research corpus, run **forward**. DD attacks a finished draft; `cdd` briefs the build *before the first line*, so the artifact is built to the bar and the later critic finds little. Same tags, same lenses, same knowledge — consumed to construct rather than to review.

`cdd` reuses the Due Diligence skill's `references/` library (sibling skill `due-diligence`). It does **not** duplicate that knowledge, and it does **not** load DD's `SKILL.md` — it reads only the lens files a tag selects, on demand, by path, plus the res files a Full brief cites. Nothing enters context until a tag calls for it.

## Hard guard — read first

`cdd` does **NOT** replace a DD review, but it also does not schedule one. Run Due Diligence separately only when the user explicitly requests it or at its outbound/branch-finish boundary.

## Flow

1. **Establish context (DD Step 0).** What are you building, for whom, what decision does it serve? Then **tag the intended artifact** from DD's closed tag set:
   `code, config, data-export, llm-pipeline, rendered-ui, data-analysis, multi-file, doc-describes-code, deploy, migration, infra, pipeline, cron, external-send, proposal, plan, recommendation, runbook, educational`.
   No tag → general lenses only, selected per case.

2. **Select lenses per-case (same as DD).** No lens is automatic. Select from the nine general lenses and the domain lenses this specific artifact needs, reasoning about how it could fail. The rosters are in `../due-diligence/references/lens-selection.md` (general lenses by when they apply, domain lenses by tag). State the selected set in one line, and name any general lens you deliberately skip and why (DD's selection guard).

3. **Open only the selected knowledge, on demand, at the brief tier that fits.**
   - **Light brief (default).** For each selected lens read `../due-diligence/references/lenses/<name>.md` only. Flip its Attacks into targets. Where the lens has a `## Measure`, state the target as the number to hit ("0 untraced claims", "6/6 edge-case classes", "4/4 viewports").
   - **Full brief.** Also read the `../due-diligence/references/res_<domain>.md` the lens cites, for the "what good looks like" bar. Only when the user asks, or the artifact is external or irreversible.
   Name the tier on the brief's lead line, next to the tag and lens selection. Read nothing else. (Paths are relative to the skills directory; `cdd` and `due-diligence` are siblings.)

4. **Emit the build brief.** One checklist to build against — for each **selected** lens, that lens's attacks **flipped into build targets** (each "attack X" → "satisfy / avoid X"), plus the res_ bar on a Full brief. Examples:
   - *data-provenance* (if selected) — every figure/name/date/quote you put in must trace to a real source as you write it; never fabricate or hedge with "reportedly."
   - *Necessity* — cut anything not serving the reader's decision before it goes in.
   - *Clarity* — define jargon and label units inline, at first use.
   - *Operational completeness* — handle the whole input and the edge cases (empty/zero/max/missing/duplicate/failure) from the start.
   - *data-provenance* with Measure → "0/N untraced when the draft is done".
   - *visual-ui-ux* "forced horizontal scroll" → "no horizontal scroll at 390/768/1024/1280"; *pedagogy* "forward reference" → "introduce every concept before you use it".

5. **Build to the brief.** Keep the checklist in view while constructing. Stop when the requested build work is done; do not trigger Due Diligence automatically.

## Output

Lead with the one-line tag + lens selection, then the build brief as a checklist grouped by concern (general lenses first, then each domain lens). Keep it a brief — targets to build toward — not an essay. If no tags apply, the brief is the selected general lenses' targets.
