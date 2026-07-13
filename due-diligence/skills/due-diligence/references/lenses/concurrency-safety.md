# concurrency-safety — Is it safe to run simultaneously, not just to re-run?
> Cites: res_code-quality.md (Concurrency safety)

## Fires on
Tags: code, pipeline. Select when the code shares mutable state across threads/processes/async tasks, or handles concurrent requests. Skip for strictly single-threaded/sequential code. Different guarantee from idempotency-rerun-safety: that's safe to *re-run*; this is safe to run *at the same time*.

## Attacks
- Race condition / lost update: unsynchronised read-modify-write on shared state — two callers interleave and one write vanishes. [CWE-362]
- Check-then-act / TOCTOU: a condition checked then acted on without holding the guarantee across the gap, so another actor invalidates it between. [CWE-367]
- Non-atomic compound op on a money/inventory/counter path: `x += 1`, "read → subtract → write", "check stock → decrement" with no lock/transaction/atomic primitive.
- Deadlock risk: locks acquired in inconsistent order across paths (hold-and-wait), no global lock ordering.
- Shared mutable global/singleton mutated from concurrent contexts where immutability, per-task copies, or message passing should be used.

## Evidence of attack (clean-pass proof)
Identify the shared mutable state and the concurrent access paths. For each, confirm the read-modify-write is atomic (lock/transaction/atomic type), there's no check-then-act gap, and lock ordering is consistent. State explicitly that concurrency was checked *separately* from idempotency. Name the race window or confirm it's guarded — not "looks thread-safe."

## Severity guide
- blocker: a real race on a money/inventory/state-critical path (lost update, TOCTOU) that corrupts data or double-acts under concurrency.
- should-fix: an unsynchronised shared-state access or check-then-act gap on a non-critical path; a plausible deadlock ordering.
- nit: shared mutable state that works but would be safer as immutable/message-passed.
