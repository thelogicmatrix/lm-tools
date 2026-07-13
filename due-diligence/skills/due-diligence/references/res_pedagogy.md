# res_pedagogy — What Good Teaching Content Looks Like
> Research-backed reference for the Due Diligence `pedagogy` lens. The bar a hostile reviewer checks educational/instructional content against — how well it *builds up* knowledge, not just whether the prose is clear.

## What good looks like (the bar)

**Sequencing & prerequisite structure**
- No forward references: nothing is used, named, or relied on before it has been introduced. Every concept's prerequisites appear earlier in the path. [Gagné, "Conditions of Learning" — hierarchical prerequisite ordering]
- A coherent spine: the content is a deliberate path ("now that you know X, Y follows"), not a pile of topics in arbitrary order. Each section connects forward and back.
- Learning objectives are stated (what the learner will be able to do), and the content + any checks align to them. [Biggs — constructive alignment; Bloom's taxonomy for objective verbs]

**Scaffolding (Zone of Proximal Development)**
- Each new idea sits just beyond what the learner already holds but within reach of it — not a leap. Support is provided then faded as competence grows. [Vygotsky — ZPD; Wood, Bruner & Ross — scaffolding]
- Concrete before abstract: a tangible example, then the general principle — not the definition first. [instructional-design consensus; corroborated by Mayer]

**Cognitive load (working memory is small: ~4–7 items)**
- Manage *intrinsic* load by sequencing and segmenting: one new element at a time; don't introduce several unfamiliar concepts in one step. [Sweller — Cognitive Load Theory]
- Minimise *extraneous* load: cut anything that adds processing without adding learning (decorative detour, off-topic tangent). [Sweller; Mayer coherence]
- Worked examples before independent practice — showing a fully worked solution first is more effective for novices than problem-solving from scratch (the worked-example effect); fade to practice as expertise grows (expertise-reversal). [Sweller & Cooper]

**Multimedia / presentation design (Mayer's principles)**
- Segmenting: break continuous content into learner-paced units.
- Signaling: cue the key points/structure (headings, emphasis, "the important part is…").
- Coherence: exclude interesting-but-irrelevant material ("seductive details") that competes with the core.
- Pre-training: introduce the names/characteristics of key components before explaining the process that uses them.
- Contiguity: keep a figure/label and its explanation together in space and time. [Mayer — Cognitive Theory of Multimedia Learning]

**Retention & retrieval**
- Reinforce load-bearing ideas: recaps, checks-for-understanding, and opportunities to *retrieve* (recall, apply) — retrieval practice beats re-reading for durable learning. [Roediger & Karpicke — testing effect]
- Prefer spacing over massing: a key idea revisited across the path outlasts one dense block. [Ebbinghaus spacing; Brown, Roediger & McDaniel, "Make It Stick"]

**Explanation accessibility (defeating the curse of knowledge)**
- Every term is defined at first use; no assumed prior knowledge the *target* learner lacks. The expert's blind spot — forgetting what it's like not to know — is the default failure mode of technical teaching. [Willingham — "Why Don't Students Like School?"; expert blind-spot research]
- Every abstraction carries an example or analogy, and the analogy is *apt* — it maps to the concept without importing a false implication.
- Relevance is stated: the learner is told why this matters and where it leads, connecting new material to prior knowledge and motivation.

**Fidelity of simplification (critical for technical subjects)**
- Simplifications are *productive*: incomplete but not wrong — a beginner-level model that later study extends, not one that must be actively un-learned. Distinguish a useful approximation ("treat it as X for now") from a falsehood stated as fact.
- Anticipate, don't seed, misconceptions: name the wrong mental model a learner is likely to form and head it off, rather than phrasing that plants it. [misconceptions / threshold-concepts research — Meyer & Land]
- Where a simplification hides real nuance, it is flagged as simplified ("this is the simple version; the full picture adds…") rather than presented as the whole truth.

## Common defects (what to attack)
- Forward reference: a term/concept used before it's introduced, or a section that can't be understood without knowledge introduced only later.
- Missing prerequisite: a step assumes knowledge the target learner was never given and can't reasonably have.
- Concept dump: several new concepts introduced at once with no sequencing (intrinsic-load overload).
- Abstract-first: a definition or general principle stated with no concrete example/analogy anchoring it.
- Undefined jargon: a technical term used without definition at first use (curse-of-knowledge tell).
- No reinforcement: a load-bearing concept introduced once and never retrieved, recapped, or applied.
- Seductive detail: an interesting tangent/anecdote that competes with the core idea and adds no learning.
- Objective-less: no stated learning goal, so "did the learner get it?" has no defined bar.
- Misleading simplification: a simplification that is actually *wrong* at its own level, or that seeds a misconception the learner must later un-learn; a half-truth stated as whole truth with no "simplified" flag.
- Analogy that misleads: an analogy whose surface fit imports a false property of the source onto the target.

## Quick-reference checklist
- [ ] Nothing is used before it's introduced (no forward references)
- [ ] Every concept's prerequisites come earlier; there's a coherent path, not a topic pile
- [ ] Stated learning objective(s); content aligns to them
- [ ] Concrete example/analogy precedes each abstraction; analogies don't mislead
- [ ] One new concept at a time; worked examples before independent practice
- [ ] Key points signposted; irrelevant "seductive" detail cut
- [ ] Load-bearing ideas reinforced (recap / retrieval / applied), not stated once
- [ ] Every term defined at first use; no unstated assumed knowledge
- [ ] Relevance/motivation stated — why it matters, where it leads
- [ ] Simplifications are productive (not wrong); misconceptions anticipated not seeded; "simplified" flagged where nuance is hidden

## Sources
- Sweller, J. — Cognitive Load Theory; worked-example effect (Sweller & Cooper, 1985). Foundational for intrinsic/extraneous load and novice sequencing.
- Mayer, R. — Cognitive Theory of Multimedia Learning; the segmenting, signaling, coherence, pre-training, contiguity, and redundancy principles. Empirically-tested presentation guidance.
- Vygotsky, L. — Zone of Proximal Development; Wood, Bruner & Ross (1976) — "scaffolding." Basis for pitching each step within reach and fading support.
- Bloom's Taxonomy (revised, Anderson & Krathwohl 2001) — objective verbs / cognitive levels; and Biggs, J. — constructive alignment (objectives ↔ content ↔ assessment).
- [Rosenshine, B. — Principles of Instruction (AFT, 2012)](https://www.aft.org/sites/default/files/periodicals/Rosenshine.pdf) — research-backed teaching principles: small steps, worked examples, checking for understanding, review.
- Roediger, H. & Karpicke, J. (2006) — the testing/retrieval-practice effect; Brown, Roediger & McDaniel, "Make It Stick" (2014) — retrieval and spaced practice for durable learning.
- Willingham, D. — "Why Don't Students Like School?" — cognition for teaching; the curse-of-knowledge / expert blind spot.
- Meyer, J. & Land, R. — threshold concepts and troublesome knowledge; misconceptions research — why some simplifications must be un-learned.
