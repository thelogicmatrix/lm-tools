---
name: due-diligence
description: Use when about to deliver, hand off, ship, or "finalize" any work product (report, analysis, doc, dataset, spec, code, deliverable) — especially AI-generated — that a stakeholder, reviewer, or boss will scrutinize; or when asked to make something "production-ready", "bulletproof", "perfect", or "reviewed before sending". For deliverables with a real reader; skip throwaway scratch.
---

# Due Diligence

Work is ready only when **a hostile reviewer can find no material defect**, not when it looks
fine. That covers the deliverable a reader sees **and** the code or operation behind it: a tool
that silently drops data or mishandles an input is defective even when its output looks clean.
Get there with an adversarial **Critic ↔ Corrector loop to convergence**, aimed at what
skeptical reviewers and real use expose: fabricated or unverifiable data, silent data loss,
wrong results, unhandled inputs, filler, unexplained jargon, contradictions, usability gaps.

**"Looks fine" is a Critic failure, not a pass.** The Critic assumes defects exist and shows it
attacked. **Material defect = blocker or should-fix.** Nits are listed and do not block.

## When

Before declaring work done or sending it on; when auditing whether code, a pipeline or a
process actually works on real inputs; any AI-generated artifact going to a skeptical human;
"perfect", "production-ready", "boss-proof", "break it". Skip only throwaway scratch with no
reader.

## Calibrate effort first, then say which tier and why

Fan-out and re-attack are token-expensive. Pick the cheapest tier that fits and state it in
one line. A user naming a tier or intensity ("quick check", "one critic", "go deep",
"bulletproof") overrides the auto-pick.

- **Skip**: throwaway scratch.
- **Light (DEFAULT)**: ONE fresh-eyes pass over all selected lenses in a single turn, ONE fix
  cycle, no re-attack. Most deliverables land here.
- **Standard**: ONE fresh sub-agent critic given only the artifact, lenses and Step 0 (never
  the authoring rationale); re-attack **once**, only if it found a blocker. For a real boss,
  client or external deliverable.
- **Heavy**: one critic **per selected lens in parallel**, re-attack to convergence. ONLY when
  the user asked, the change is irreversible or embarrassing if wrong, or the artifact will not
  fit one critic's context.

## Step 0: context, ask if unknown

1. **What produced it?** AI-generated facts are unverified by default; require a trace before
   trusting a figure, name or quote.
2. **What is it for?** Decision, audience, medium, length or format constraints. This sets the
   bar for necessity and clarity.
3. **What type is it?** Tag from the closed set: `code, config, data-export, llm-pipeline,
   rendered-ui, data-analysis, multi-file, doc-describes-code, deploy, migration, infra,
   pipeline, cron, external-send, proposal, plan, recommendation, runbook, educational`.
   Plain prose with none of these gets no tag.

## Lens selection, per case

**No lens is automatic.** Select what the artifact's failure surface actually needs from the
rosters in [references/lens-selection.md](references/lens-selection.md): nine general lenses
taken where the surface exists, domain lenses surfaced by the tags, and the user's own
`.dd/lenses/*.md` (a same-named user lens overrides the shipped one). Open only the selected
lens files and the `res_*.md` each cites.

**Selection guard, one line before attacking:** name the lenses selected AND every general
lens deliberately skipped, each with a why. Skipping is allowed; omitting without saying is
the failure mode. e.g. *"Tags: rendered-ui → visual-ui-ux, deep-accessibility,
brand-consistency + clarity, necessity; skipped provenance (no data or claims) and
operational-completeness (static page)."*

## The loop

Draft exists → a **FRESH** Critic attacks over the selected lenses, re-deriving every claim
from scratch → any open material defect goes to the Corrector, who **fixes it or refutes it
with evidence** (quote the source, show the logic; "it's fine" is not a refutation) → re-attack
per the tier → **ship when** the tier's passes find no open blocker or should-fix **and** every
lens shows evidence of attack. Disclosed nits and evidence-refuted items do not block.

Never let the Corrector grade its own homework. State which mode ran.

**Stop rule:** a defect that survives 3 full loops (same root issue, reworded or not), or two
passes disagreeing on severity, escalates to the user with the artifact and both positions.
Severity ties resolve upward.

## Critic output, per defect

1. **Plain-language lead**, one sentence, no jargon: what the problem means and what goes
   wrong if unfixed, in the output or in how the system behaves. e.g. *"The tool only reads
   part of each thread, so it can miss the reply that turns a complaint into a balanced view,
   and nothing flags that it happened."*
2. **Detail** for whoever fixes it: quote the offending text or code with its location.
3. **Severity**: *blocker* = wrong result, lost data, or would mislead or embarrass the reader;
   *should-fix* = a rough edge real use will hit; *nit* = polish.
4. **The concrete fix.**

Vague complaints are rejected; point at the words or code. A lens with no defect states what
was checked and why it passed. That is the evidence of attack the ship gate requires.

## Reporting back

Lead with a 2 to 3 sentence plain-English bottom line: ready or not, and the biggest
real-world risks, functional and presentational. Then the findings, each opening with its
plain-language lead, technical detail secondary on a "Detail:" line. The reader never has to
ask what it means for them.

## When you catch yourself thinking

| Thought | Reality |
|---|---|
| "It looks fine / polished" | Polish hides defects. A clean pass needs evidence of attack on every selected lens. |
| "I'll just add a citation" | Cannot name a real source? The data may be invented. Trace or delete. |
| "The reader will understand" | If they could ask what, where from or how, it is a defect. |
| "I reviewed it myself" | Authors are blind to their own work. Fresh Critic. |
| "Good enough to send" | Fixes create defects. The bar is no material defect. |

To add or override a lens: [references/authoring-lenses.md](references/authoring-lenses.md).
