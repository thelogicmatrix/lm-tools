# observability — Can you tell it's working, and know first when it isn't?
> Cites: res_operations.md (Observability)

## Fires on
Tags: deploy, infra, cron, pipeline. Any long-running or scheduled system whose failures matter. Distinct from error-handling (which is about *handling* a failure) — this is about *noticing* it: would you learn of an outage from your instruments, or from users?

## Attacks
- No metrics on the golden signals (latency, traffic, errors, saturation) — no way to see health at a glance.
- Logs unstructured or uncorrelatable (no request/trace id), so an incident can't be reconstructed; or logs carrying secrets/PII (cross-ref security).
- Alerting absent — a failure runs silent until a human or user stumbles on it.
- Alert noise / fatigue — so many low-value pages that real signals get ignored; alerts on internal causes instead of user-facing symptoms.
- No SLI/SLO — "reliable" claimed with nothing measured; no error budget to reason about trade-offs.
- No health/readiness endpoint; retention too short to debug after the fact.

## Evidence of attack (clean-pass proof)
Name what's instrumented: which golden signals have metrics, whether logs are structured/correlatable/PII-free, what alerts exist and whether they're symptom-based and actionable, and whether an SLI/SLO is defined. Confirm you could detect and debug a failure without a user reporting it — or name the blind spot.

## Severity guide
- blocker: a failure would run completely silent (no metrics, no alerts) — the system can break and no one is told.
- should-fix: partial coverage — some signals unmonitored, alerts noisy or cause-based, no SLO, logs hard to correlate.
- nit: a dashboard could add a panel; an alert threshold could be tuned.
