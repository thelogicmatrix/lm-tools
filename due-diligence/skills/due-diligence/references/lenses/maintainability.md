# maintainability — Will the next person be able to change this safely?
> Cites: res_code-quality.md

## Fires on
Tags: code. Any artifact containing classes, functions, or modules that will be read/changed again.

## Attacks
- Dead code: unreachable branches, unused functions/exports, speculative generality with no near-term second use (Fowler's Dispensables).
- Duplication: the same logic copy-pasted instead of extracted (Fowler's Dispensables — duplicate code).
- Over-abstraction: an interface/factory/base class with exactly one implementation and no second one in sight — the "SOLID applied speculatively" trap the res file calls out as the practitioner critique.
- Unclear naming: names that don't say what the thing does, forcing a reader into the body to find out — the uncontroversial half of Clean Code per the res file.
- High cyclomatic complexity: a function clearly in double-digit branch paths (McCabe >10, and especially >20) with no tests around those branches.
- Config for a constant: an env var, config key, or injected parameter for a value that never actually varies — same speculative-flexibility smell as the one-impl interface.
- God object/function: one unit doing multiple unrelated jobs (SRP violation, Bloater) — flag the God object itself, not "missing interfaces" around it.

## Evidence of attack (clean-pass proof)
Bias toward "delete this": for each candidate, name the specific function/class/file, state whether a second real use case exists (if not, it's speculative — cut it), and for complexity, give the approximate branch count and whether tests cover those branches. "Looks clean" is not evidence; "no dead exports, no single-impl interfaces, extracted duplication in X" is.

## Severity guide
- blocker: actively misleading — name lies about behavior, duplicated logic that will silently drift out of sync, or complexity so high a change can't be reasoned about.
- should-fix: will slow the next change — real duplication, an unjustified abstraction layer, or a function past the complexity threshold with no tests.
- nit: style — naming polish, minor duplication under a few lines, cosmetic structure.
