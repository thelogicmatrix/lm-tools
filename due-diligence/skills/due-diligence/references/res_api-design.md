# res_api-design — The Interface-Contract Bar
> Research-backed reference for the Due Diligence api-contract lens. Whether an exposed interface (HTTP API, library, CLI, module boundary) is stable, predictable, and safe for consumers to depend on.

## What good looks like (the bar)

- **Backward compatibility is the default.** Additive changes (a new optional field, a new endpoint) don't break existing consumers and are safe. Removing or renaming a field, changing its type, tightening validation, or changing the *meaning* of a response is a **breaking change** and must not ship silently. [SemVer 2.0.0]
- **Semantic versioning communicates compatibility.** MAJOR.MINOR.PATCH: MAJOR = incompatible API changes, MINOR = backward-compatible additions, PATCH = backward-compatible fixes. A breaking change without a MAJOR bump is a defect. [semver.org]
- **Deprecate, don't delete.** Mark the old thing deprecated, keep it working through a documented sunset window with a warning and a migration path, and remove only after consumers have had time to move.
- **Contracts are consistent and predictable.** Consistent naming, error shape, and status codes across the surface; documented. HTTP verbs match their semantics — GET is safe and idempotent (no side effects), PUT/DELETE are idempotent, POST is neither. [REST / Fielding; Microsoft & Google API design guides]
- **Collection responses are bounded.** List/collection endpoints paginate (limit + cursor/offset) and never return an unbounded result set — the caller must be able to get *all* the data across pages, and the server must not choke on a huge one. (A default row cap that silently truncates results — e.g. PostgREST's 1000-row default — is this defect.)
- **Errors are structured and actionable.** A machine-readable error code plus a human-readable message; correct status codes; no leaking of stack traces, internal paths, or secrets in error bodies.
- **Unsafe operations support idempotency.** POST/payment-like operations accept an idempotency key so a client retry (network blip) doesn't double-act — cross-refs resilience and concurrency-safety.

## Common defects (what to attack)
- Breaking change shipped with no version bump: a removed/renamed/retyped field, tightened validation, or changed response semantics that silently breaks existing consumers.
- No versioning strategy at all — consumers can't tell what's safe to depend on.
- Hard removal of an endpoint/field with no deprecation window or migration path.
- Unbounded collection response — no pagination/limit, so the client can't retrieve everything (silent truncation) or the endpoint times out on large data.
- Inconsistent error shapes/status codes across the surface; internals or secrets leaked in error bodies.
- Wrong verb semantics — a GET with side effects, a non-idempotent PUT, a POST used where retries will double-act.
- Non-idempotent unsafe operation with no idempotency key — a client retry causes a duplicate charge/insert.

## Quick-reference checklist
- [ ] Any breaking change (removed/renamed/retyped field, changed semantics) carries a MAJOR version bump
- [ ] Removed surface went through a documented deprecation + sunset window, not a hard delete
- [ ] Naming, error shape, and status codes are consistent across the surface and documented
- [ ] Collection endpoints paginate; no unbounded result set; the client can page through *all* records
- [ ] Errors are structured (code + message), correct status, and leak no internals/secrets
- [ ] HTTP verbs match semantics (GET safe/idempotent, PUT/DELETE idempotent, POST guarded)
- [ ] Unsafe operations accept an idempotency key so client retries don't double-act

## Sources
- [Semantic Versioning 2.0.0](https://semver.org/) — MAJOR/MINOR/PATCH definitions; breaking-change = MAJOR.
- [Microsoft REST API Guidelines](https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md) and [Google API Improvement Proposals (AIPs)](https://google.aip.dev/) — versioning, pagination, error models, backward-compatibility rules as industry standards.
- [Roy Fielding — REST dissertation, ch.5](https://ics.uci.edu/~fielding/pubs/dissertation/rest_arch_style.htm) — verb semantics (safe/idempotent), uniform interface.
- [Stripe API — Idempotent requests](https://docs.stripe.com/api/idempotent_requests) — canonical idempotency-key pattern for safe retries on unsafe operations.
