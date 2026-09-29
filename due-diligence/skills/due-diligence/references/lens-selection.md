# Lens selection: the rosters

Read at Step 0 of every DD run, after the artifact's tags are known. Lenses are files in
`references/lenses/<name>.md`, opened only when selected; each cites the `references/res_*.md`
standard it checks against.

## General lenses (select per case)

| Lens | Select when |
|---|---|
| data-provenance | any figure, name, date, quote or claim to trace |
| necessity | prose that could carry filler |
| clarity | any reader-facing text |
| operational-completeness | anything that runs or processes input |
| audience-fit | the reader's expertise or role is known and level-match matters |
| structure-navigability | a multi-section doc the reader must navigate |
| voice | prose, especially AI-generated (AI tells) |
| actionability | meant to drive a decision or action |
| depth-sufficiency | substantive claims or recommendations (the inverse of necessity) |

data-provenance and operational-completeness are DD-core (trace or delete; does it actually
work). necessity and clarity cite `res_technical-writing.md`.

## Domain lenses by tag

A tag in two rows contributes both rows' lenses (an `infra` artifact gets rollback-blast-radius
and idempotency-rerun-safety).

| Tag | Domain lenses |
|---|---|
| code | security-secrets, dependency-supply-chain, reproducibility-portability, performance-efficiency, maintainability, error-handling, test-coverage, concurrency-safety, resilience, api-contract, interface-state-coverage |
| config | security-secrets, homelab-ops |
| data-export | security-secrets, data-privacy, data-quality, agency-preservation |
| llm-pipeline | prompt-injection, output-grounding, cost-token-efficiency, resilience, llm-eval, inference-legibility, absent-user-handoff, agency-preservation |
| rendered-ui | visual-ui-ux, deep-accessibility, brand-consistency, interface-state-coverage, inference-legibility, agency-preservation |
| data-analysis | statistical-soundness, data-quality, data-privacy, agency-preservation |
| multi-file, doc-describes-code | cross-artifact-consistency, api-contract |
| deploy, migration, infra | rollback-blast-radius, reproducibility-portability, observability, backup-recovery, homelab-ops, absent-user-handoff |
| pipeline, cron, infra | idempotency-rerun-safety, observability, concurrency-safety, resilience, homelab-ops, absent-user-handoff, attention-cost, interface-state-coverage |
| runbook | reproducibility-portability |
| external-send | data-privacy (required for PII), compliance-policy and attention-cost when relevant |
| proposal, plan, recommendation | assumptions-risk, alternatives-considered, agency-preservation |
| educational | pedagogy |

## Heavy critic groups

Heavy runs at most 6 critics, one per res file, so lenses that share a res file share a critic
and the file is read once. A lens that cites two res files sits under its first cite, with the
second in brackets. Size is the res file in KB (measured 2026-09-30), for merging groups when
more than 6 are selected: merge the two with the least res text, and repeat.

| Res file | KB | Lenses that cite it |
|---|---|---|
| res_code-quality.md | 15 | concurrency-safety, error-handling, maintainability, performance-efficiency, test-coverage |
| res_operations.md | 14 | backup-recovery, observability, rollback-blast-radius |
| res_visual-design.md | 13 | brand-consistency, visual-ui-ux (also res_accessibility) |
| res_security.md | 13 | data-privacy, dependency-supply-chain, security-secrets |
| res_homelab.md | 13 | homelab-ops |
| res_pedagogy.md | 12 | pedagogy |
| res_agent-interfaces.md | 12 | absent-user-handoff, inference-legibility |
| res_decision-quality.md | 12 | alternatives-considered, assumptions-risk |
| res_data-analysis.md | 12 | cross-artifact-consistency (also res_technical-writing), data-quality, statistical-soundness |
| res_attention-design.md | 11 | attention-cost |
| res_accessibility.md | 11 | deep-accessibility |
| res_user-agency.md | 10 | agency-preservation |
| res_technical-writing.md | 10 | actionability, audience-fit, clarity, depth-sufficiency, necessity, structure-navigability, voice |
| res_reproducibility.md | 10 | idempotency-rerun-safety, reproducibility-portability |
| res_llm-safety.md | 10 | output-grounding, prompt-injection |
| res_interface-states.md | 9 | interface-state-coverage |
| res_resilience.md | 5 | resilience |
| res_api-design.md | 4 | api-contract |
| res_llm-eval.md | 4 | llm-eval |
| none | 0 | compliance-policy, cost-token-efficiency, data-provenance, operational-completeness |

Worked case, a `code` artifact with every general lens: code-quality, security, reproducibility,
interface-states, technical-writing, resilience, api-design and none make 8 groups. None (0 KB)
merges with api-design (4), and that group merges with resilience (5), leaving 6 critics. A user
lens backed by `.dd/res/<domain>.md` groups under that file the same way.

## User lenses

Also scan `.dd/lenses/*.md` in the working repo (and, if you keep a `.dd/` outside the repo
for use across projects, that one too). Read each candidate's
`## Fires on` to decide relevance, exactly like a shipped lens; back it with the user's
`.dd/res/*.md` where cited. A user lens whose filename matches a shipped lens **overrides** it;
a new name is a new lens. `.dd/` is only ever read, so plugin updates never touch it. No `.dd/`
means a no-op.
