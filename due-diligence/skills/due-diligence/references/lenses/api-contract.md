# api-contract — Is the interface stable and safe to depend on?
> Cites: res_api-design.md

## Fires on
Tags: code, doc-describes-code. Select when the artifact exposes an interface others consume — HTTP API, library/module boundary, CLI, or a documented contract. Skip for purely internal single-caller code.

## Attacks
- Breaking change with no version bump: a removed/renamed/retyped field, tightened validation, or changed response semantics that silently breaks existing consumers.
- No versioning strategy — consumers can't tell what's safe to depend on.
- Hard removal of an endpoint/field with no deprecation window or migration path.
- Unbounded collection response: no pagination/limit, so the caller can't retrieve all records (silent truncation — the PostgREST 1000-row cap) or the endpoint chokes on large data.
- Inconsistent error shapes/status codes across the surface; internals, stack traces, or secrets leaked in error bodies.
- Wrong verb semantics: a GET with side effects, a non-idempotent PUT, or a POST where client retries will double-act.
- Unsafe operation with no idempotency key — a client retry causes a duplicate charge/insert.

## Evidence of attack (clean-pass proof)
Identify the interface surface and its consumers. Check the diff for breaking changes vs the prior version and whether versioning/deprecation covers them; confirm collection endpoints paginate and a client can page through everything; confirm error shape consistency and no leaked internals; confirm verb semantics and idempotency on unsafe ops. Name the break or confirm compatibility with specifics.

## Severity guide
- blocker: a silent breaking change to a consumed contract, or an unbounded/truncating collection response that loses data.
- should-fix: no versioning/deprecation strategy, inconsistent error contract, non-idempotent unsafe op with no key.
- nit: naming inconsistency with no functional impact; error message wording.
