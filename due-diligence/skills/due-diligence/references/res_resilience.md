# res_resilience — The Fault-Tolerance Bar
> Research-backed reference for the Due Diligence resilience lens. How a system behaves when a dependency is slow, flaky, or down — distinct from error-handling (catching a local error) and observability (noticing a failure).

## What good looks like (the bar)

- **Every remote call has a timeout.** No unbounded waits. A hung dependency must never hang the caller indefinitely — an absent timeout is the most common cause of cascading failure, because threads pile up waiting. [Nygard, *Release It!* — Timeouts]
- **Retries are bounded, backed-off, and jittered.** Retry only *safe/idempotent* operations; use exponential backoff with **jitter** to avoid a synchronized retry storm (thundering herd) that DoSes a recovering dependency; cap total attempts with a retry budget. [AWS — Timeouts, retries, and backoff with jitter]
- **Circuit breakers stop cascading failure.** After N consecutive failures, "open" the breaker and fail fast for a cooldown instead of hammering a dead dependency; periodically "half-open" to test recovery, then close. Gives the failing service room to recover and frees the caller's resources. [Nygard — Circuit Breaker; Fowler — CircuitBreaker]
- **Bulkheads isolate failure.** Partition resources (separate thread/connection pools per dependency) so one saturated or slow dependency can't starve the resources the rest of the system needs. [Nygard — Bulkhead]
- **Graceful degradation over hard failure.** When a *non-critical* dependency is down, degrade the feature (serve cached/default/partial data, hide the section) rather than failing the whole request. Fallbacks are defined ahead of time, not improvised.
- **Fail fast and shed load under overload.** Reject early (load shedding, rate limits, bounded queues) when saturated, rather than accepting unbounded work that collapses the system. A fast rejection beats a slow timeout for everyone.
- **Retries require idempotency.** Retrying a non-idempotent operation double-acts (double charge, double insert). Safe retry needs idempotency keys or dedup — cross-refs the concurrency-safety and idempotency-rerun-safety lenses.

## Common defects (what to attack)
- Unbounded or absent timeout on any network/DB/external/LLM call — the caller can hang forever.
- Retries with no backoff/jitter (retry storm), or retrying a non-idempotent op (duplicate side effects).
- No circuit breaker on a flaky external dependency — repeated calls to a down service, latency/failure cascading back to users.
- No bulkhead — one slow dependency exhausts a shared thread/connection pool and takes the whole service down (the classic full-thread-pool outage).
- No fallback/degradation — a non-critical dependency failure returns a hard error for the whole request.
- No load shedding or rate limit — overload builds an unbounded queue that collapses under its own weight.
- Retry layered on retry (client retries an operation the server also retries) → multiplicative amplification.

## Quick-reference checklist
- [ ] Every remote/external call has an explicit, bounded timeout
- [ ] Retries are capped, use exponential backoff + jitter, and only wrap idempotent operations
- [ ] Flaky external dependencies sit behind a circuit breaker (fail-fast + recovery probe)
- [ ] Shared resource pools are bulkheaded so one dependency can't starve the rest
- [ ] Non-critical dependency failures degrade gracefully (fallback/cached/partial), not hard-fail
- [ ] Overload is shed early (rate limit / bounded queue), not absorbed into collapse
- [ ] No nested/multiplicative retry layers between client and server

## Sources
- Nygard, *Release It! Design and Deploy Production-Ready Software* (2nd ed.) — the canonical stability-patterns set: Timeouts, Circuit Breaker, Bulkhead, Fail Fast, and the anti-patterns (cascading failure, slow responses, unbounded result sets).
- [Amazon Builders' Library — Timeouts, retries, and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) — why jitter matters, retry budgets, avoiding retry storms.
- [Martin Fowler — CircuitBreaker](https://martinfowler.com/bliki/CircuitBreaker.html) — states (closed/open/half-open) and the recovery-probe mechanism.
- [Google SRE Book — Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/) — load shedding, graceful degradation, and how overload propagates.
