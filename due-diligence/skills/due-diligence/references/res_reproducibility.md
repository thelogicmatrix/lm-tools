# res_reproducibility — The Reproducibility & Idempotency Bar
> Research-backed reference for the Due Diligence reproducibility-portability and idempotency-rerun-safety lenses.

## What good looks like (the bar)

### Reproducibility & portability
- **Explicit, isolated dependencies.** A twelve-factor app "never relies on implicit existence of system-wide packages" [12factor-deps]:
  - All dependencies are declared completely and exactly via a manifest (Gemfile, package.json, requirements.txt).
  - They're also *isolated* at execution (`bundle exec`, virtualenv) so nothing leaks in from the host — declaration and isolation are both required, either alone is insufficient.
  - Shelling out to an unvendored system tool (ImageMagick, curl) is the same defect: it may exist on the author's machine and nowhere else.
- **Config in the environment, never in code.** Anything that varies between deploys — DB handles, credentials, per-deploy hostnames — is config and belongs in env vars, not constants or checked-in config files [12factor-config]:
  - Litmus test: *could this codebase go open source right now without leaking a credential?* If not, config isn't factored out.
  - Config files not checked into version control are an improvement over hardcoded constants but still risk accidental commits and scatter config across formats — env vars are the language/OS-agnostic fix.
- **Dev/prod parity.** Divergence shows up as three gaps [12factor-parity]:
  - *Time* — code sits unshipped for weeks or months before reaching production.
  - *Personnel* — the people who write the code aren't the people who deploy it.
  - *Tools* — SQLite+Nginx locally, Postgres+Apache in production. This is the gap reproducibility reviews should hunt hardest: using a "lighter" backing service locally than in prod is an explicitly named false economy — adapters can't fully hide incompatibilities, and the failures they miss surface as "worked in dev, broke in prod."
- **Reproducible build, formally defined:** "given the same source code, build environment and build instructions, any party can recreate bit-by-bit identical copies of all specified artifacts," verified by cryptographic hash comparison, not eyeballing [reproducible-builds-def]. The project's own docs name the dominant real-world causes of failure to meet this bar:
  - Embedded build timestamps (cited as the single biggest source of unreproducibility) [reproducible-builds-timestamps].
  - The build path leaking into debug symbols or binary output [reproducible-builds-buildpath].
  - Unstable ordering of inputs/outputs (filesystem globs, hash-map iteration), locale/timezone-dependent formatting, and unpinned tool or dependency versions.
- **Hermetic builds** go one step further than "reproducible on the same machine": a hermetic build is *insensitive to the host* entirely, via two properties [bazel-hermeticity]:
  - *Isolation* — compilers and tools are treated as versioned inputs the build fetches and pins itself, not whatever happens to be installed locally.
  - *Source identity* — source is identified by content hash rather than by trusting a checkout. This combination is what makes a build portable across machines, not merely repeatable on one.
- **Lockfiles pin the exact dependency tree**, not just version ranges. A `package-lock.json` (or equivalent) is checked into the repo so that "subsequent installs are able to generate identical trees, regardless of intermediate dependency updates" [npm-lockfile] — the range in the manifest (`^2.1.0`) says what's *acceptable*, the lockfile says what was *actually built and tested*.

### Idempotency & rerun-safety
- **RFC 9110's formal definition**: a method is idempotent "if the intended effect on the server of multiple identical requests with that method is the same as the effect for a single such request" [rfc9110-idempotent].
  - PUT, DELETE, and all safe (read-only) methods qualify by spec; POST does not.
  - The property isn't philosophical: a client (or proxy) may safely auto-retry an idempotent request after a dropped connection, because repeating it can't cause extra damage — whereas blind-retrying a non-idempotent POST can double-charge or double-create.
- **The idempotency-key pattern covers POST.** Stripe's implementation is the reference pattern [stripe-idempotency]:
  - Client generates a unique key (V4 UUID recommended) and sends it with the request.
  - Server saves the *first* response — success or failure — under that key.
  - Every retry with the same key and the same parameters replays the stored response rather than re-executing, including replaying a stored 500.
  - Reusing a key with *different* parameters is rejected as misuse; keys expire (≥24h) rather than being retained forever.
- **Infrastructure/config-management idempotency is the same property applied to system state**: "an operation is idempotent if the result of performing it once is exactly the same as the result of performing it repeatedly without any intervening actions" [ansible-glossary].
  - In practice this is why Ansible/Terraform-style tools are declarative: they describe desired end-state and diff against current state (a Terraform plan, an Ansible task's changed/ok check), converging toward the target rather than blindly re-executing an imperative script that would create duplicates on rerun.

## Common defects (what to attack)
- Hardcoded absolute paths (`/Users/dev/project`, `C:\Users\...`) instead of relative paths or env-derived config.
- Dependencies used but never declared in a manifest — "works because it happened to be on my machine."
- No lockfile, or a lockfile not committed — reruns can silently pick up a newer transitive dependency.
- Reliance on an un-vendored system tool/binary assumed to exist on every host.
- Config values (credentials, hostnames, feature flags) hardcoded or baked into source instead of env vars.
- Missing or stale setup docs — no documented path from clean checkout to running app.
- Dev environment uses a materially different backing service than prod (SQLite vs. Postgres, in-memory cache vs. Redis).
- Build output embeds a timestamp, build path, hostname, or locale-dependent formatting, breaking bit-for-bit reproducibility.
- A POST/create endpoint with no idempotency key, dedupe check, or unique constraint — retried on timeout, it double-creates.
- A "setup" or "provisioning" script that isn't safe to run twice (appends instead of upserts, errors on already-exists instead of no-op'ing).
- Retry logic layered on top of a non-idempotent operation (the retry itself becomes the bug).
- GET/DELETE (or other "safe"/idempotent-by-spec) endpoints that have side effects on repeat calls — violates the RFC 9110 contract clients and proxies rely on for auto-retry.
- Idempotency key generated from mutable or non-unique input (timestamp, sequential counter) instead of a random UUID — collision risk defeats the guarantee.

## Quick-reference checklist
- [ ] All dependencies declared in a manifest (none assumed present on the host)
- [ ] A lockfile exists, is committed, and pins exact resolved versions
- [ ] No unvendored system-tool shell-outs (curl, imagemagick, etc.)
- [ ] Config (secrets, hostnames, flags) lives in env vars, not in source or checked-in config files
- [ ] Codebase could go open-source right now without leaking a credential
- [ ] Dev/staging/prod use the same type+version of each backing service (DB, cache, queue)
- [ ] No hardcoded absolute/user-specific paths
- [ ] Setup docs take a clean checkout to a running app with only documented prerequisites
- [ ] Build output is free of embedded timestamps, build paths, or locale-dependent content
- [ ] Every state-mutating retry-able operation (POST/create, provisioning script, migration) is idempotent or key-guarded
- [ ] Rerunning the full setup/deploy/provisioning process twice produces the same end state, not duplicates
- [ ] GET/DELETE and other spec-safe/idempotent endpoints have no observable side effects on repeat calls
- [ ] Idempotency keys are random/unique (UUID), not derived from timestamps or sequential counters

## Sources
- [12factor.net — II. Dependencies](https://12factor.net/dependencies) — explicit declaration + isolation, no implicit system tools
- [12factor.net — III. Config](https://12factor.net/config) — config-in-environment rule and the open-source litmus test
- [12factor.net — X. Dev/prod parity](https://12factor.net/dev-prod-parity) — the three gaps (time, personnel, tools) and the backing-service-parity argument
- [reproducible-builds.org — Definitions](https://reproducible-builds.org/docs/definition/) — the canonical bit-for-bit reproducibility definition and verification method
- [reproducible-builds.org — Timestamps](https://reproducible-builds.org/docs/timestamps/) — timestamps as the single biggest source of unreproducibility; `SOURCE_DATE_EPOCH` fix
- [reproducible-builds.org — Build path](https://reproducible-builds.org/docs/build-path/) — build-path leakage into debug info/output and prefix-map mitigations
- [Bazel — Hermeticity](https://bazel.build/basics/hermeticity) — isolation + source-identity definition of hermetic builds
- [npm Docs — package-lock.json](https://docs.npmjs.com/cli/v10/configuring-npm/package-lock-json) — why a committed lockfile is required for identical dependency trees across installs
- [RFC 9110 §9.2.2 — Idempotent Methods](https://www.rfc-editor.org/rfc/rfc9110.html) — formal HTTP idempotency definition and the auto-retry rationale
- [Stripe API — Idempotent requests](https://docs.stripe.com/api/idempotent_requests) — reference implementation of the idempotency-key pattern for POST
- [Ansible Glossary — Idempotency](https://docs.ansible.com/ansible/latest/reference_appendices/glossary.html) — the config-management definition applied to infrastructure state
