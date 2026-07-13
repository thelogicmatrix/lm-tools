# llm-eval — Is the LLM system's quality measured, or vibe-checked?
> Cites: res_llm-eval.md

## Fires on
Tag: llm-pipeline. Select for any system whose output quality depends on an LLM (generation, extraction, classification, RAG, agents). Distinct from the llm-safety lenses (prompt-injection/output-grounding handle *safety*) — this is *is it good, and does it stay good across changes*.

## Attacks
- No eval set — quality judged by a few manual tries; changes shipped with no regression test.
- Metric mismatch — a single accuracy number on a generative task; no faithfulness/relevance for a RAG system; error types weighted wrong for the cost of each.
- Hallucination/groundedness never measured on a factual or retrieval system.
- Prompt or model change (including a model-version upgrade) shipped with no re-evaluation — "upgraded the model, looks fine."
- LLM-as-judge scores trusted with no calibration against human labels; judge biases (position/verbosity/self-preference) uncontrolled.
- Eval only on happy-path inputs — no adversarial, edge, ambiguous, long-context, or refusal coverage.
- Eval set contaminated by the examples used to build the prompt (train-on-test).

## Evidence of attack (clean-pass proof)
State whether a held-out eval set exists, what metrics it uses and whether they fit the task, whether faithfulness/hallucination is measured for factual/RAG work, and whether prompt/model changes trigger re-eval. If LLM-as-judge is used, confirm calibration against humans. Name the gap or confirm the eval regime with specifics — "output looks good" is exactly the defect.

## Severity guide
- blocker: no eval at all on a system whose correctness matters, or a model/prompt change shipped with no regression check on a high-stakes path.
- should-fix: eval exists but metrics mismatch the task, hallucination unmeasured on a RAG system, or judge uncalibrated.
- nit: eval set could add more edge cases; a metric could be reported alongside another.
