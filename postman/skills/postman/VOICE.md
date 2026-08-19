# Voice

The shipped default. **Copy this file to `~/.postman/VOICE.md` (beside your
`identities.json`) and rewrite the patterns in your own voice.** postman reads yours when it is there and falls back to this
one when it is not.

Only the `## Banned` section below does anything on its own: `postman.py` reads that list
and refuses to build an email containing any of it. Everything above it is guidance you
write for yourself, and an unedited copy of this file gives postman nothing to hold a draft
to beyond the banned list.

One `## Patterns - <identity>` section per identity in your `identities.json`. Keep them
separate even where they overlap: a section that tries to cover two mailboxes ends up
describing neither, and the point of per-identity voice is that mail from a work address
and mail from a personal one are not the same register.

**Say how calibrated each section is, and be honest about it.** A section inferred from how
you think you write is worth having and worth labelling as inference - otherwise a later
reader, you or a model, treats a guess as an observation and defends it. Close an
uncalibrated section with a line saying so, and revise it against your first real sends.

## Patterns - example

Replace this section. It is written the way one identity's patterns would be, so the shape
is clear:

- Opens `Hi <FirstName>,` or `Hi A & B,`
- Short. Most messages run one to three sentences.
- The ask is a single sentence carrying its specifics: "We would love to come over to
  take a look at the site, would 3PM on the 4th of August 2026 be possible?"
- Logistics go in labelled lines, not prose and not numbered question lists:
  "Caterer: Example Catering (example.com), one of your approved vendors. Format: high tea
  buffet"
- Closers sit inside the text: `Thank you.` `thanks!` `Understood! No worries.`
- Not over-polished. Minor slips survive and are part of why it reads human.

Calibrated on nothing - it is an example. Delete it once you have written your own.

## Banned

Each bullet below is matched case-insensitively against the body. A hit refuses the
build. `postman.py` reads this list from this section, so it is the only home for it.

The defaults are phrases that mark an email as machine-written to almost any reader. Add
your own: the tics you personally reach for and do not want to send.

An entry is matched as a plain substring, so it can be punctuation rather than a phrase.
That is a sharp tool, and deliberately not a default. If you never use a semicolon or an em
dash, adding `;` or `—` on their own lines makes postman refuse any draft containing one.
That is exactly right for the person who wants it and baffling for anyone who writes
ordinary English, which is why you add it rather than inherit it.

- I hope this email finds you well
- reach out
- please don't hesitate
- delighted to
- I wanted to
- Additionally
- Furthermore
- moreover
- at your earliest convenience
