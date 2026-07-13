# structure-navigability — Can a reader find and follow the throughline?
> Cites: res_technical-writing.md

## Fires on
General lens (no tag) — select for any artifact long or structured enough that a reader must navigate it (multi-section doc, report, spec, README, slide deck). Skip for a single short paragraph. Distinct from clarity (local: is *this* sentence clear) — this is global: is the *whole thing* organised and findable.

## Attacks
- Buried bottom-line: the conclusion/ask/risk appears in section 3+ or after backstory instead of first (violates BLUF / inverted pyramid).
- No skimmable structure: wall-of-text, missing or non-descriptive headings, paragraphs too long to scan; a reader who stops partway leaves without the main point.
- Illogical order: sections don't build on each other; a concept is used before the section that explains it; related material scattered instead of grouped.
- No entry point for the reader's task: no summary/TOC/overview for a long doc, so finding the one part they need means reading all of it.
- Front-loaded key words missing: sentences and headings don't lead with the word that tells a skimmer what the block is about.

## Evidence of attack (clean-pass proof)
State where the bottom-line sits (sentence/section). Walk the section order and confirm it builds logically, or name the out-of-order/scattered spot. Confirm headings are descriptive and a skimmer reading only headings + first sentences gets the gist — or show where that breaks. Not "well organised" without tracing it.

## Severity guide
- blocker: the main point/ask is unfindable without reading the whole thing, or the order makes it incomprehensible on a normal read.
- should-fix: buried bottom-line, missing headings/summary on a long doc, a scattered or out-of-order section.
- nit: headings could be more descriptive; a paragraph could be split.
