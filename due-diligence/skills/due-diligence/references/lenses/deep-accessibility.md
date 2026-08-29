# deep-accessibility — Can a keyboard/screen-reader user actually use this?
> Cites: res_accessibility.md

## Fires on
Tags: rendered-ui. Any artifact that is a live page, local server, or static HTML that can be opened in a browser.

## Attacks
- Keyboard-only navigation broken: an interactive element unreachable or inoperable via Tab/Enter/Space, or a focus trap with no keyboard escape (SC 2.1.1/2.1.2).
- Missing/suppressed focus indicator: `outline: none` with no visible replacement, or focus hidden behind a sticky header/modal (SC 2.4.7/2.4.11).
- Missing semantic structure: no landmarks (`header`/`nav`/`main`/`footer`), skipped/misused heading levels, or `<div onclick>`/`<span onclick>` fake buttons with no exposed role (SC 1.3.1/4.1.2).
- Images without alt text, or alt text that's a filename / redundant with adjacent visible text (SC 1.1.1).
- ARIA misuse: `role=` bolted onto a div instead of the native element, or a custom widget missing the ARIA APG keyboard pattern (no Escape, no focus return, arrow keys not wired).
- Illogical focus order that doesn't match visual/reading order (SC 2.4.3).
- Touch/click targets under 24×24 CSS px with no spacing exception (SC 2.5.8, AA).

## Measure
WCAG failures found, by criterion, and the lowest text contrast ratio measured. Report both. Any
Level A failure, or contrast below 3:1 on body text = blocker. Any Level AA failure, or contrast
below 4.5:1 on body text = should-fix.

## Evidence of attack (clean-pass proof)
A keyboard walkthrough (Tab/Shift+Tab/Enter through every interactive element, noting order and trap-freedom) plus a landmark/heading/alt audit naming what was checked — which elements, which roles, which alt values — not "seems accessible."

## Severity guide
- blocker: unusable by keyboard or screen-reader — a trap, an unreachable control, or a fake button with no role/keyboard handling.
- should-fix: a confirmed AA violation (missing focus indicator, broken landmark/heading structure, missing alt, target <24px).
- nit: an AAA-only nicety (e.g. SC 2.4.13 Focus Appearance sizing/contrast) — do not report as an AA failure.
