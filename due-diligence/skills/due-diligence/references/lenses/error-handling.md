# error-handling — Does a failure get surfaced, or does it get lost?
> Cites: res_code-quality.md

## Fires on
Tags: code. Any artifact containing try/catch, error returns, retries, or multi-step mutations.

## Attacks
- Silent swallow: an empty or log-only `catch`, or a caught exception whose failure isn't signaled to the caller — the single most common defect this lens should flag, per the res file.
- Data loss on failure: a caught error that returns a default/null and lets the caller proceed as if it succeeded, corrupting downstream state.
- No retry cap/backoff: a retry loop with no limit or backoff (an uncapped retry is a slower unbounded-memory bug), or a retry that isn't idempotent-safe.
- No rollback on partial failure: a multi-step mutation with no rollback/compensating action or transaction wrapping it.
- Error-vs-exception misuse: exceptions used for expected/routine control flow (e.g., throwing on "not found") instead of an explicit return/Result/error value.
- Unhandled failure path: a call that can fail (network, parse, I/O) with no handling at all, not even a swallow — the failure propagates uncontrolled.

## Evidence of attack (clean-pass proof)
Name each failure path in the touched code (each catch, each fallible call, each multi-step mutation) and state what happens on failure: re-raised, handled meaningfully, or rolled back. "Error handling looks fine" is not evidence; "catch at line X re-raises after logging; retry at line Y capped at 3 with backoff; multi-step write at line Z wrapped in a transaction" is.

## Severity guide
- blocker: loses data or hides a failure — silent swallow, uncapped/non-idempotent retry, unhandled failure path on a data-mutating call.
- should-fix: degrades ungracefully — no rollback on a partial multi-step mutation, exceptions used for expected control flow.
- nit: message quality — a caught/handled error with a vague or unhelpful message.
