# due-diligence: work that holds up under a hostile reviewer

Work that looks fine can still be wrong. This plugin sends a critic after it before anyone else sees it, and hands you the same checklists before you start, so there is less to find.

## What it is

Two skills that share one library of review checklists, called lenses.

- **`due-diligence`** reviews finished work. A critic attacks it, a corrector fixes or disproves each finding, and the loop repeats until the critic finds no real defect.
- **`cdd`** (construction due diligence) runs the same lenses before you build and turns them into a build brief. It does not replace the review. It shrinks what the review finds.

A lens is a short checklist for one way work goes wrong, such as an invented figure, silently dropped data or unexplained jargon. There are 44.

| Kind | In plain English | Examples |
| --- | --- | --- |
| General (9) | Faults almost any work can have | data-provenance, clarity, necessity, voice |
| Domain (35) | Faults of one kind of work, picked by what the work is | security-secrets for code, deep-accessibility for a UI |
| Yours | Lenses you write for your own repo | a house rule your team always checks |

Every shipped lens, and when it applies, is in [lens-selection.md](skills/due-diligence/references/lens-selection.md).

## How it works

Neither skill runs on its own. You ask for one, or the review runs right before something leaves the machine or when a branch is finished.

The review works out what the work is and picks only the lenses it needs. Any general lens it leaves out is named with a reason, so nothing is skipped silently. Then it picks how hard to look and says which: Light (one pass and one round of fixes, the default), Standard (a separate critic that never saw the reasoning) or Heavy (a critic per lens, attacking until nothing new turns up). Light moves itself up when its own scorecard shows the work was worse than it looked. You can steer it with words like "quick check" or "go deep". The rules are in the [skill](skills/due-diligence/SKILL.md).

`cdd` makes the same choices, then writes the brief instead of attacking. Its two brief sizes are in the [cdd skill](skills/cdd/SKILL.md).

## Install

Add the lm-tools marketplace as the [root README](../README.md) shows, then:

```
/plugin install due-diligence@lm-tools        # Claude Code
codex plugin add due-diligence@lm-tools       # Codex
```

For a frozen copy that never updates, copy both skill folders side by side into `.claude/skills/`, from the root of an lm-tools clone:

```
cp -r due-diligence/skills/due-diligence due-diligence/skills/cdd <your-repo>/.claude/skills/
```

`cdd` has no lenses of its own and reads them from `../due-diligence/references/`, so it only works next to `due-diligence`.

## Commands

```
run due diligence on this          review finished work (Claude Code)
$due-diligence                     the same, in Codex
cdd this / build to DD standard    get a build brief (Claude Code)
$cdd                               the same, in Codex
```

## Extend it

Add a lens, or change a shipped one, by dropping a checklist in `.dd/lenses/` in your repo. A file with a shipped lens's exact filename (`.dd/lenses/security-secrets.md`, not `security.md`) replaces it for that repo. Updates never touch `.dd/`. The template is in [authoring-lenses.md](skills/due-diligence/references/authoring-lenses.md).

## Details

Most lenses cite one of 19 research files (`references/res_*.md`) built on primary standards such as WCAG, OWASP and SemVer. Nothing loads until a lens is chosen, so an unused lens costs no context. A Light review opens lens files only, and the research files open for Standard and Heavy critics.
