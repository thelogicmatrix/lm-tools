# brand-consistency — Does the rendered page match the documented brand system?
> Cites: res_visual-design.md

## Fires on
Tags: rendered-ui. Any artifact that is a live page, local server, or static HTML that can be opened in a browser, where a documented brand/design-token system exists to compare against.

## Attacks
- Color drift: rendered colors off the documented brand palette (wrong hex/hue, no dominant neutral + primary + sparing-accent structure) — where a brand system exists, drift from its documented tokens.
- Typography drift: fonts outside the documented type families, or font sizes not mapping to the documented type scale (ad-hoc sizes instead of the fixed ratio).
- Radius/spacing drift: corner radii or spacing values that don't match the documented tokens (not multiples of the base spacing unit).
- Inconsistent component styling: the same component (button, card, input) rendered differently across screens/states.
- Off-brand imagery: photography/iconography style that doesn't match the documented brand visual language.

## Evidence of attack (clean-pass proof)
A side-by-side comparison naming the rendered value (color hex, font-family, radius px) against the documented token it should match — not "looks on-brand." If no documented token set exists for this artifact, say so as a gap rather than inventing a comparison.

## Severity guide
- blocker: wrong brand identity (wrong logo/colors/fonts) on an external-facing, customer-visible page.
- should-fix: inconsistent token use within the page (one component off-palette or off-scale while others are correct).
- nit: minor drift with no visible brand-identity confusion (a few px off the radius/spacing token).
