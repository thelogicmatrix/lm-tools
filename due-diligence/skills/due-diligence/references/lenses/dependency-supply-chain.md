# dependency-supply-chain — Can you trust what built this, and what it pulled in?
> Cites: res_security.md

## Fires on
Tags: code. Any artifact with a dependency manifest, lockfile, or CI/build pipeline definition.

## Attacks
- Unpinned/unverified dependencies: versions pulled at build time with no lockfile integrity and no checksum/signature verification.
- Vulnerable/outdated components: known-CVE or stale dependency with no update or advisory-monitoring process in place.
- No dependency inventory: no SBOM, so "are we affected by CVE-X" requires a manual audit instead of a lookup.
- Missing build provenance: no verifiable link from artifact back to the source commit and build steps that produced it (SLSA Build Track L1-L3).
- Source-side tampering exposure: no branch protection, no required review, or force-push allowed on release branches (SLSA Source Track).
- CI/CD integrity failure: pipeline lacks verification, letting an unsigned or tampered dependency/plugin/update flow through (OWASP 2025 A08 Software/Data Integrity Failures).

## Evidence of attack (clean-pass proof)
Per category, name what was traced: the lockfile is present and versions are pinned/checksummed, the flagged dependency was checked against an advisory source and has no open CVE on the code path used, branch protection/required-review settings were confirmed on the release branch. "Dependencies look fine" without naming the manifest/lockfile/advisory check performed is not evidence.

## Severity guide
- blocker: a known-exploitable vulnerability in a dependency on a path the code actually uses.
- should-fix: unpinned or outdated dependency with an open advisory, or no lockfile at all.
- nit: an unused or redundant dependency that isn't exploitable but adds surface area.
