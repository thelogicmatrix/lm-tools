# prompt-injection — Can untrusted content hijack the model's instructions or actions?
> Cites: res_llm-safety.md

## Fires on
Tags: llm-pipeline. Any artifact where an LLM call ingests content the model reads (user text, RAG/tool results, web pages, email, file uploads) alongside a system/developer prompt.

## Attacks
- Direct prompt injection: attacker-controlled user-turn text overrides system instructions ("ignore the above and…").
- Indirect prompt injection: instructions embedded in content the model reads rather than types — retrieved docs, tool output, web pages, email — concatenated in as if trusted (OWASP LLM01).
- System-prompt/instruction leakage: system prompt is extractable and contains secrets or rule/limit logic an attacker could exploit once known (OWASP LLM07).
- Tool-abuse / excessive agency: the model can invoke an over-broad tool (generic shell/HTTP/file-write) or trigger a high-impact action (delete/send/pay/post) without a human or deterministic gate (OWASP LLM06).
- Insecure handling of model output: model output is fed into exec/shell, SQL, HTML/JS render, a file path, or an email template without sink-specific validation (OWASP LLM05).

## Evidence of attack (clean-pass proof)
Trace every point untrusted content enters the prompt: name the source (user input, RAG chunk, tool result, fetched page), show it is segregated/marked as untrusted rather than concatenated as trusted context, and confirm it cannot alter which tools fire or what the system prompt asserts. Name the tool surface available to the model and confirm least-privilege scoping plus a human/deterministic gate on high-impact actions. Confirm no secrets or permission logic live in the system prompt. "No injection risk" without naming the traced entry points and tool list is not evidence.

## Severity guide
- blocker: untrusted input can override system instructions, leak the system prompt's secrets, or trigger a high-impact tool call with no gate.
- should-fix: untrusted content is concatenated as trusted context but no exploit path is demonstrated, or a tool is broader than the task needs.
- nit: hardening — stronger input/output isolation, tighter tool scoping, rate limits on model/tool calls not currently exploitable.
