# Ending a sprint: propose the profile update

The learner profile at `.learn/profile.md` is the one file `learn` reads and never writes.
That is deliberate: a profile the learner never agreed to is a model's opinion filed as a
fact, and the next sprint's intake reads it as fact. So the profile only ever gets written by
a human, or by you when the learner asks for it in so many words.

When a sprint finishes, draft the update and hand it over. Run `learn profile` first: if it
prints `No profile yet at <path>`, the draft is the whole file, otherwise propose it as a
change against what is already there. Cover what the gate history actually shows rather than
an impression of how it went:

- which concepts passed first time, which needed a repeat and what the repeat changed
- whether the verify floor was met or the gap got recorded
- what plain-language level the learner now reads as for this subject (what
  [starting-a-sprint.md](starting-a-sprint.md)'s intake question 2 asks for, so the next
  sprint does not ask cold)

Then name the path and stop: the learner writes it to `.learn/profile.md`, or asks you to
write it for them. Never save it unasked, and never say `learn` created it; no verb does.
