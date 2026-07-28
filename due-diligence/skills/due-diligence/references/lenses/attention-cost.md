# attention-cost — Does every signal this system sends earn the interruption?
> Cites: res_attention-design.md

## Fires on
Tags: `external-send`, `cron`, `pipeline`, `rendered-ui`, `infra`, `llm-pipeline`. Any artifact that **sends something to a human** — notifications, emails, alerts, digests, badges, escalations, Slack/Discord posts, in-app toasts, status pings. Distinct from observability (signals *for operators* about system health, where completeness is the goal) and compliance-policy (is the send permitted): this lens asks whether each signal justifies the attention it consumes.

## The test
One question, asked of every signal the system can raise:

> **Does this require the recipient to do something?**

Not *might they like to know*. **A signal that needs no action is not a low-priority alert — it is a different kind of thing** and belongs on a quiet surface the user checks when ready, not in the interrupting channel. The discipline is not ranking alerts; it is refusing to let most things be alerts, and building the second destination for everything else.

The structural diagnostic behind most failures here: **who owns this channel, and do they want what the recipient wants?** Where sender and recipient interests diverge, fixes tend to arrive as settings the user must find — and settings do not work.

## Attacks

**A. No admission control**
- Signals that require no action delivered through the interrupting channel — completion notices nobody acts on, routine summaries, "something happened" engagement prompts.
- No quiet destination exists, so non-actionable output either interrupts or is discarded.
- Actionable and informational signals arrive in the same place, drawn the same way, so the recipient must triage what the system should have.

**B. No rationing**
- No rate limit: a loop, retry, fan-out or backlog can emit unbounded notifications; a burst arrives as N separate interruptions rather than one collapsed summary.
- No batching or digest option — the only control is off, and the evidence is that all-or-nothing is worse for the user than batching.
- Unread signals from a sender never reduce its future ability to interrupt.

**C. Priority inflation**
- Most signals marked high/urgent. When everything is urgent nothing is, and the recipient's calibration collapses.
- Severity assigned by the sender's interest rather than by required response.
- A genuine failure is indistinguishable from routine traffic — no escalation path that ordinary volume cannot occupy.

**D. Standing state**
- A badge, counter or queue that accumulates permanently and cannot realistically reach zero — presenting the backlog as a liability with a number on it.
- Signals that persist after the condition that produced them has cleared.

**E. Defaults and burden**
- The mitigating behaviour (batching, quiet hours, per-category control) exists but is off by default and buried, so it protects only the users who least needed it.
- Design relies on the recipient configuring their way out of a volume problem the sender created.
- Blaming the recipient: alert fatigue treated as user error rather than as evidence the channel lost credibility.

**F. Wrong method**
- Immediate interruption chosen by default where negotiated, mediated or scheduled delivery would fit — the choice never made explicitly.
- Central-attention delivery where peripheral or ambient would carry the information adequately.
- Timing ignored: no quiet hours, timezone awareness, or awareness of what the recipient is doing.

## Evidence of attack (clean-pass proof)
Enumerate the signals, don't characterise them: **list every signal type the system can emit and, for each, state the action it requires of the recipient** — and where it routes if the answer is "none". Name the quiet destination or state that none exists. Give the realistic worst-case volume (what happens on a retry storm, a backlog drain, a fan-out) and the rate limit that bounds it. State the default on/off position for each control and which behaviours require configuration. Quote the escalation path for a genuine failure and say how it differs from routine traffic. **"Users can turn it off" is a defect, not a mitigation.**

## Severity guide
- **blocker**: an unbounded or storm-capable signal path with no rate limit; a genuine failure that is silent or indistinguishable from routine traffic; a channel where actionable alerts are reliably buried by non-actionable ones.
- **should-fix**: no quiet destination for non-actionable signals; no batching or digest, only an off switch; priority inflation across most signal types; a permanently-accumulating counter; the helpful behaviour available but off by default; interruption method never deliberately chosen; no quiet-hours or timing awareness where the recipient is a person.
- **nit**: digest formatting or grouping could be tighter; a notification could be worded more actionably; timing window could be better tuned.
