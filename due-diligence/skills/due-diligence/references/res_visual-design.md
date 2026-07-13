# res_visual-design — What Good UI/UX Looks Like
> Research-backed reference for the Due Diligence visual-ui-ux and brand-consistency lenses. The bar a hostile reviewer checks a rendered UI against.

## What good looks like (the bar)

**Hierarchy**
- Not everything can be emphasized — de-emphasize the majority rather than bolding/coloring everything ("if everything is important, nothing is"). [Refactoring UI]
- Build hierarchy from ≥2 of {size, weight, color} together, not size alone — a bigger label with the same weight/color as body text often still reads as noise. [Refactoring UI]
- One primary action per screen/section, visually dominant; secondary actions demoted (ghost/text buttons).

**Spacing**
- Use a fixed spacing scale, not arbitrary px values — e.g. 4/8/12/16/24/32/48/64. [Refactoring UI; matches 8pt grid below]
- 8pt/8dp grid: every margin, padding, and component dimension is a multiple of 8dp (4dp allowed for small/dense adjustments). Origin: Material Design's layout spec. [Material Design — m3.material.io/styles/spacing]
- Related items closer together, unrelated items farther apart — spacing itself communicates grouping (see Gestalt Proximity below); don't rely on borders/dividers to do spacing's job. [Refactoring UI]

**Typography**
- Optimal line length (measure): ~45–75 characters per line; ~66 is the oft-cited sweet spot for single-column body text. [Bringhurst, "Elements of Typographic Style"; corroborated by CSS-Tricks, UX StackExchange]
  - Baymard's usability-testing-based recommendation trends shorter: 50–60 cpl for real-world on-screen reading. Where the two diverge, treat 75 cpl as a hard ceiling, not a target. [Baymard Institute]
  - WCAG 1.4.8 (AAA) hard-caps width at 80 characters and requires line spacing ≥1.5× font size within paragraphs, paragraph spacing ≥1.5× line spacing — the only anchor with a normative number here. [W3C WCAG 2.2, SC 1.4.8]
- Line height (leading) for body text: 1.4–1.6× font size is the cross-source consensus; use 1.5 as default. [WCAG 1.4.8; common industry convention]
- Type scale: pick one modular ratio and stick to it — Minor Third 1.2 / Major Third 1.25 / Perfect Fourth 1.333 are the common web choices (golden ratio 1.618 for high-drama editorial only). Inconsistent, ad-hoc font sizes across a UI is a defect, not a style. [type-scale convention, referenced in Refactoring UI and multiple type-scale tools]
- Limit typefaces to 1–2 families; vary weight/size instead of adding a third face.

**Color & contrast**
- Body text vs background: contrast ratio ≥4.5:1 (AA); large text ≥18pt/14pt-bold: ≥3:1. [WCAG 2.2 SC 1.4.3]
- Non-text UI components (icons, input borders, focus indicators) vs adjacent color: ≥3:1. [WCAG 2.2 SC 1.4.11]
- Never rely on color alone to convey state/meaning (error/success) — pair with icon, text, or shape. [WCAG 1.4.1; NNGroup heuristic #9]
- One dominant neutral palette (grays) + one primary brand hue + sparing accent colors for state (success/warn/error) — this is the "harmonious palette" Refactoring UI's most-cited principle.

**Touch targets & layout**
- Minimum tappable target: 44×44 pt (Apple HIG — "a button needs a hit region of at least 44×44pt... 60×60pt in visionOS"). [Apple Human Interface Guidelines — Buttons, Layout]
- Material Design's equivalent: 48×48dp. [Material Design]
- WCAG 2.2 SC 2.5.8 (AA, new in 2.2): 24×24 CSS px minimum, with spacing/exception carve-outs; the older SC 2.5.5 (AAA) still asks for 44×44 CSS px. **Sources diverge by authority and level** — 24px is the accessibility law-of-the-land minimum (AA), 44px is the de facto product-design standard (Apple/Material both exceed the AA floor) and the AAA bar. Flag anything under 24px as a hard fail; flag 24–43px as below best-practice unless justified by density constraints. [W3C WCAG 2.2]

**Responsive breakpoints** (no single standard; converges around these bands)
- Common device-class bands: ~320–480px mobile, 768px tablet, 1024px small laptop, 1280–1440px desktop, 1920px+ large desktop.
- Framework defaults, for calibration: Tailwind CSS `sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1536`; Bootstrap 5 `sm 576 / md 768 / lg 992 / xl 1200 / xxl 1400`.
- Material Design 3 window size classes (dp, not px): Compact <600, Medium 600–839, Expanded 840–1199, Large 1200–1599, Extra-large ≥1600. [Material Design 3 — Window size classes]
- The bar: layout must not break (overlap, clipped text, horizontal scroll on body) at any width in the 320–1920px range, with explicit handling at the 768/1024 tablet transitions where nav patterns typically change.

**Gestalt principles (how users parse a layout before reading it)**
- Proximity — items placed close together are read as one group; overrides color/shape similarity when they conflict. [Gestalt psychology, via Interaction Design Foundation]
- Similarity — same shape/color/size = same category; inconsistent styling of equivalent elements breaks this.
- Common region — a shared background/border groups items more strongly than proximity alone (cards, panels).
- Figure-ground — foreground content must read as clearly separated from background (sufficient contrast, no ambiguous overlap).
- Closure & continuity — users complete implied shapes/lines; broken alignment (elements off-grid) fights this and reads as "sloppy" even if each element is fine alone.

**Information density & structure (the AI-UI failure zone)**
AI-generated UIs systematically over-produce: they repeat, they dump everything on one surface, and they pour a multi-step task onto one endless page. Three principles bound this:
- **Minimalism / no redundancy** — an interface should not contain information or controls that are irrelevant or rarely needed; every extra unit competes with the units that matter. Repeated labels, restated headings, the same datum shown two or three ways, boilerplate captions on self-evident elements, and duplicated nav/actions are noise to cut. [NNGroup heuristic #8 "Aesthetic and minimalist design"; Refactoring UI — de-emphasise/remove over add]
- **Progressive disclosure** — show the few options/fields most users need most of the time; move advanced, rare, or detail content behind a secondary layer (expander, "details", drill-in, tab, second screen) that stays *accessible* but not *present*. Reduces visible complexity and error rate without removing capability. Not the same as hiding needed content — the default view must still let the primary task complete. [NNGroup "Progressive Disclosure" (Nielsen); heuristic #8]
- **Chunking & step decomposition** — people parse and hold information in small groups, not long undifferentiated runs (working memory ~4–7 items). Break long content into labelled sections/cards; break a long or multi-part task into discrete steps, and when a single page carries several distinct tasks or a long form, split it into multiple pages / a wizard so each screen is one consumable unit. A 3000px single-page scroll doing five jobs is usually less usable than four focused pages. [Miller 1956 "The Magical Number Seven"; NNGroup "Chunking"; Baymard — break long forms into steps]

## Common defects (what to attack)
- Text/background contrast below 4.5:1 (or 3:1 large text / UI components) — measure it, don't eyeball it.
- Touch/click targets under 24px, or under 44px with no density justification.
- More than 2 typefaces, or font sizes that don't map to a defined scale (random 13px/15px/17px scattered around).
- Borders/dividers used to create grouping that spacing/proximity should be doing instead.
- Equal visual weight on every element — no clear single primary action.
- Color as the sole signal for state (red text with no icon/label for errors).
- Line length over ~75 characters in body copy, or (WCAG AAA context) over 80.
- Inconsistent spacing values that aren't multiples of a base unit (e.g., 8dp/8pt) — spacing that "looks like" 6px, 10px, 13px scattered without a system.
- Misaligned elements breaking an implied grid (Gestalt continuity violation) — check edges, not just centers.
- Layout breaking (overlap, clipped text, forced horizontal scroll) at common breakpoints (320/768/1024/1440).
- Brand-inconsistency: off-palette colors, wrong logo lockup/clearspace, typography that diverges from the documented brand type scale.
- Violations of Nielsen's heuristics with visual symptoms: no loading/state feedback (#1), jargon-labeled controls (#2), no undo/escape affordance (#3), inconsistent component styling across screens (#4), no confirmation before destructive actions (#5), decorative/dense clutter competing with content (#8).
- Redundancy: the same information or control repeated, headings/labels that restate the obvious, boilerplate captions on self-evident elements, duplicated nav/actions — cut to the single instance that carries the meaning.
- Everything-on-screen: advanced/rare/detail content shown at full weight in the default view instead of behind progressive disclosure (expander/tab/drill-in) — the primary task is buried in options most users don't need right now.
- Unchunked / single-page overload: a long page doing several distinct jobs, or a long form/multi-step task poured onto one endless scroll, where labelled sections or a split into multiple pages/steps (wizard) would make it materially more consumable.

## Quick-reference checklist
- [ ] Body text contrast ≥4.5:1; large text/UI components ≥3:1 (WCAG 2.2)
- [ ] All tap/click targets ≥44×44px (flag <24px as hard fail, 24–43px as a note)
- [ ] Spacing values are multiples of a single base unit (8, or 4 for tight spots)
- [ ] Typography uses ≤2 typefaces and a defined type scale (no ad-hoc sizes)
- [ ] Body line length ≤~75 characters (≤80 hard cap); line-height ~1.4–1.6×
- [ ] One clear primary action per view; secondary actions visually demoted
- [ ] Related elements grouped by proximity/common-region, not just a divider line
- [ ] State/meaning never conveyed by color alone
- [ ] Palette is one neutral scale + one brand primary + sparing semantic accents
- [ ] Elements align to a consistent grid (no stray 1–2px misalignments)
- [ ] No layout breakage at 320 / 768 / 1024 / 1440px widths
- [ ] Brand colors/logo/type match the documented brand system, if one exists
- [ ] No redundant/repeated info or controls; nothing restates the obvious
- [ ] Rare/advanced/detail content sits behind progressive disclosure, not all on screen at once
- [ ] Long content chunked into labelled sections; multi-task/long-form pages split into steps or pages, not one endless scroll

## Sources
- [Nielsen Norman Group — 10 Usability Heuristics for User Interface Design](https://www.nngroup.com/articles/ten-usability-heuristics/) — canonical heuristic list; authoritative for interaction-level defects with visual symptoms.
- [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/) and [Understanding SC 1.4.3 Contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) — normative contrast ratios, target size (2.5.8 AA / 2.5.5 AAA), line-length/spacing (1.4.8 AAA). Highest authority for any numeric accessibility threshold.
- [Apple Human Interface Guidelines — Buttons / Layout](https://developer.apple.com/design/human-interface-guidelines/buttons) — 44×44pt minimum hit target; platform-native spacing conventions.
- [Material Design 3 — Spacing](https://m3.material.io/styles/spacing/overview) and [Window size classes](https://m3.material.io/foundations/layout/applying-layout/window-size-classes) — 8dp grid, 48dp touch target, responsive size-class breakpoints.
- [Baymard Institute — Line-Length Readability](https://baymard.com/blog/line-length-readability) — usability-testing-based line-length guidance (50–60 cpl), more conservative than classic typography's 45–75.
- Refactoring UI (Adam Wathan & Steve Schoger) — hierarchy-via-de-emphasis, fixed spacing scale, limited palette, whitespace-over-borders. No free canonical URL; summarized via secondary write-ups (Medium "Top 20 Key Points," howtoes.blog summary) — treat the book itself as the authority, these as paraphrase.
- Gestalt principles — [Interaction Design Foundation](https://ixdf.org/literature/topics/gestalt-principles) — proximity, similarity, common region, figure-ground, closure/continuity as the perceptual basis for grouping and hierarchy.
- Framework breakpoint defaults (Tailwind CSS, Bootstrap 5) — not authoritative standards, cited only as industry-convention calibration points for the 320–1920px responsive range.
- [NNGroup — Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/) — show common options first, defer advanced/rare content to a secondary layer that stays accessible; reduces visible complexity and error rate.
- [NNGroup — Chunking](https://www.nngroup.com/articles/chunking/) and Miller, "The Magical Number Seven, Plus or Minus Two" (1956) — working-memory limits; group content into small labelled units rather than long runs. Break long/multi-step tasks and forms into discrete pages/steps (corroborated by Baymard form-usability research, cited above).
