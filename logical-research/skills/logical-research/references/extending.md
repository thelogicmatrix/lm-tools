# Extending logical-research

logical-research follows the logical-tools two-tier contract: a core you don't touch, and a tier you own.

| Tier | Where | Updates? |
|---|---|---|
| **Core** | the plugin's `SKILL.md` and `references/` | with the tool |
| **Yours** | `.lr/angles/*.md` in your repo | never touched by a plugin update |

## Reading angles

The variable part of the pipeline is the angle: what the research is for. It becomes a named section in every item note.

A recurring angle can live in a file, `.lr/angles/<name>.md`. Write three things in it:

- what to look for
- what counts as relevant
- how to phrase the section

In phase 4, the skill reads the angle files that match the requested angle and lets them shape the angle section, so you don't re-explain the angle each run.

Nothing else is required. An angle passed in conversation, or in a corpus brief's `angle` field, works fine without a file.
