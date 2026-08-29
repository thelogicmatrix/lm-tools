# Adding or changing a lens

**Your own lenses (update-safe, the normal path):** drop them in `.dd/` in your repo, never
inside the plugin. `.dd/lenses/<name>.md` is picked up by the per-case scan; `.dd/res/<domain>.md`
backs it. Name it after a shipped lens to **override** that lens; use a new name to add one. A
lens declares when it applies in its own `## Fires on`, so no table edit is needed. Plugin
updates never touch `.dd/`.

**Template:** `# <name> — <what it reviews>` / `> Cites: res_<domain>.md` (or "internal" when
no external standard exists) / `## Fires on` / `## Attacks` / `## Measure` (optional) /
`## Evidence of attack` / `## Severity guide`. Draw the Attacks from the cited `res_` file; never
invent them.

**Measure** is the number the lens can count on the artifact, how to count it, and the threshold
that makes it should-fix or blocker. Give it only where a real number exists (untraced claims out
of total claims, viewports passing out of four, secrets found). A lens with nothing countable omits
the section and its scorecard row reads "judgement". The Critic reports the measure in the
scorecard, and the escalation rule in SKILL.md reads the scorecard.

**Contributing upstream (into the plugin):**

1. Write `references/lenses/<name>.md` per the template.
2. If it needs a new knowledge base, add `references/res_<domain>.md` first, research-backed,
   and cite it.
3. Add one row, or extend a tag row, in [lens-selection.md](lens-selection.md).

Either way, no dispatcher code to touch.
