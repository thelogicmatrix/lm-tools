# data-privacy — Is personal data leaked, over-collected, or misused?
> Cites: res_security.md (Secrets & PII leakage + Data-protection principles)

## Fires on
Tags: data-export, external-send, data-analysis. Any artifact that handles, moves, or exposes personal/customer data. Complements the generic compliance-policy lens with a dedicated PII/privacy focus — critical here: the hard rule is no PII in git, cloud services/APIs, or external logs.

## Attacks
- PII leaving the boundary: personal data in git, a commit, a cloud API/SaaS call, an LLM prompt, a ticket, or external logs — the exfiltration vector, per the project's hard no-PII rule.
- PII in logs/errors/traces or full request/response bodies; sensitive data with weak/absent encryption at rest or in transit.
- Over-collection: more personal data collected/retained than the stated purpose needs (minimisation failure) — a defect even if nothing leaks.
- Repurposing without basis: data used beyond what it was collected for (purpose limitation).
- No retention limit: personal data hoarded indefinitely with no deletion path.
- No lawful basis/consent for processing (esp. tracking/marketing); pre-ticked or absent consent.
- No subject-rights path: access/deletion not possible.

## Evidence of attack (clean-pass proof)
Name every field/flow carrying personal data and where it goes; confirm none crosses to git/cloud/external logs/LLM (or flag the exact leak). State whether collection is minimised to purpose, whether a retention limit exists, and the lawful basis. "No PII issues" without naming the data flows is not evidence.

## Severity guide
- blocker: PII leaves the boundary (git/cloud/API/LLM/external log), or sensitive data unencrypted where it must be — the hard-rule violation.
- should-fix: over-collection, no retention limit, missing/weak consent basis, PII in an internal log.
- nit: a field that could be minimised further; a retention window that could be tighter.
