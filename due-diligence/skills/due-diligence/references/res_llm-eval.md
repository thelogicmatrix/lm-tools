# res_llm-eval — The LLM-Evaluation Bar
> Research-backed reference for the Due Diligence llm-eval lens. Whether an LLM system's quality is *measured* rather than vibe-checked — distinct from res_llm-safety (injection/output-handling); this is "is it good and does it stay good."

## What good looks like (the bar)

- **An eval set exists.** A representative, held-out set of inputs with expected outputs or grading criteria — run before shipping and on every prompt/model/retrieval change. "It seemed better in a couple of tries" is not evaluation. [Anthropic & OpenAI eval guidance]
- **Metrics fit the task.** Classification → accuracy / precision / recall / F1 (and the right one for the cost of each error type). Free-form generation → a task-specific rubric (faithfulness, relevance, completeness), often scored by **LLM-as-judge** with an explicit rubric. Retrieval/RAG → groundedness (is the answer supported by retrieved context) and context relevance. [RAGAS; G-Eval]
- **Hallucination/faithfulness is measured, not assumed.** For factual or RAG systems, measure whether outputs are grounded in the provided context and actually answer the query — a fluent, confident, wrong answer is the core failure mode. [RAGAS faithfulness/answer-relevance]
- **A regression suite guards prompt and model changes.** Prompts and model versions are pinned and re-evaluated against the set on every change — including a model upgrade (a newer Claude/GPT is a change to re-eval, not a free win). No silent "improved the prompt."
- **LLM-as-judge is calibrated, not trusted blindly.** Judge prompts are validated against a sample of human labels; known biases (position, verbosity, self-preference) are controlled for. [MT-Bench / LLM-as-judge literature]
- **Eval covers failure modes, not just the happy path.** Adversarial/edge inputs, ambiguous queries, long context, refusals, and injection attempts (cross-refs llm-safety) are in the set — not only clean examples.

## Common defects (what to attack)
- No eval set at all — quality judged by a few manual spot-checks; changes shipped with no regression test.
- Metric mismatch — a single accuracy number slapped on a generative task; no faithfulness/relevance for a RAG system; wrong error-type weighting.
- Hallucination/groundedness never measured on a factual or retrieval system.
- Prompt or model change (incl. a model-version upgrade) shipped with no re-evaluation — "looks fine."
- LLM-as-judge scores trusted with zero calibration against human judgement.
- Eval only on happy-path inputs — no adversarial, edge, ambiguous, long-context, or refusal coverage.
- Eval set contaminated by / identical to the examples used to build the prompt (train-on-test).

## Quick-reference checklist
- [ ] A representative, held-out eval set exists and is run on every prompt/model/retrieval change
- [ ] Metrics match the task type (classification vs generation vs RAG), not a generic accuracy number
- [ ] Faithfulness/groundedness measured for factual/RAG systems
- [ ] Model-version upgrades are re-evaluated, not assumed to be improvements
- [ ] LLM-as-judge is calibrated against human labels; judge biases controlled
- [ ] Eval includes adversarial/edge/ambiguous/refusal cases, not just happy path
- [ ] Eval set is independent of the data used to design the prompt (no train-on-test)

## Sources
- [Anthropic — Create strong empirical evaluations](https://docs.anthropic.com/en/docs/test-and-evaluate/develop-tests) — building task-appropriate eval sets and grading; eval-driven prompt development.
- [OpenAI — Evals / evaluation guidance](https://platform.openai.com/docs/guides/evals) — offline eval sets, regression testing of prompt/model changes.
- [RAGAS — RAG evaluation metrics](https://docs.ragas.io/) — faithfulness, answer relevance, context precision/recall as the standard RAG metric set.
- [Zheng et al., "Judging LLM-as-a-Judge with MT-Bench" (2023)](https://arxiv.org/abs/2306.05685) — LLM-as-judge validity, agreement with humans, and the position/verbosity/self-preference biases to control.
