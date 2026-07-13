# Reproducibility & Portability — catches work that only runs on the author's machine
> Cites: res_reproducibility.md

## Fires on
Tags: code, runbook, deploy, migration, infra. Any artifact that someone else (or a fresh checkout/CI box) must be able to build, run, or follow.

## Attacks
- Hardcoded paths: absolute paths (`/Users/dev/project`, `C:\Users\...`) instead of relative/env-derived paths.
- Undeclared dependencies: code uses a library or shells out to a system tool (curl, ImageMagick) never declared in a manifest.
- No lockfile: missing or uncommitted lockfile — reruns can silently pick up a newer transitive dependency.
- Hardcoded config: credentials, hostnames, or feature flags baked into source instead of env vars.
- Missing setup docs: no documented path from clean checkout to running app.
- Dev/prod parity gap: dev uses a materially different backing service than prod (SQLite vs. Postgres, in-memory cache vs. Redis).
- Non-reproducible build output: embedded timestamp, build path, hostname, or locale-dependent formatting.
- Machine-specific assumptions: setup or scripts assume a specific account, worktree layout, or OS not documented as a prerequisite.

## Evidence of attack (clean-pass proof)
Walk it as if starting from a fresh machine and clean checkout: list every dependency used in the code and confirm each is in the manifest; confirm a lockfile is present and committed; confirm every path referenced is relative or comes from config/env, not hardcoded; confirm every env var the code reads is named in setup docs with an example value; confirm the documented setup steps, run in order, would reach a running state with no undocumented tribal-knowledge step. Name the specific files/lines checked, not "looks portable."

## Severity guide
- blocker: won't run on another machine at all without an undocumented step (missing dep, hardcoded absolute path, missing required env var).
- should-fix: runs elsewhere but is fragile — no lockfile, dev/prod parity gap, undocumented but guessable setup step.
- nit: cosmetic portability polish — e.g. an env var has a sensible default but isn't documented, minor path cleanup.
