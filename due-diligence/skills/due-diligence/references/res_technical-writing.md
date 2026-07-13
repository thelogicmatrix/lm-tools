# res_technical-writing — The Communication Bar
> Research-backed reference for the Due Diligence communication lenses: necessity, clarity, audience-fit, structure-navigability, voice (AI-tells), actionability, and depth-sufficiency.
> Companion, not a duplicate: for sentence-level mechanics (cutting words, active-voice
> rewrites), see the `elements-of-style:writing-clearly-and-concisely` skill. This file
> is the standards/authority layer — what the defect *is*, why it's a defect, and the
> check to run for it.

## What good looks like (the bar)

- **Bottom line first.** State the conclusion, decision, or ask in the first sentence
  or paragraph; details and justification follow. Military BLUF doctrine: give the
  bottom line "because the greatest weakness in ineffective writing is that it doesn't
  quickly transmit a focused message" [BLUF, Wikipedia]. Same principle as
  journalism's inverted pyramid: lead with the single fact a skimming reader must walk
  away with, then rank supporting detail broad-to-narrow [NN/g, Inverted Pyramid].
- **Every word earns its place.** "A sentence should contain no unnecessary words, a
  paragraph no unnecessary sentences... he must make every word tell" [Strunk & White,
  Rule 13, Omit Needless Words]. This is a cutting test, not a style preference:
  removing the word/sentence should lose information, or it goes.
- **Active voice by default.** "The active voice is usually more direct and vigorous
  than the passive" [Strunk & White, Rule 10]. Passive stays legitimate when the actor
  is genuinely unknown, irrelevant, or the object is the sentence's real topic — not
  as a default hedge.
- **Write for the stated reader, not yourself.** Federal plain-language doctrine,
  codified for US agencies by the Plain Writing Act of 2010, requires "clear
  Government communication that the public can understand and use" [Plain Writing
  Act, Treasury/DOJ/FDA summaries] — calibrate jargon, assumed knowledge, and depth to
  the *least*-expert reader who must act on the document, per Due Diligence Step 0.
- **Readability is measurable, not vibes.** Flesch-Kincaid grade level and Flesch
  Reading Ease turn "is this readable" into a number (sentence length + syllable
  count); plain-language toolkits commonly target a grade level matched to the
  audience rather than the writer's own reading level [Readable.com; MSKTC Plain
  Language Toolkit].
- **Structure serves the skimmer.** Short paragraphs, descriptive headings, and
  front-loaded key words in every sentence let a reader stop at any point and still
  have the main point — "users don't read carefully online... they have little
  patience for content that doesn't engage them" [NN/g, Inverted Pyramid].
- **As deep as the decision needs — no deeper, no shallower.** Concision (Rule 13)
  cuts *needless* words; it does not license omitting *needful* ones. A load-bearing
  claim, step, or recommendation earns its support (mechanism, evidence, example, or
  "how"); a minor point earns a clause. Under-development — a consequential assertion
  in one line the reader can neither act on nor verify — is as much a defect as padding,
  the opposite failure of the same "match content to the reader's need" principle.
- **Reads as a person wrote it, not a model.** AI-generated prose has recognisable
  tells that erode a skeptical reader's trust before they judge the substance: reflexive
  hedging ("it's worth noting", "generally speaking"), formulaic triads (everything
  arriving in threes), sycophantic openers ("Great question!"), empty summarising ("In
  conclusion, X is a multifaceted topic"), inflated register ("delve", "leverage",
  "robust", "underscore"), and uniform paragraph rhythm. A named subset of filler, worth
  calling out because AI output is DD's primary subject.

## Common defects (what to attack)

- **Filler / throat-clearing** — "it should be noted that," "in order to," "there is
  no doubt but that." Strunk & White's own catalogue of these phrases and their
  one-word replacements is the working blocklist (e.g. "owing to the fact that" →
  "since"; "the fact that he had not succeeded" → "his failure") [Rule 13].
- **Undefined jargon** — a technical, internal, or acronym term used without
  definition for the audience named in Step 0. If the least-expert intended reader
  would stop and ask "what does that mean," it's a defect, not a style choice.
- **Buried bottom-line** — the conclusion, ask, or risk appears in paragraph 3+, in a
  "Discussion" section, or after the backstory, instead of sentence 1. Violates BLUF
  and the inverted pyramid directly.
- **Passive hedging** — "mistakes were made," "it was decided," "the figure was
  revised." Passive voice used specifically to omit *who* acted hides accountability
  and breaks traceability — this overlaps the due-diligence provenance lens, not just
  style.
- **Nominalizations (noun-string verbs)** — "conduct an investigation" instead of
  "investigate," "make a decision" instead of "decide." Strunk & White's "the fact
  that" family generalizes to any buried verb; unpacking it usually halves the word
  count [Rule 13, Macbeth example: 51 words → 26 words by combining steps into one
  active clause].
- **Unlabeled units / missing baseline** — a number with no unit, currency, date, or
  comparison period ("sales grew" — grew from what, over what window, in what
  currency).
- **Stacked complexity** — one idea spread across several short choppy sentences, or
  one sentence overloaded with multiple qualified clauses; both fail Rule 13's "make
  every word tell" test in opposite directions.
- **Under-developed / glossed-over** — a consequential claim, step, or recommendation
  stated in one line with no support, mechanism, example, or "how." The counterpart to
  filler: filler is words carrying no information; this is information the reader needs
  to act or verify that simply isn't there. Tell: a recommendation with no "how", a
  number with no "why", a step that assumes an unstated leap.
- **AI-generated tells** — reflexive hedging, formulaic list-of-three, sycophantic
  openers, empty conclusion paragraphs, inflated "delve/leverage/robust" register,
  uniform sentence rhythm. Reads as machine-produced and undermines trust in the
  substance even when the substance is sound.

## Quick-reference checklist

- [ ] First sentence/paragraph states the conclusion or ask, not the backstory
- [ ] Every jargon/acronym term is defined on first use, or cut
- [ ] Every number carries a unit, a date/period, and (if a claim of change) a baseline
- [ ] No throat-clearing filler ("the fact that," "in order to," "it should be noted")
- [ ] Verbs carry the action, not noun strings ("decide" not "make a decision")
- [ ] Active voice is the default; passive only where the actor is unknown/irrelevant
- [ ] Every passive/hedged sentence checked — does it hide *who* did or decided this?
- [ ] Paragraphs short enough to skim; headings and first sentences alone carry meaning
- [ ] Reading level roughly matches the stated audience (spot-check Flesch-Kincaid for
      external/public documents)
- [ ] Deleting any given sentence would lose information the reader needs to act
- [ ] Every load-bearing claim/step/recommendation is developed enough to act on or verify — not glossed in one line
- [ ] Reads as human-written — no reflexive hedging, formulaic triads, sycophantic openers, or empty-summary filler
- [ ] Depth and register match the stated audience — not over-explained for an expert, not under-explained for a novice

## Sources

- [Federal Plain Language Guidelines / plain-language guide series](https://digital.gov/guides/plain-language) — canonical US federal plain-language doctrine; note: plainlanguage.gov's guideline pages now redirect/consolidate into this digital.gov guide series as of this research (mid-2026), so cite digital.gov as the live pointer.
- [Plain Writing Act of 2010 — Treasury summary](https://home.treasury.gov/subfooter/site-policies-and-notices/plain-writing) — the statutory requirement behind federal plain-language practice; corroborated by DOJ, FDA, and ODNI's own restatements.
- [Strunk, *The Elements of Style*, Rule 13 "Omit Needless Words" — Project Gutenberg](https://www.gutenberg.org/files/37134/37134-h/37134-h.htm) — the necessity/concision test and the filler-phrase blocklist used above.
- [Strunk, *The Elements of Style*, Rule 10 "Use the Active Voice" — Project Gutenberg](https://www.gutenberg.org/files/37134/37134-h/37134-h.htm) — active-vs-passive rule and when passive is legitimate.
- [BLUF (communication) — Wikipedia](https://en.wikipedia.org/wiki/BLUF_(communication)) — origin (US Army DA pamphlet, now rescinded, on effective writing), definition, and worked example.
- [Nielsen Norman Group, "Inverted Pyramid: Writing for Comprehension"](https://www.nngroup.com/articles/inverted-pyramid/) — reader-behavior evidence (skimming, scrolling, patience) behind lead-with-the-point structure; a 5-step method for applying it.
- [Readable.com, "Flesch Reading Ease and the Flesch-Kincaid Grade Level"](https://readable.com/readability/flesch-reading-ease-flesch-kincaid-grade-level/) — the formulas behind measurable readability targets.
- [MSKTC, "Writing and Testing Plain Language" toolkit (PDF)](https://msktc.org/sites/default/files/lib/docs/KT_Toolkit/MSKTC_Plain_Lang_Tool_508.pdf) — practical grade-level/reading-ease targets for public-facing writing.

**No real conflicts found** among these sources — Strunk & White (1918), federal plain-language doctrine (2010–present), and web-usability research (NN/g) converge on the same core moves: lead with the point, cut what doesn't serve the reader, prefer active/concrete phrasing, and write to the reader's level rather than the author's. The one notable non-content conflict: plainlanguage.gov's own guideline pages are currently redirecting into a consolidated digital.gov guide series rather than serving standalone content — an availability change, not a doctrinal one.
