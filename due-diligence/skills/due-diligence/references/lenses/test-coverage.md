# test-coverage — Are the risky paths actually tested, or just counted?
> Cites: res_code-quality.md

## Fires on
Tags: code. Any artifact containing tests, or logic (money, auth, concurrency, parsing) that should have tests.

## Attacks
- Risky paths untested: money paths, auth/permission checks, concurrency, external-boundary parsing, or a non-obvious branch (matches the cyclomatic-complexity flag) with no test around it.
- Coverage % treated as confidence: a high line/coverage number cited as proof of quality — Fowler's explicit position is coverage finds untested code, it isn't a quality score.
- No edge/failure-case tests: tests only exercise the happy path; error paths, empty/null input, and boundary values are untested.
- Assertion-free tests: a test that runs code but asserts nothing meaningful, or an assertion so loose it can't fail (`assert result is not None`) — counts toward coverage while catching nothing.
- Ice-cream-cone shape: suite dominated by slow/flaky E2E tests standing in for what a unit test could catch in milliseconds, per the res file's pyramid/ice-cream-cone distinction.

## Measure
Public functions or branches with at least one test ÷ total, from the test files present. Report
as "n/N". A money, security or data-mutating path with 0 tests = blocker. Below 50% overall =
should-fix.

## Evidence of attack (clean-pass proof)
Name which risky paths (money calc, auth check, concurrency, parsing) have tests and quote or describe the actual assertion — not just "covered." If a coverage number is cited, spot-check that the assertions in the high-coverage file are real, not vacuous. State the suite's rough shape (unit vs. integration vs. E2E ratio) if relevant to the change.

## Severity guide
- blocker: a money/security/data-mutating path has no test at all.
- should-fix: thin coverage on real logic — happy-path-only tests, or loose/near-vacuous assertions on a non-trivial function.
- nit: missing a test for a trivial, low-risk path (e.g., a pure getter).
