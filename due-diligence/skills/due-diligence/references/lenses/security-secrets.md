# security-secrets — Is the code safe, and does it leak?
> Cites: res_security.md

## Fires on
Tags: code, config, data-export. Any artifact containing source, configuration, or a data dump.

## Attacks
- Injection: untrusted input concatenated into a SQL query, shell command, file path, template, or eval (CWE-89/78/22).
- Broken authorization: missing/incorrect access check, IDOR, privilege escalation, SSRF (OWASP 2025 A01).
- Secrets & PII leakage: hardcoded credential/token/key; customer PII written to git, logs, cloud, or output. ENFORCES the org rule — no customer PII off-machine.
- Unsafe defaults: security misconfiguration, verbose error leakage, permissive CORS, debug enabled in prod (OWASP 2025 A02).
- Supply-chain: unpinned / known-vulnerable / typosquatted dependency (OWASP 2025 Software Supply Chain Failures).

## Measure
Secrets found in the tree or output (keys, tokens, passwords, connection strings), by file.
Tolerance is 0. Any live secret = blocker. A placeholder that looks live, or a secret in history
already rotated = should-fix.

## Evidence of attack (clean-pass proof)
Per category, name what was traced and why it's safe: the query is parameterized, the authz check is present at line X, the diff/output contains no secret or PII. "No injection found" without naming the traced sinks is not evidence.

## Severity guide
- blocker: exploitable injection, a leaked secret/PII, or a missing authz check on a sensitive action.
- should-fix: unsafe default, or an unpinned dependency on a known-vulnerable path.
- nit: defense-in-depth hardening not currently exploitable.
