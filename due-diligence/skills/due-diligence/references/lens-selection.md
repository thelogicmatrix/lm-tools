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
| external-send | compliance-policy, data-privacy, attention-cost |
| proposal, plan, recommendation | assumptions-risk, alternatives-considered, agency-preservation |
| educational | pedagogy |

## User lenses

Also scan `.dd/lenses/*.md` in the working repo (and, if you keep a `.dd/` outside the repo
for use across projects, that one too). Read each candidate's
`## Fires on` to decide relevance, exactly like a shipped lens; back it with the user's
`.dd/res/*.md` where cited. A user lens whose filename matches a shipped lens **overrides** it;
a new name is a new lens. `.dd/` is only ever read, so plugin updates never touch it. No `.dd/`
means a no-op.
