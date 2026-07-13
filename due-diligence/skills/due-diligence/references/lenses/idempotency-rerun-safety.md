# Idempotency & Rerun Safety — catches operations that break or duplicate on retry
> Cites: res_reproducibility.md

## Fires on
Tags: pipeline, cron, infra. Any artifact where a step can run more than once — retries, reruns, scheduled jobs, deploy/provisioning scripts.

## Attacks
- Non-idempotent writes: a POST/create endpoint or write step with no idempotency key, dedupe check, or unique constraint — retried on timeout, it double-creates.
- No idempotency key: retry logic sits on top of a non-idempotent operation, so the retry itself becomes the bug.
- Non-upserting setup/provisioning: a "setup" or provisioning script that isn't safe to run twice (appends instead of upserting, errors on already-exists instead of no-op'ing).
- Partial-failure inconsistency: a multi-step operation that fails partway leaves state inconsistent, with no re-run path to converge.
- Destructive step lacks a guard: a destructive action (delete, overwrite, drop) with no check for "already done" before it fires again.
- Spec-safe endpoint with side effects: a GET/DELETE (or other endpoint that's supposed to be idempotent-by-spec) has observable side effects on repeat calls, violating the RFC 9110 contract clients/proxies rely on.
- Weak idempotency key: key generated from mutable or non-unique input (timestamp, sequential counter) instead of a random UUID — collision risk defeats the guarantee.

## Evidence of attack (clean-pass proof)
Trace a double-run of the operation end to end: run it once, capture resulting state (rows created, files written, side effects fired), then run it again with identical inputs and diff the state. Confirm no duplicate records, no doubled side effects, and any partial-failure path converges to the same end state on retry rather than compounding. Name the specific mutating steps traced and what state was compared, not "looks safe to rerun."

## Severity guide
- blocker: a double-run corrupts data or duplicates side effects (double-charge, double-create, double-send).
- should-fix: a double-run is survivable but needs manual cleanup on retry (orphaned rows, requires a rerun of a fix-up step).
- nit: cosmetic — e.g. a harmless duplicate log line or a no-op warning on rerun.
