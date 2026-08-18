# Why a sprint is shaped this way

This file explains the reasoning behind `learn`'s defaults. It is deliberately in three parts, and the first two are **not the same kind of claim**. Part 1 is published research by named researchers, stated as narrowly as it can honestly be stated. Part 2 is this plugin's own invented configuration, which nobody has validated. Part 3 is failure modes to watch for.

If you read one sentence: the research in Part 1 **motivates** the design, it does not endorse the specific numbers in Part 2. Anything that looks like a rule with a number attached to it was made up, and it lives in Part 2 where it is labelled as such.

For how to actually run a sprint or a session, see `starting-a-sprint.md` and `running-a-session.md`. This file is only about why.

## Part 1 — The evidence: five cited frameworks

Everything in this part is published work by the researchers named. Each entry says what the research supports, and where it matters, what it does not.

### Knowles — andragogy

Malcolm Knowles's andragogy is a model of adult learning built from a set of assumptions about how adults differ from children as learners: they are more self-directed, they arrive with substantial prior experience, and their orientation to learning is problem-centred rather than subject-centred. The last assumption is the one that matters here, that adults engage more readily with material organised around a problem they want to solve than around a subject syllabus.

Stated narrowly: andragogy is an influential framework of practice rather than a single validated experimental result, and its assumptions have been argued over in the literature since Knowles proposed them. It is the reason a sprint is built around a project you actually want instead of a curriculum. Treat it as a well-argued orientation, not as proof.

### Chi and Wylie — ICAP

Michelene Chi and Ruth Wylie's ICAP framework sorts learner behaviour into four modes of cognitive engagement and predicts that learning outcomes improve in this order: **Passive** (taking information in, such as reading or watching), **Active** (doing something physical with it, such as highlighting or copying out), **Constructive** (producing something beyond what you were given, such as explaining it in your own words or drawing an inference), **Interactive** (substantive back-and-forth in which both partners contribute constructively).

What it supports: activities higher in that ordering tend to produce better learning than activities lower in it, across the body of studies Chi and colleagues reviewed and tested. It is the reason a session pushes toward building and explaining rather than reading, and the reason "I read the docs" does not count as a session.

Narrowing: Interactive in ICAP means genuine two-way dialogue where both parties contribute, and the work behind it involves human partners, peers or tutors. A `learn` sprint puts a model in that seat. That is a reasonable extension of the idea. ICAP did not test it, and it should not be read as validating it.

### Sweller — cognitive load and the worked-example effect

John Sweller's cognitive load theory starts from the fact that working memory is severely limited when handling novel information, while long-term memory is not. Instruction that spends that limited capacity on things incidental to the learning leaves less of it for the learning itself.

The worked-example effect is the best-supported specific result in that line of work: for learners new to a domain, studying a complete worked example produces better learning, in less time, than being handed the equivalent problem to solve unaided. It has been replicated widely.

Narrowing: the effect is documented against **unguided problem-solving**, and it reverses as expertise grows (the expertise reversal effect), so worked examples lose their advantage and can eventually get in the way once a learner knows the material. A sprint's habit of leading with one complete worked example rather than explaining the pieces first is motivated by this. That specific ordering is not the comparison the studies ran, and a sprint is short and aimed at a novice, which is part of why the assumption holds at all.

### Perkins and Salomon — transfer

David Perkins and Gavriel Salomon's central claim about transfer of learning is a negative one: transfer does not reliably happen by itself. Something learned in one context very often fails to show up in another, and instruction that assumes it will carry across is usually wrong about that.

Their positive claim is that transfer has to be designed for. They distinguish low-road transfer, which comes from varied practice until a skill is near-automatic, from high-road transfer, which requires deliberately abstracting the principle out of the specific case and consciously bridging it to a new one.

This is the sharpest and most directly usable of the five, and it is why a worked example is always paired with the principle it generalises to instead of being left to stand alone. That pairing is high-road bridging applied. Whether this plugin's particular way of applying it works is a separate and untested question.

### Deci and Ryan — self-determination theory

Edward Deci and Richard Ryan's self-determination theory holds that three basic psychological needs support intrinsic motivation and sustained engagement: **autonomy** (acting from your own volition), **competence** (feeling effective at what you are doing), and **relatedness** (connection to other people). It has a large evidence base across education, work and sport, and is among the more heavily replicated motivational theories.

Where a sprint leans on it, and where it does not: the learner chooses the subject and the project, which serves autonomy, and every session ends in a gate that can produce a visible pass, which serves competence. Relatedness is the need a solo sprint serves worst, and this plugin does nothing at all about it. When a sprint stalls for no obvious reason, that is a plausible place to look, and the fix is outside the tool.

## Part 2 — The invention: this plugin's own defaults, none of them validated

**The frameworks above are cited research. Everything in this part is this plugin's own operationalisation of them, and none of it is validated. One learner, one week of one sprint stands behind all of it. Treat it as a starting configuration, not a finding.**

Concretely that means: nothing in the list below has been compared against an alternative, measured against an outcome, or tried by anybody else. Every number was picked because it seemed reasonable to one person on one occasion. Where a default gets in your way, change it. You are not overriding evidence, because there is none.

- **The two-hour session and its slot lengths.** How long a session runs, and how those minutes divide between reading the example, building, and consolidating. No finding produced those numbers. They are a shape that fits an evening.
- **One new concept per session.** Loosely motivated by working-memory limits, but "one" is a choice rather than a measured capacity. Two might work for you, and nothing here can tell you it will not.
- **The verify exercise floor of once every two weeks.** Two weeks is arbitrary. The reasoning behind having a floor at all is that an exercise with no floor gets skipped forever the moment it feels awkward. The interval had to be some number, and this was the number.
- **Pass or fail as the gate's only resolution.** No partial credit and no score. Binary because it forces an actual decision rather than a comfortable "mostly". Nothing establishes that a binary gate teaches better than a graded one.
- **Repeat-on-fail with a different worked example.** That a failed gate repeats the same concept with a *new* example rather than a re-read. The "different example" part is a hedge against the fluency illusion in Part 3, but the rule itself is invented.
- **A sprint of 4 to 8 weeks.** Long enough to reach something real, short enough to still care by the end. Both ends of that range are guesses.
- **Project-first as the default sequencing.** Motivated by Knowles's problem-centred orientation, but how *strongly* it is defaulted, and the fact that it is a default at all rather than a suggestion, is this plugin's call.

## Part 3 — Gotchas: failure modes to watch for

These are practitioner cautions rather than citations, and they belong to neither part above. They are here because every one of them feels like progress while it is happening.

Four that hit a concept-heavy track hardest:

- **Reading feels like learning and is not.** Reading is the most comfortable thing available and, in ICAP terms, the lowest mode there is. A session that consisted of reading has produced a feeling, not a capability. It is the easiest way there is to spend eight weeks and finish with nothing.
- **The fluency illusion.** Recognising material on a re-read is not the same as being able to reconstruct it from nothing. Re-reading reliably raises the sense of familiarity, and familiarity impersonates mastery well. The only honest test is reconstructing the thing with the source closed, which is what a gate is for. "It looked familiar" is not evidence.
- **The collector's fallacy.** Gathering sources, bookmarks, courses and reading lists feels enormously productive and is Passive mode wearing a productivity costume. A queue of unread material is not progress toward anything. A sprint's source list should be short and consumed, not long and pending.
- **With no compiler, the model becomes the only feedback loop.** On a code track a build either passes or it does not, so something outside your own head disagrees with you regularly. On a concept track nothing does. That is exactly why a gate is never self-certified: a novice grading their own understanding is the least reliable judge available, and a model that agrees with everything is not a feedback loop, it is a mirror.

Two that started as code-track cautions and generalise to every track:

- **"Fundamentals first" is a trap.** Working through the foundations before touching the thing you came for reliably produces weeks of study and no project. Fundamentals land far better once a concrete problem has already made you need them, which is the whole argument for project-first sequencing.
- **The curse of knowledge.** An explanation written by an expert quietly assumes everything the expert already knows. A worked example that makes you feel stupid is usually a bad worked example, not a bad learner. Go find another one, or ask for it to be rebuilt from further back, rather than concluding the subject is beyond you.
