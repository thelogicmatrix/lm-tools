# res_code-quality — The Code-Quality Bar
> Research-backed reference for the Due Diligence maintainability, performance, error-handling, and test-coverage lenses.

## What good looks like (the bar)

### Maintainability
- Depend on abstractions where change is expected, not everywhere. SOLID (Martin, 2000) is the vocabulary reviewers reach for [wikipedia-solid]:
  - **S**ingle Responsibility — one reason to change.
  - **O**pen/Closed — extend behavior without editing working code.
  - **L**iskov Substitution — a subtype must honor its parent's contract.
  - **I**nterface Segregation — don't force callers to depend on methods they don't use.
  - **D**ependency Inversion — depend on abstractions, not concretions.
  - Treat this as a checklist of *questions to ask*, not a mandate to apply all five to every class — the examples in the original paper are deliberately abstract and predate most modern languages [baeldung-solid].
- **The debate is real, represent it**: critics (David Bryant Copeland's *"SOLID is not Solid"*, r/programming) argue SOLID is over-applied by juniors trained to add interfaces/factories for one implementation, producing indirection with no payoff — the same "premature abstraction" YAGNI warns against.
  - The lazy-senior read: apply a SOLID principle when a second implementation, a real seam for testing, or a change you can already see coming justifies it — not speculatively.
- Same debate, sharper, around *Clean Code* (Robert Martin's book, distinct from SOLID): Casey Muratori's *"Clean Code, Horrible Performance"* showed that Clean-Code-style polymorphism/small-methods guidance can cost real order-of-magnitude runtime (branch prediction, cache locality) on hot paths [muratori-clean-code].
  - Martin's own reply conceded the performance point but drew the line at *category of software* — a calendar app optimizes for change; an engine's inner loop optimizes for speed, and you should know which one you're writing before applying either doctrine [unclebob-discussion].
  - Take from this: clarity/small-functions is the default, but hot-path code gets to break the rules and should say so.
- Reviewable proxy for "is this maintainable": cyclomatic complexity (McCabe, 1976) — count of independent paths through a function. No universal cutoff, but complexity > 10 is the commonly cited point to start splitting, and >20 is broadly treated as high-risk/hard-to-test regardless of language [wikipedia-cyclomatic].
- Fowler's *Refactoring* code-smell catalogue is the standard "what to flag" list, grouped as Bloaters (long method/class, long parameter list, primitive obsession), Object-Orientation Abusers (switch statements, refused bequest), Change Preventers (shotgun surgery — one change forces edits in many unrelated classes; divergent change — one class gets edited for many unrelated reasons), Dispensables (dead code, speculative generality, duplicate code), and Couplers (feature envy, message chains, middle man) [sourcemaking-smells].
- Naming and readability aren't cosmetic: most engineering time goes to reading existing code, not writing new code, so a clear name or an extracted, well-named function pays for itself the second time anyone (including the author) has to understand the call site — this is the uncontroversial half of Clean Code that survives the performance critique below.

### Performance
- The reviewable anti-patterns are concrete and cheap to spot in a diff, not abstract:
  - **N+1 queries**: looping over a result set and issuing one query per row instead of one batched/joined query. Classic ORM trap (Hibernate, ActiveRecord, Django ORM); fix is eager loading / batch fetch / a single join, not micro-tuning the loop [so-n-plus-1].
  - **O(n²) hot loops**: nested iteration over the same collection (e.g., `.find()`/`.includes()` inside a loop) where a set/map/index turns it linear. Fine at n=50, a production incident at n=500k.
  - **Unbounded memory**: loading a full table/file/response into memory with no cap — pagination, streaming, or a LIMIT should exist wherever the input size isn't guaranteed bounded.
  - **Missing pagination/indexing**: any endpoint or query returning "all rows" and any WHERE/JOIN/ORDER BY on an unindexed column at scale.
- Muratori's point generalizes past his specific example: "clean" and "fast" are different axes and sometimes trade off — the review question is whether the code is on a path where that trade-off matters (inner loop, called per-request) or not (config parsing, one-time setup) [muratori-clean-code].
- Don't flip this into premature optimization: the anti-patterns above (N+1, O(n²) on unbounded input, unbounded memory) are structural and cheap to catch by inspection; micro-tuning a path that isn't hot or hasn't been profiled is its own defect — it spends complexity budget for no measured gain.

### Error handling
- **Fail fast**: surface a problem as close to its cause as possible rather than letting bad state propagate.
  - Fowler's argument: failing loudly and immediately is *more* robust long-term than defensive code that silently limps on, because silent limping just moves the failure somewhere harder to diagnose [fowler-fail-fast].
- **No silent swallow**: an empty `catch`, a caught exception that's only logged and ignored, or a return of a default/null on failure without signaling it.
  - This is the single most common defect this lens should flag — it converts a detectable bug into corrupted downstream state.
- **Error vs. exception**: reserve exceptions for the exceptional/unexpected; expected failure paths (not-found, validation failure, retryable network error) read better as return values / Result types / Go-style explicit `error` returns, checked at the call site.
  - "if err != nil" is verbose, but every failure path stays visible in the diff — the explicit design goal of Go's approach [go-error-handling].
  - Joel Spolsky's older counter-position: exceptions create invisible control-flow paths a reader can't see without reading every callee, so his policy was "never throw your own, always catch everything a library might throw, at the boundary" [joel-exceptions].
  - Modern consensus leans toward Go/Rust-style explicit errors for expected failures and exceptions only for programmer-error/unrecoverable cases — cite this as the live tension, not a solved debate.
- **Retry/rollback**: retries need a cap + backoff (an uncapped retry loop is just a slower unbounded-memory bug) and must be idempotent-safe.
  - Anything that mutates state across steps needs a rollback/compensating action on partial failure, or a transaction wrapping it.
- **"Let it crash"** (Erlang, Joe Armstrong) is the legitimate counter-argument to defensive coding: for isolated, supervised processes, catching every possible error yourself is often worse than crashing the process and letting a supervisor restart it clean.
  - Appropriate when failures are isolated and restart is cheap — not a license to skip error handling in a monolith with shared state.

### Testing
- The test pyramid (Mike Cohn, *Succeeding with Agile*; popularized by Fowler): many fast unit tests, fewer service/integration tests, very few full end-to-end/UI tests.
  - The shape matters more than the exact layer names, which Fowler himself calls "overly simplistic" in modern practice [fowler-test-pyramid].
- The inverted shape — few unit tests, heavy reliance on slow/flaky E2E tests — is the "ice-cream cone" anti-pattern.
  - Google's testing blog is the canonical push-back: E2E tests are valuable for confidence but too slow/flaky/expensive to be the base of the pyramid, so push coverage down the stack wherever a lower layer can catch the same bug [google-e2e-tests].
- **Coverage ≠ confidence**: coverage is a tool for *finding untested code*, not a quality score — this is Fowler's explicit position, not a fringe take.
  - Chasing a coverage number (87%, 100%) produces low-value tests (assertion-free tests, tests of trivial getters) that hit the number while missing the risky paths that actually break in production [fowler-test-coverage].
  - A test with no assertion, or an assertion so loose it can't fail (`assert result is not None`), still counts toward the percentage while catching nothing — treat a high-coverage number on unfamiliar code as a reason to spot-check the assertions, not a reason to skip review.
- Practical rule this lens should enforce: tests should concentrate on what's *risky* — money paths, auth/permission checks, concurrency, external-boundary parsing, and anything with a non-obvious branch (matches the cyclomatic-complexity flag above) — not uniform coverage of every line.

### Concurrency safety
Only when the code shares mutable state across threads/processes/async tasks, or handles concurrent requests:
- **Race conditions / data races** — unsynchronised read-modify-write on shared state; two callers interleave and one update is lost. [CWE-362]
- **Check-then-act (TOCTOU)** — a condition checked, then acted on, without holding the guarantee across the gap, so another actor invalidates it in between (the time-of-check/time-of-use window). [CWE-367]
- **Non-atomic compound operations** — `x += 1`, "read balance → subtract → write", "check stock → decrement" must be atomic (lock, transaction, or atomic primitive); money, inventory, and counters especially.
- **Deadlock / livelock** — locks acquired in inconsistent order across code paths (hold-and-wait); fix with a global lock ordering or lock-free structures.
- **Shared mutable state** — prefer immutability, per-task copies, or message passing over shared memory; a mutated global/singleton is the usual culprit.
- **Idempotency ≠ concurrency-safety** — idempotency is safe to *re-run* (sequentially); concurrency-safety is safe to run *simultaneously*. A handler can be idempotent and still race. Check both; they're different guarantees.

## Common defects (what to attack)
- God object / God function doing unrelated things (SRP violation, Bloater).
- Interface/factory/abstraction with exactly one implementation and no second one in sight (speculative generality).
- Loop issuing a query/API call per iteration (N+1).
- Nested loop over the same collection where a map/set/index would make it linear.
- Load-everything-then-filter-in-memory instead of filtering/paginating at the source.
- Empty or log-only `catch`; error swallowed and a default/null returned instead.
- Retry loop with no cap, no backoff, or non-idempotent side effects on retry.
- Multi-step mutation with no rollback/transaction on partial failure.
- Exceptions used for expected/routine control flow (e.g., throwing on "not found").
- Function/method with cyclomatic complexity clearly in double digits and no tests around its branches.
- High overall coverage number but the risky branch (auth check, money calc, error path) has zero tests.
- Test suite dominated by slow E2E tests standing in for what a unit test could catch in milliseconds.

## Quick-reference checklist
- [ ] Each class/function has one clear reason to change (SRP) — flag God objects, not missing interfaces
- [ ] No interface/abstraction layer with a single implementation and no near-term second one
- [ ] No query/API call inside a loop — batch, join, or eager-load instead
- [ ] No nested loop over the same collection where an index/map/set would do
- [ ] No unbounded load of a table/file/response — pagination, streaming, or a LIMIT is present
- [ ] Every catch either handles the error meaningfully or re-raises — none are silent
- [ ] Expected failures (validation, not-found, timeout) use explicit returns/Result/error values, not exceptions
- [ ] Retries are capped, backed off, and safe to repeat (idempotent)
- [ ] Multi-step mutations roll back or use a transaction on partial failure
- [ ] Cyclomatic complexity of touched functions is sane (~<10) or justified with tests
- [ ] Tests concentrate on risky paths (money, auth, concurrency, parsing) not just line-count coverage
- [ ] Test suite shape is pyramid-like (many unit, some integration, few E2E) — not an inverted ice-cream cone
- [ ] Hot-path code that trades clarity for performance says so (comment/benchmark), it isn't accidental
- [ ] Shared-state read-modify-write is atomic; no check-then-act (TOCTOU) gap; locks in consistent order; concurrency verified separately from idempotency

## Sources
- [SOLID — Wikipedia](https://en.wikipedia.org/wiki/SOLID) — canonical definitions of the five principles and their rationale
- [A Solid Guide to SOLID Principles — Baeldung](https://www.baeldung.com/solid-principles) — origin (Martin's 2000 paper), plain-language explanation per principle
- ["SOLID is not Solid" discourse — r/programming](https://www.reddit.com/r/programming/comments/1n9ak7g/i_just_want_to_know_if_there_are_more_people/) — represents the practitioner critique that SOLID is over-applied/dogmatic
- ["Clean" Code, Horrible Performance — Casey Muratori](https://www.computerenhance.com/p/clean-code-horrible-performance) — measured performance cost of Clean-Code-style OOP patterns on hot paths
- [unclebob/cmuratori-discussion — GitHub](https://github.com/unclebob/cmuratori-discussion/blob/main/cleancodeqa.md) — Robert Martin's direct reply; the "software category" reconciliation (clarity vs. speed)
- [Cyclomatic complexity — Wikipedia](https://en.wikipedia.org/wiki/Cyclomatic_complexity) — McCabe's metric, common risk thresholds
- [Code Smells catalogue — SourceMaking / refactoring.guru](https://sourcemaking.com/refactoring/smells) — Fowler's *Refactoring* smell categories (Bloaters, OO Abusers, Change Preventers, Dispensables, Couplers)
- [What is the N+1 selects problem — Stack Overflow](https://stackoverflow.com/questions/97197/what-is-the-n1-selects-problem-in-orm-object-relational-mapping) — canonical definition and ORM fixes (eager loading/batching)
- [Fail Fast — Martin Fowler (IEEE Software)](https://martinfowler.com/ieeeSoftware/failFast.pdf) — the case for surfacing errors immediately vs. defensive limping
- [Exceptions — Joel Spolsky](https://www.joelonsoftware.com/2003/10/13/13/) — the case against exceptions as invisible control flow
- [Error handling and Go — The Go Blog](https://go.dev/blog/error-handling-and-go) — explicit error-value philosophy as the counter-position to exceptions
- [The Practical Test Pyramid — Martin Fowler](https://martinfowler.com/articles/practical-test-pyramid.html) — pyramid shape, origin (Mike Cohn), and its acknowledged oversimplification
- [Just Say No to More End-to-End Tests — Google Testing Blog](https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html) — the ice-cream-cone anti-pattern and why E2E-heavy suites fail
- [Test Coverage — Martin Fowler](https://martinfowler.com/bliki/TestCoverage.html) — coverage as a gap-finder, not a confidence score; Brian Marick's "expect vs. require" distinction
- [CWE-362 Concurrent Execution using Shared Resource (Race Condition)](https://cwe.mitre.org/data/definitions/362.html) and [CWE-367 TOCTOU](https://cwe.mitre.org/data/definitions/367.html) — MITRE definitions for the race and check-then-act weakness classes
