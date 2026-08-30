# cost-token-efficiency — Is this LLM call spending tokens/tier where it doesn't need to?
> Cites: internal. Provider cost-control practice: model tier, max_tokens, prompt caching, batching, cheaper fallback path.

## Fires on
Tags: llm-pipeline. Any artifact defining an LLM call or pipeline — model choice, prompt construction, context assembly, or a loop/batch of calls.

## Attacks
- Wrong model tier: a heavy/expensive model used for a task a cheaper tier would handle (classification, extraction, simple rewrite) with no stated reason for the upgrade.
- max_tokens unset or too high: no output cap, or a cap far beyond what the task needs, risking runaway generation cost.
- No prompt caching on repeated context: a large, unchanging system prompt/context block is re-sent every call instead of cached.
- No batching: independent, non-latency-sensitive calls are issued one at a time instead of via a batch API.
- No cheaper fallback path: every request goes to the top-tier model with no cheap-first/escalate-on-failure route.
- Re-sending large context each call: the same large document/history is retransmitted in full instead of trimmed, summarized, or cached.

## Measure
Levers set with a stated reason ÷ 5 (model tier, max_tokens, caching on repeated context,
batching, cheaper fallback). Report as "k/5" and name the missing ones. An order-of-magnitude
waste from one missing lever = blocker. Any other missing lever with a moderate, quantifiable cost
= should-fix, a single-digit-percent saving = nit.

## Evidence of attack (clean-pass proof)
Name each lever actually set — model tier and why it fits the task, max_tokens value and its basis, whether caching is enabled on the repeated-context portion, whether batching applies given the latency requirement, and whether a cheaper-tier/fallback path exists. A pass means the levers are named with a reason, not merely "cost looks reasonable."

## Severity guide
- blocker: order-of-magnitude waste — top-tier model on a trivial task, uncapped max_tokens on an unbounded loop, or full context resent every call with caching trivially available.
- should-fix: one lever left on the table (no caching, no batching, no fallback) with a moderate, quantifiable cost impact.
- nit: marginal — a lever that would save single-digit-percent cost, not worth the added complexity yet.
