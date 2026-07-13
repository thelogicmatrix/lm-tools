# res_accessibility — The Accessibility Bar (WCAG 2.2 AA)
> Research-backed reference for the Due Diligence deep-accessibility lens and the contrast portion of visual-ui-ux.

The industry conformance target is **WCAG 2.2, Level AA** (W3C Recommendation, Oct 2023) — this is what
legal frameworks (ADA, EN 301 549, EAA) and most corporate policies cite. Level A is the floor (fails
mean some users literally cannot use the content); AA is the bar; AAA is aspirational/rarely mandated.
Organized by **POUR**: Perceivable, Operable, Understandable, Robust.

## What good looks like (the bar)

**Perceivable**
- Text contrast ≥ **4.5:1** (normal text); ≥ **3:1** for **large text** (18pt/24px+ regular, or 14pt/18.66px+
  bold) and for images of large-scale text. — SC 1.4.3 Contrast (Minimum), AA. [webaim.org/articles/contrast]
- Non-text contrast ≥ **3:1** against adjacent color(s) for UI component boundaries/states (borders, icons,
  focus indicators) and graphical objects required to understand content. — SC 1.4.11, AA.
- AAA "Enhanced" contrast (rarely required, cite only if client asked for AAA): 7:1 normal text / 4.5:1 large
  text — SC 1.4.6.
- Every non-decorative image has a text alternative (`alt`); decorative images have empty `alt=""` or are
  CSS backgrounds. — SC 1.1.1, A.
- Content and structure conveyed via semantic HTML/ARIA, not just visual layout (headings are real `<h1-6>`,
  lists are `<ul>/<ol>`, tables have `<th>`/scope). — SC 1.3.1, A.
- Color is never the *only* way information is conveyed (e.g., red/green error state needs an icon/text too).
  — SC 1.4.1, A.
- Text resizes to 200% without loss of content/function, no horizontal scroll for reflow at 320px width. —
  SC 1.4.4 (A) / 1.4.10 Reflow (AA).

**Operable**
- **All functionality operable via keyboard alone**, no timing-dependent keystrokes. — SC 2.1.1 Keyboard, A.
  [w3.org/WAI/WCAG21/Understanding/keyboard.html]
- **No keyboard trap** — focus can always be moved away using only the keyboard (standard tab/shift-tab, or
  documented if it needs more than arrow keys). — SC 2.1.2, A.
- Visible focus indicator on every focusable element, not time-limited. — SC 2.4.7 Focus Visible, AA.
- Focus indicator, when visible, is **at least as large as a 2 CSS-pixel-thick perimeter** around the
  unfocused component (or a 4px line along the shortest side), and meets 3:1 contrast against adjacent
  colors — SC 2.4.13 Focus Appearance, **AAA** (new in 2.2; not an AA requirement but attack sites that fail
  it hard since it's cheap to fix).
- The focused item is not entirely hidden by author-created sticky headers/footers/modals. — SC 2.4.11 Focus
  Not Obscured (Minimum), **AA, new in 2.2**.
- Logical, predictable focus order matching visual/reading order. — SC 2.4.3, A.
- Touch/pointer **target size ≥ 24×24 CSS pixels**, unless: the target is inline in text, an equivalent
  larger control exists elsewhere on the page, the target's size is user-agent-controlled, or the size is
  legally/essentially required. Spacing exception: undersized targets are acceptable if a 24px-diameter
  circle centered on the target doesn't overlap the same circle on an adjacent target. — SC 2.5.8 Target
  Size (Minimum), **AA, new in 2.2**. [w3.org/WAI/WCAG22/Understanding/target-size-minimum.html] (AAA variant
  2.5.5 in WCAG 2.1 asks for 44×44px — cite as the "gold standard," not the AA bar.)
- Dragging interactions (drag-to-reorder, sliders) have a single-pointer alternative that doesn't require
  dragging. — SC 2.5.7 Dragging Movements, **AA, new in 2.2**.
- No content flashes more than 3 times/second. — SC 2.3.1, A.
- Multiple ways to locate a page (nav, search, sitemap) on multi-page sites. — SC 2.4.5, AA.

**Understandable**
- Form inputs have programmatically-associated labels (`<label for>`, `aria-label`, or `aria-labelledby`);
  placeholder text alone is not a label. — SC 1.3.1 / 4.1.2, A.
- Errors identified in text (not color/icon alone), with a description of how to fix, and suggestions where
  known. — SC 3.3.1 Error Identification (A), 3.3.3 Error Suggestion (AA).
- Consistent navigation and identification of repeated components across pages. — SC 3.2.3 / 3.2.4, AA.
- Authentication must not require a **cognitive function test** (remembering a password, solving a puzzle,
  transcribing an image) unless an exception applies (e.g., a non-text alternative like a password manager /
  biometric / "object recognition" is offered). — SC 3.3.8 Accessible Authentication (Minimum), **AA, new in
  2.2**.
- A mechanism to help users (e.g., contact info, chat) is consistently located across pages. — SC 3.2.6
  Consistent Help, **A, new in 2.2**.
- Previously-entered information isn't required to be re-entered in the same process, unless essential. —
  SC 3.3.7 Redundant Entry, **A, new in 2.2**.

**Robust**
- Valid, well-formed markup; UI components expose name/role/value programmatically so assistive tech (AT)
  reads and controls them correctly. — SC 4.1.2 Name, Role, Value, A.
- Status messages (e.g., "item added to cart", form-submit confirmations) are announced to AT without
  requiring focus, via `role="status"`/`role="alert"`/`aria-live`. — SC 4.4.1 Status Messages, AA.
- **ARIA rule #1 ("No ARIA is better than Bad ARIA")**: prefer native semantic HTML (`<button>`, `<nav>`,
  `<dialog>`) over `role=` attributes bolted onto `<div>`s; ARIA changes what AT perceives, it never adds
  keyboard behavior or focus management — that's still the author's job. — ARIA APG.
  [w3.org/WAI/ARIA/apg/]

## Common defects (what to attack)

- Gray-on-white or light-brand-color text under 4.5:1 (or 3:1 for headings) — the #1 recurring finding.
  `#777777` on white is 4.47:1 and **fails** — do not round up.
- Placeholder-as-label forms; icon-only buttons with no accessible name (`aria-label`).
- `<div onclick>` / `<span onclick>` fake buttons — unreachable and inoperable by keyboard, no role exposed.
- Custom dropdowns/modals/carousels built without ARIA APG patterns: no `Escape` to close, no focus trap
  inside modal, no focus return to trigger on close, arrow keys not wired for listbox/menu/tab patterns.
- Focus indicator suppressed via `outline: none` / `:focus { outline: 0 }` with no visible replacement.
- Icon-only nav/social links and tiny checkboxes/close-buttons under 24×24px with no spacing offset.
- Images missing `alt`, or `alt="image123.jpg"` / decorative icons with a redundant (non-empty) `alt`
  duplicating adjacent visible text.
- Heading levels skipped or used purely for font size (e.g., `<h1>` styling on a `<div>`, `<h4>` used for
  visual size instead of hierarchy) — breaks screen-reader landmark/heading navigation.
- Color-only status (red text = error, green = success) with no icon/text/pattern backup.
- CAPTCHAs or authentication flows demanding transcription/memory with no accessible alternative.
- Auto-advancing carousels/toasts with no pause control, or content that flashes rapidly.

## Quick-reference checklist

- [ ] Body text ≥ 4.5:1 contrast; large text (18pt/24px+ or 14pt/18.66px+ bold) ≥ 3:1
- [ ] Non-text UI elements (borders, icons, focus rings) ≥ 3:1 against adjacent color
- [ ] Full keyboard-only pass: every interactive element reachable, operable, no trap
- [ ] Visible focus indicator on every focusable element (not just default browser outline removed)
- [ ] Logical tab order matches visual/reading order
- [ ] Touch targets ≥ 24×24px (or spacing/equivalent exception applies)
- [ ] All images have appropriate `alt` (empty for decorative, descriptive for informative)
- [ ] Semantic landmarks present (`<header>`, `<nav>`, `<main>`, `<footer>`) and heading hierarchy is unbroken
- [ ] Form fields have real programmatic labels; errors described in text with fix guidance
- [ ] Interactive controls are native elements or follow an ARIA APG pattern (role + keyboard + focus mgmt)
- [ ] No color-only encoding of meaning/status
- [ ] Status/live updates announced via `aria-live`/`role="status"` without stealing focus
- [ ] No authentication step requires memory/puzzle-solving without an accessible alternative
- [ ] Zoom to 200% / reflow to 320px width: no content or functionality lost
- [ ] No content flashes >3×/second

## Sources

- [W3C WCAG 2.2 (TR)](https://www.w3.org/TR/WCAG22/) — normative success-criteria spec, A/AA/AAA levels
- [W3C "What's New in WCAG 2.2"](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/) — the 9 new SCs vs. 2.1 (2.4.11, 2.4.12, 2.4.13, 2.5.7, 2.5.8, 3.2.6, 3.3.7, 3.3.8, 3.3.9); 4.1.1 Parsing removed
- [WCAG 2.2 Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/) — filterable checklist by level/technology
- [WebAIM — Understanding WCAG 2 Contrast and Color Requirements](https://webaim.org/articles/contrast/) — canonical plain-English breakdown of 1.4.3/1.4.6/1.4.11/1.4.1 with exact ratios and worked examples
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/) — the standard tool for verifying ratios
- [W3C Understanding SC 2.5.8 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) — 24×24px rule + 4 exceptions (spacing, equivalent, inline, essential, user-agent-controlled)
- [W3C Understanding SC 2.4.13 Focus Appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html) — AAA focus-indicator size/contrast formula
- [W3C Understanding SC 2.1.1 Keyboard](https://www.w3.org/WAI/WCAG21/Understanding/keyboard.html) — keyboard-operability requirement, no timing dependency
- [W3C ARIA Authoring Practices Guide (APG)](https://www.w3.org/WAI/ARIA/apg/) — widget patterns with correct roles, states, and keyboard interaction; source of "No ARIA is better than Bad ARIA"

**Notable conflicts reconciled:** WCAG 2.1's SC 2.5.5 Target Size asks for 44×44px but is **AAA** (rarely
enforced); WCAG 2.2's new SC 2.5.8 sets the enforceable **AA** bar at 24×24px with exceptions — use 24px as
the pass/fail line, cite 44px only as a "best practice, not required" upgrade. Similarly, 2.4.13 Focus
Appearance is AAA-only (new in 2.2) — a missing/weak focus ring is not an AA *failure* by itself unless it
also fails 2.4.7 (visible at all) or 1.4.11 (3:1 contrast); flag Focus Appearance gaps as "AAA best practice"
not "AA violation" to keep severity claims proportionate.
