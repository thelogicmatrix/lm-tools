# res_llm-safety — The LLM-Safety Bar
> Research-backed reference for the Due Diligence prompt-injection and output-grounding lenses.

Baseline standard: **OWASP Top 10 for LLM Applications v2.0 (2025)** — the audit checklist industry
reviews cite. Cross-checked against **NIST AI RMF's Generative AI Profile (NIST AI 600-1, Jul 2024)**
for governance framing, and against the practitioner/academic writing that coined the underlying
attack classes (Simon Willison 2022–23; Greshake et al. 2023). All three agree on the core taxonomy
below — no material conflicts, only terminology drift (see reconciliation note at the end).

## What good looks like (the bar)

- Untrusted input (user text, retrieved documents, web pages, tool results, email, file uploads) is
  **never given the same authority as the system/developer prompt** — the trust boundary is enforced
  architecturally, not by asking the model nicely. [Willison, Dual LLM pattern]
- Agentic systems separate a **privileged/orchestrator LLM** (holds tool access, tokens) from a
  **quarantined LLM** that only ever touches untrusted content and returns inert, structured data back
  across the boundary. [Willison, Dual LLM pattern]
- Every tool/function the model can invoke is **least-privilege scoped**: no open-ended shell/HTTP/file
  primitives, the app — not the model — holds API tokens, and functions are narrow (a "write file"
  extension, not a "run shell command" extension). [OWASP LLM06:2025 Excessive Agency]
- Downstream **authorization is enforced in code**, independent of what the LLM decides — "complete
  mediation," not delegated trust. [OWASP LLM06]
- All model output crossing a trust boundary (into `exec`/shell, SQL, HTML/JS render, a file path, an
  email template) is **validated and context-encoded for that specific sink** — the model is treated
  as any other untrusted user. [OWASP LLM05:2025 Improper Output Handling]
- High-impact or irreversible actions (delete, send, transfer, post) require **human-in-the-loop
  approval or a deterministic downstream gate**, never model self-restraint alone. [OWASP LLM06]
- System prompts contain **no secrets** — no API keys, connection strings, or role/permission logic.
  The system prompt is not a security control and is assumed extractable. [OWASP LLM07:2025 System
  Prompt Leakage]
- Sensitive data (PII, credentials, proprietary/business data) is sanitized before it enters training
  or context, and is access-controlled by least privilege on the way out. [OWASP LLM02:2025 Sensitive
  Information Disclosure]
- Adversarial testing (red-teaming with injection payloads, jailbreak attempts, payload-splitting)
  is routine, not a pre-launch checkbox — OWASP is explicit that there is **no fool-proof prevention**
  for prompt injection given how generative models work. [OWASP LLM01]
- Risk management is mapped across the full AI lifecycle (govern/map/measure/manage) with content
  provenance, pre-deployment testing, and incident-disclosure processes defined. [NIST AI 600-1]

## Common defects (what to attack)

- **Direct prompt injection** — attacker-controlled text in the user turn overrides system
  instructions ("ignore the above and…"). First publicly documented by Riley Goodside against GPT-3,
  written up by Simon Willison, Sept 2022 — the post that coined "prompt injection." [Willison 2022]
- **Indirect prompt injection** — malicious instructions embedded in content the model *reads* rather
  than what the user *types* (web pages, emails, PDFs, tool/RAG results); the model cannot reliably
  distinguish data from instructions. Formalized academically by Greshake et al. [OWASP LLM01;
  arXiv:2302.12173]
- **Jailbreaking, conflated with injection but distinct** — jailbreak = get the model to fully
  disregard its safety training; prompt injection = redirect behavior via crafted input, which may or
  may not touch safety guardrails at all. [OWASP LLM01]
- **System-prompt / instruction leakage** — attacker extracts the system prompt (direct ask, adversarial
  suffix, payload splitting), exposing embedded secrets or internal rules/limits that enable further
  attacks (e.g., a leaked "$5,000/day transaction limit" tells the attacker exactly what to bypass).
  [OWASP LLM07]
- **Improper/insecure output handling** — LLM output piped unsanitized into `exec`/shell, SQL, an
  HTML/JS render, a file path, or an email template → RCE, SQL injection, XSS, path traversal,
  phishing. [OWASP LLM05]
- **Tool/function-call abuse & excessive agency** — root causes are excessive *functionality* (tool
  exposes more than the task needs), excessive *permissions* (tool's downstream identity is
  over-privileged), and excessive *autonomy* (no human checkpoint before a high-impact action).
  Triggered either by hallucination or by injection. [OWASP LLM06]
- **Sensitive information disclosure** — PII, credentials, proprietary training data, or confidential
  business data leaked in output, often via a stated filter bypassed by prompt injection. [OWASP LLM02]
- **Data exfiltration via agent side-channels** — an agent with both sensitive-data access and
  unconstrained outbound network/API capability can be induced to smuggle data out (encode a secret
  into a URL, an image link, or a "helpful" POST to an attacker server). [Willison, Dual LLM pattern]
- **Supply-chain and data/model poisoning** — a compromised third-party model, plugin, or
  training/RAG corpus injects bad behavior upstream of runtime, before any prompt is ever sent.
  [OWASP LLM03 Supply Chain; LLM04 Data and Model Poisoning]
- **Unbounded consumption** — no rate limit or cost cap on model/tool invocation, enabling
  denial-of-wallet or DoS, frequently chained with the defects above to amplify impact. [OWASP LLM10]

## Quick-reference checklist

- [ ] Untrusted input (user, retrieved doc, tool output, email, upload) never carries the same
      authority as developer/system instructions
- [ ] RAG/tool results and other indirect content are segregated/marked as untrusted before reaching
      the model, not concatenated in as trusted context
- [ ] No secrets, connection strings, or permission/role logic live inside the system prompt
- [ ] Every tool/function the model can call is scoped to least privilege — no generic
      shell/HTTP/file-write primitives
- [ ] Downstream authorization is enforced in code; the LLM's own judgment is never the last gate
- [ ] High-impact actions (delete/send/pay/post) require human approval or a deterministic check
- [ ] All model output is validated/encoded for its actual sink (shell, SQL, HTML, file path, email)
      before use
- [ ] PII/credentials/proprietary data are sanitized or access-controlled before touching training or
      context
- [ ] An agent with sensitive-data access does not also have unconstrained outbound network/API reach
- [ ] Rate limits / cost caps exist on model and tool invocations
- [ ] Adversarial/injection red-team testing is a recurring part of the release process, not a one-off
- [ ] Logging/monitoring exists to catch anomalous tool-call patterns or leaked output after the fact

## Sources

- [OWASP Top 10 for LLM Applications v2.0 (2025)](https://genai.owasp.org/llm-top-10/) — the audit
  checklist; direct download of the full PDF at
  https://genai.owasp.org/download/43299/. LLM01 Prompt Injection, LLM02 Sensitive Information
  Disclosure, LLM05 Improper Output Handling, LLM06 Excessive Agency, and LLM07 System Prompt
  Leakage are the core entries behind this file.
- [Simon Willison — "Prompt injection attacks against GPT-3"](https://simonwillison.net/2022/Sep/12/prompt-injection/) —
  the originating writeup (Riley Goodside's Sept 2022 discovery); coins the term "prompt injection."
- [Simon Willison — "The Dual LLM pattern for building AI assistants that can resist prompt injection"](https://simonwillison.net/2023/Apr/25/dual-llm-pattern/) —
  privileged/quarantined-LLM split, data-exfiltration mechanics, the reference defense architecture.
- [NIST AI 600-1 — AI RMF Generative AI Profile](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf) (July 2024) —
  cross-sectoral govern/map/measure/manage profile; §2.9 Information Security independently confirms
  the direct/indirect prompt-injection split used by OWASP and Willison.
- [Greshake et al., "Not what you've signed up for: Compromising Real-World LLM-Integrated Applications with Indirect Prompt Injection"](https://arxiv.org/abs/2302.12173) (arXiv:2302.12173, 2023) —
  the academic paper that formalized indirect prompt injection against RAG/tool-using LLMs; cited
  directly by OWASP LLM01.
- [MITRE ATLAS](https://atlas.mitre.org/) — AML.T0051.000/.001 (LLM Prompt Injection: Direct/Indirect),
  AML.T0054 (LLM Jailbreak Injection) — adjacent adversarial-ML taxonomy cited throughout OWASP LLM01/LLM07.

**Notable conflicts / terminology reconciled:** OWASP's original 2023 draft used "Insecure Output
Handling"; the current 2025 v2.0 list renamed it "Improper Output Handling" (LLM05) — same defect
class, cite the current name. OWASP explicitly distinguishes **Excessive Agency** (LLM06 — insufficient
scrutiny of the capabilities/permissions the system was *granted*) from **Improper Output Handling**
(LLM05 — insufficient scrutiny of the *output itself*, regardless of what caused it) — don't conflate
the two in findings; a scenario can trip both. NIST's Generative AI Profile does not propose its own
prompt-injection taxonomy — it adopts the same direct/indirect split as OWASP and Willison, so treat
NIST as governance-layer corroboration (why this matters, what lifecycle stage to fix it at) rather
than a competing definition.
