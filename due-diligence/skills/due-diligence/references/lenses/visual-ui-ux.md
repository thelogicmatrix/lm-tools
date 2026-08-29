# visual-ui-ux — Does the rendered page actually look and work right?
> Cites: res_visual-design.md + res_accessibility.md (contrast)

## Fires on
Tags: rendered-ui. Any artifact that is a live page, local server, or static HTML that can be opened in a browser.

## How it runs
Tool: **Playwright MCP** (`mcp__playwright__*`) — headless, isolated, deterministic screenshots at set viewports. Handles localhost dev servers, public live URLs, and `file://` static HTML. Flow: `browser_navigate` → `browser_resize` 1280×800 + `browser_take_screenshot` (desktop) → `browser_resize` 390×844 + `browser_take_screenshot` (mobile) → `browser_console_messages` (errors) → critique. At Heavy tier add interactive states (`browser_hover`/`browser_click` for hover/focus) + the 768/1024 breakpoints. Screenshots + specific coordinates/text are the evidence.

**Task walk (Standard tier and up):** don't just screenshot — *generate 2–4 concrete tasks a real user would come here to accomplish* (derive them from Step 0 "what is it for" + what the UI visibly offers — e.g. "apply to a job", "filter to remote roles", "edit a saved item"), then attempt each through the interface as a first-time user would. For each task: click/type your way through (`browser_click`/`browser_fill_form`), screenshot each result, read the console after each step, **assert the expected next state actually appears**, and **rate how easy it was to achieve** — completed / completed-with-friction / couldn't-complete, with the step count and where the friction was (unclear affordance, hidden control, dead button, erroring step, lost state, no feedback). A task that can't be completed, or a "simple" task that takes a confusing detour, is a defect a static screenshot can't catch. List every task you tried and its outcome + ease rating. If auth blocks a task, say so rather than skipping silently. (Light tier stays screenshot-only — no task walk.)
Auth note: Playwright runs its own isolated browser — it does NOT reuse your real browser session (Zen, Chrome, whatever), so there's nothing to "log in as you." Two cases: **localhost / `file://` (the normal in-development case) needs no auth** — just point Playwright at it. A **deployed page behind CF Access/login** must be authenticated within Playwright first: fill the login form once, or load stored cookies/session state. Public pages need no auth.

## Attacks
- Broken rendering: overflow, overlap, cut-off/clipped text, misalignment off the implied grid, missing/broken images.
- Responsive breakage: forced horizontal scroll, or squished/unusable layout at mobile width (~390px) or the 768/1024 tablet transitions.
- Contrast/legibility below WCAG 2.2: body text < 4.5:1, large text (18pt/24px+ or 14pt-bold+) < 3:1, non-text UI elements (borders, icons, focus rings) < 3:1.
- Weak hierarchy: no single visually-dominant primary action, or hierarchy built from size alone instead of ≥2 of {size, weight, color}.
- Spacing inconsistent with the 8pt/8dp grid — margins/padding that aren't multiples of 8 (or 4 for tight spots), or dividers doing the job proximity/spacing should do.
- Task not achievable / hard to achieve (Standard+): a generated user task can't be completed (dead button, erroring step, lost state, dead end), or completes only with confusing friction — hidden/unclear control, no feedback, a detour a first-time user wouldn't find. The page renders fine but the task is blocked or needlessly hard.
- Redundancy: the same information or control repeated, headings/labels restating the obvious, boilerplate captions on self-evident elements, duplicated nav/actions — the AI-UI habit of over-producing. Name each repeat and what it competes with.
- Everything-on-screen (no progressive disclosure): advanced/rare/detail content shown at full weight in the default view instead of tucked behind an expander/tab/drill-in that stays accessible — the primary task is buried under options most users don't need right now.
- Unchunked / single-page overload: a long page doing several distinct jobs, or a long form / multi-step task poured onto one endless scroll, where labelled sections or a split into multiple pages/steps (wizard) would be materially more consumable. Say how you'd chunk or paginate it.

## Measure
Viewports passing ÷ 4 (390, 768, 1024, 1280: no horizontal scroll, no clipped or overlapping
text). Task-walk tasks completed ÷ attempted (Standard and above). Lowest body-text contrast ratio
measured. Report as "k/4", "n/N" and the ratio. Any viewport failing on the primary flow, a task
the user cannot complete, or body text below the 4.5:1 AA floor = blocker. Any other failure =
should-fix.

## Evidence of attack (clean-pass proof)
Both screenshots (desktop + mobile) plus the console read, with named specific issues and coordinates/text quoted from the page — not "looks fine." State measured contrast ratios where checked, not eyeballed. State what you checked for redundancy, progressive disclosure, and page/step structure — name repeats found (or "none"), what's shown that should be deferred, and whether the content/task should be chunked or split. At Standard+: list every task attempted, its outcome (completed / friction / couldn't-complete), step count, and where friction occurred.

## Severity guide
- blocker: broken/unusable render (overlap, clipped critical content, forced horizontal scroll) or text below the AA contrast floor; or a generated user task can't be completed at all (dead button, erroring step, lost state).
- should-fix: responsive rough edge at a named breakpoint; weak/absent primary-action hierarchy; a task that completes only with real friction (first-time user stalls on an unclear/hidden control, gets no feedback, or takes a confusing detour); the primary task buried under always-visible advanced/detail content that belongs behind progressive disclosure; or a multi-task/long-form page that should be chunked or split into steps to be consumable.
- nit: spacing polish off the 8pt grid with no functional impact; minor cosmetic repetition or a restated label that clutters without misleading.
