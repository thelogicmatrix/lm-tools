# resilience — Does it survive a slow, flaky, or dead dependency?
> Cites: res_resilience.md

## Fires on
Tags: code, infra, pipeline, llm-pipeline. Select when the artifact makes network/DB/external/LLM calls or depends on services that can fail. Distinct from error-handling (catch a local error) and observability (notice a failure) — this is *keep working when a dependency doesn't*.

## Attacks
- Unbounded/absent timeout on a network, DB, external, or LLM call — the caller can hang forever, piling up threads.
- Retries with no backoff/jitter (retry storm that DoSes a recovering service), or retrying a non-idempotent op (duplicate side effects).
- No circuit breaker on a flaky external dependency — repeated calls to a dead service cascade latency/failure back to users.
- No bulkhead — one slow dependency exhausts a shared thread/connection pool and takes the whole service down.
- No fallback/degradation — a non-critical dependency failure hard-fails the entire request instead of degrading (cached/default/partial).
- No load shedding / rate limit — overload builds an unbounded queue and collapses.
- Nested retries (client retries what the server already retries) → multiplicative amplification.

## Evidence of attack (clean-pass proof)
List each external/remote call and confirm: it has a bounded timeout; retries (if any) are capped, backed-off+jittered, and wrap only idempotent ops; a flaky dependency has a breaker; shared pools are bulkheaded; non-critical failures degrade. Name the missing guard or confirm each with the specific call site. Not "handles errors."

## Severity guide
- blocker: an absent timeout or missing breaker on a critical dependency that can hang or cascade-fail the whole system under a realistic outage.
- should-fix: retries without backoff/jitter, no bulkhead on a shared pool, no fallback on a non-critical dependency.
- nit: a fallback that could be richer; a timeout tuned conservatively.
