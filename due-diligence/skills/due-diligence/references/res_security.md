# res_security — The Security Bar
> Research-backed reference for the Due Diligence security-secrets and dependency-supply-chain lenses.

## What good looks like (the bar)

- **Deny by default, verify every request.** Access control decisions happen server-side, on every request, using centralized logic — not scattered per-endpoint checks or trust in client-supplied state (OWASP Top 10 A01:2025 Broken Access Control, OWASP Authorization Cheat Sheet).
- **Least privilege everywhere.** Services, tokens, and users hold the minimum scope needed, expiring when no longer required (OWASP Authorization Cheat Sheet; Secrets Management Cheat Sheet §2.3).
- **Untrusted input is never trusted.** Use parameterized/safe APIs first; allowlist validation and contextual escaping are fallbacks, not primary defenses (OWASP Injection Prevention Cheat Sheet, Rules #1–#3).
- **Secrets live in a manager, not in the repo or the artifact.** Centralized secret store, short-lived/rotatable credentials, no secrets in code, config committed to git, build logs, or LLM/agent output (OWASP Secrets Management Cheat Sheet §2, §3.2).
- **No PII leaves the trust boundary uncontrolled.** Sensitive data is classified, minimized, and never appears in git history, third-party APIs/cloud logging, or shared external context — this is a hard rule for this project, not just best practice (OWASP Top 10 A04:2025 Cryptographic Failures covers exposure of sensitive data at rest/in transit; Secrets Management Cheat Sheet's detection/incident-response sections generalize directly to PII).
- **Builds are traceable to source.** CI produces signed provenance on a hardened, non-tamperable build platform, so consumers can verify what actually produced an artifact (SLSA Build Track, levels L1–L3).
- **Verification is risk-scaled, not all-or-nothing.** ASVS 5.0 organizes ~350 requirements across 17 chapters into 3 cumulative levels — Level 1 (baseline, automatable, ~20% of requirements) for low-risk apps, Level 2 (standard, mixed automated+manual, ~50%) as the default for apps handling sensitive data, Level 3 (advanced, threat-modeled, pen-tested, ~30%) for banking/identity/critical systems. Levels can be mixed per component.
- **Fail closed and log the failure.** Authorization/crypto/parsing errors deny access and produce an alertable log event, not a silent allow or an unhandled exception leaking internals (OWASP Top 10 A10:2025 Mishandling of Exceptional Conditions; A09:2025 Security Logging & Alerting Failures).
- **Passwords and tokens are never stored reversibly.** Passwords use a slow, salted hash (bcrypt/scrypt/Argon2); session/API tokens are random, high-entropy, and scoped — plaintext or fast-hash (MD5/SHA1) storage is a Cryptographic Failure, not a style choice.

## Common defects (what to attack)

**Injection**
- Building queries/commands/HTML via string concatenation instead of parameterized APIs — the #1 and #2 ranked weaknesses in the 2025 CWE Top 25 are XSS (CWE-79) and SQL Injection (CWE-89).
- Shelling out to OS commands with user-influenced arguments (CWE-78, OS Command Injection; CWE-77/94, generic command/code injection) — all in the CWE Top 25.
- Deserializing untrusted data without type/schema restriction (CWE-502) — a top-15 CWE, common in Java/Python pickle-style code paths.
- Path traversal from unsanitized filenames (CWE-22) reaching file read/write/include.

**Authorization (Broken Access Control — #1 risk in OWASP Top 10 2021 and 2025)**
- Missing authorization checks entirely (CWE-862, rank #4 in 2025 CWE Top 25) or checking authentication but not authorization (confusing "who are you" with "what can you do").
- Insecure Direct Object Reference / IDOR: object IDs guessable or not re-validated against the caller's permissions on every request (Authorization Cheat Sheet: "Validate the Permissions on Every Request").
- CSRF (CWE-352, rank #3 in 2025 CWE Top 25) — state-changing requests with no anti-CSRF token or SameSite protection.
- Server-Side Request Forgery (CWE-918) — now folded into Broken Access Control in OWASP Top 10 2025 rather than its own category; still a distinct code smell: server fetches attacker-influenced URLs.
- Authorization logic re-implemented ad hoc per endpoint instead of centralized — the exact anti-pattern the Authorization Cheat Sheet warns against.
- Incorrect authorization (CWE-863) and missing authentication for a critical function (CWE-306) — both climbing fast in the 2025 CWE Top 25 (+1 and +4 rank respectively), suggesting these are increasingly caught in real audits, not just theory.

**Note on memory-safety CWEs:** roughly a third of the 2025 CWE Top 25 (out-of-bounds read/write, use-after-free, buffer overflows — CWE-787/125/416/120/121/122) is native-code memory corruption. High-severity, but only relevant to C/C++/Rust-adjacent codebases; for typical web apps, services, and scripts the attack surface concentrates in injection, authz, secrets, and config below.

**Secrets & PII leakage** (hard rule for this project: no PII in git, cloud services/APIs, or external logs)
- Hardcoded credentials, API keys, or tokens in source, config files, or commit history (OWASP Secrets Management Cheat Sheet §8.2 lists the common types: connection strings, API keys, private keys, session tokens).
- Secrets or PII written to logs, error messages, stack traces, or debug output — "secrets/PII must never be logged" is an explicit lifecycle requirement, not a nice-to-have.
- Secrets/PII pasted into an LLM prompt, ticket, or third-party SaaS call — the code-review equivalent of exfiltration; treat any external API/service call carrying user data as a leak vector.
- No rotation path: a leaked secret can't be revoked and reissued quickly (Secrets Management Cheat Sheet §9.2 Remediation: revoke → rotate → delete, including scrubbing from logs and considering git-history rewrite).
- Sensitive data exposure via weak/absent encryption at rest or in transit, or logging full request/response bodies that contain customer data (OWASP Top 10 A04:2025 Cryptographic Failures).

**Data-protection principles** (privacy, beyond leak-prevention — where the artifact *collects or processes* personal data)
- **Minimisation**: collect and retain only the personal data the stated purpose needs — over-collection is a defect even if nothing leaks.
- **Purpose limitation**: data used only for what it was collected for; repurposing (e.g. support data fed into marketing) needs a fresh basis.
- **Retention limits**: deleted when no longer needed; no indefinite hoarding "just in case."
- **Consent / lawful basis**: a defined basis for processing, especially for tracking/marketing; consent genuine, not pre-ticked.
- **Subject rights**: access and deletion are possible. Singapore PDPA and EU GDPR (Art.5) converge on these — distinct from the leak-prevention rules above: a system can leak nothing yet still over-collect, over-retain, or repurpose without basis.

**Unsafe defaults**
- Security Misconfiguration jumped from #5 (2021) to #2 (2025 OWASP Top 10) — default credentials, verbose error pages, unnecessary features/ports enabled, missing security headers, permissive CORS.
- Fail-open error handling: an exception in an auth/crypto path that defaults to "allow" instead of "deny" (OWASP Top 10 A10:2025 Mishandling of Exceptional Conditions, a new 2025 category).
- Missing rate limiting / resource limits enabling DoS (CWE-770, rank #25 in 2025 CWE Top 25).
- Weak or missing input validation at trust boundaries (CWE-20) — still top-20 despite being one of the oldest known weakness classes.

**Supply-chain**
- Unpinned or unverified dependencies pulled at build time — no lockfile integrity, no checksum/signature verification.
- No build provenance: consumers can't tell what source, commit, or build process produced a given artifact (SLSA Build Track requirement, levels L1–L3).
- Software/data integrity failures: CI/CD pipeline lacks integrity verification, allowing unsigned or tampered updates/plugins/dependencies to flow through (OWASP Top 10 A08:2025 Software or Data Integrity Failures).
- Vulnerable/outdated components with no update or advisory-monitoring process — the seed category that OWASP 2025 expanded into "A03:2025 Software Supply Chain Failures," broadening scope to build systems and distribution infrastructure, not just outdated libraries.
- Source-side tampering: no branch protection, no required review, force-push allowed on release branches (SLSA v1.2 added a Source Track specifically for this class of threat, alongside the existing Build Track).
- No SBOM or dependency inventory — can't answer "are we affected by CVE-X" without a manual audit; a prerequisite for hitting even SLSA Build L1.

## Quick-reference checklist

- [ ] No hardcoded secrets/credentials/tokens in source, config, or commit history
- [ ] No PII or secrets appear in logs, error messages, stack traces, or external tool/API calls
- [ ] All state-changing endpoints re-validate authorization server-side, per request, against the caller's actual identity
- [ ] Object references (IDs, keys) can't be tampered with or guessed into another user's data (IDOR check)
- [ ] All queries/commands use parameterized APIs; no string-concatenated SQL/shell/HTML output
- [ ] User input is allowlist-validated and contextually escaped where a safe API isn't available
- [ ] Deserialization of untrusted data is avoided or strictly type/schema-restricted
- [ ] Auth/crypto/parsing failures fail closed (deny) and emit a loggable, alertable event
- [ ] No default credentials, verbose debug output, or permissive CORS/headers in production config
- [ ] Dependencies are pinned/locked with verifiable checksums; no unreviewed transitive additions
- [ ] CI/CD produces (or plans to produce) build provenance tying artifacts back to source + build steps
- [ ] Sensitive data is encrypted in transit and at rest; nothing sensitive travels over plaintext channels
- [ ] Rate limiting / resource limits exist on endpoints that accept untrusted, unbounded input
- [ ] Passwords hashed with a slow salted algorithm (bcrypt/scrypt/Argon2); tokens are random and scoped, not predictable or reused
- [ ] A dependency inventory/SBOM exists (or is trivially generatable) for the codebase under review

## Sources

- [OWASP Top 10:2021](https://owasp.org/Top10/2021/) — the established Top 10 risk categories; still the baseline most tooling maps to.
- [OWASP Top 10:2025](https://owasp.org/Top10/2025/en/) and [2025 Introduction (what changed)](https://owasp.org/Top10/2025/0x00_2025-Introduction/) — current release: Broken Access Control still #1; Security Misconfiguration rose to #2; new categories Software Supply Chain Failures (A03) and Mishandling of Exceptional Conditions (A10); SSRF folded into Broken Access Control.
- [MITRE CWE Top 25 (2025)](https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html) — ranked list of the most dangerous software weaknesses by real-world CVE frequency/severity; XSS (CWE-79) and SQL Injection (CWE-89) rank #1–#2.
- [OWASP Application Security Verification Standard (ASVS)](https://owasp.org/www-project-application-security-verification-standard/), [ASVS 5.0 overview](https://codific.com/owasp-asvs-a-comprehensive-overview/) — cumulative 3-level verification standard (baseline / standard / advanced) for scaling review rigor to risk.
- [OWASP Cheat Sheet Series — Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html) — secret lifecycle, detection, and incident-response (revoke → rotate → delete) guidance directly generalizable to PII leaks.
- [OWASP Cheat Sheet Series — Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Injection_Prevention_Cheat_Sheet.html) — the 3-rule hierarchy: validate input, prefer safe/parameterized APIs, escape contextually only as a fallback.
- [OWASP Cheat Sheet Series — Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) — deny-by-default, least privilege, per-request validation, fail-safe on error.
- [SLSA Framework, v1.2 Tracks](https://slsa.dev/spec/v1.2/tracks) and [What's new in v1.2](https://slsa.dev/spec/v1.2/whats-new) — Build Track (L0–L3, provenance → hardened builds) plus a new Source Track (added in v1.2) for source-tampering threats.

**Notable conflicts/version notes:** OWASP Top 10 has two live versions — 2021 (widely embedded in tooling/compliance mappings) and 2025 (current official release, reshuffled rankings and renamed/merged categories). Use 2025 as primary; keep 2021 names as aliases since most external scanners still cite them. SLSA v1.0 marked the Source track "future work" — v1.2 (current) has since shipped it, so any v1.0-era doc describing SLSA as build-only is stale.
