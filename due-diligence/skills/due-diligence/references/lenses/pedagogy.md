# pedagogy — Does the content actually build knowledge, in the right order?
> Cites: res_pedagogy.md

## Fires on
Tag: `educational`. Any artifact whose job is to teach — tutorial, explainer, course, onboarding, or docs-that-teach. Reviews how knowledge is *built up*, beyond the core clarity lens (which only checks local prose comprehensibility).

## Attacks
**A. Build-up / sequencing**
- Forward reference: a term/concept used, named, or relied on before it's introduced.
- Missing prerequisite: a step assumes knowledge the target learner was never given.
- Concept dump: several new concepts in one step with no sequencing.
- No coherent spine: topics in arbitrary order, not a path that connects ("now that you know X…"); no stated learning objective to align to.

**B. Cognitive load & retention**
- Abstract-first: a principle/definition with no concrete example or worked example before it.
- No signposting: key points and structure not cued; learner can't tell what matters.
- No reinforcement: a load-bearing concept introduced once, never retrieved, recapped, or applied.
- Seductive detail: an interesting tangent that competes with the core idea and adds no learning.

**C. Accessibility of explanation (curse-of-knowledge)**
- Undefined jargon: a technical term used without definition at first use.
- Example-less abstraction, or an analogy that misleads (imports a false property onto the concept).
- No stated relevance: learner isn't told why it matters or where it leads.

**D. Fidelity of simplification**
- Misleading simplification: wrong at its own level, or seeds a misconception the learner must later un-learn.
- Half-truth as whole truth: a simplification that hides real nuance with no "this is the simple version" flag.

## Evidence of attack (clean-pass proof)
Trace the actual learning path, don't assert it reads well: list the concepts in the order introduced and name any forward reference or prerequisite gap; name each load-bearing concept and whether it's reinforced (where); quote one abstraction and confirm an example/analogy precedes it; quote one simplification and judge it productive vs misleading (say why). State the target learner assumed. "Flows well" is not evidence.

## Severity guide
- blocker: a forward reference or missing prerequisite that makes a section incomprehensible to the target learner; or a simplification that is wrong / seeds a misconception needing later un-learning.
- should-fix: too much introduced at once; a load-bearing concept with no reinforcement; undefined jargon; an abstraction with no example; an analogy that subtly misleads.
- nit: motivation/relevance stated late; a recap that could be tighter; signposting that could be stronger.
